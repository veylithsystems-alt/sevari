/**
 * Worker loop over the queue port (ADR-0002). Claims as sevari_worker (queue rows only), runs each job
 * as sevari_app inside its tenant scope, completes or fails with backoff. A crash mid-job leaves the
 * lease to expire and the job re-runs; handlers are idempotent per (job, step) (§5.2, T-CHAOS).
 */
import type { Clock } from '@sevari/clock';
import { withTenant, type Db, type TenantTx, type WorkerQueue } from '@sevari/db';

export type JobHandler = (tx: TenantTx, payload: Record<string, unknown>) => Promise<unknown>;

export interface RunnerDeps {
  readonly queue: WorkerQueue;
  readonly db: Db;
  readonly clock: Clock;
  readonly workerId: string;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly leaseMs?: number;
  readonly onError?: (jobId: string, err: unknown) => void;
}

/** Exponential backoff with a cap: 5s, 15s, 45s ... 15 min. Deterministic (no jitter needed with SKIP LOCKED). */
export const backoffMs = (attempt: number) => Math.min(15 * 60_000, 5_000 * 3 ** Math.max(0, attempt - 1));

export async function runOnce(deps: RunnerDeps, limit = 10): Promise<{ done: number; failed: number }> {
  await deps.queue.reapExpired();
  const jobs = await deps.queue.claim({ workerId: deps.workerId, limit, leaseMs: deps.leaseMs ?? 60_000, kinds: Object.keys(deps.handlers) });
  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    const handler = deps.handlers[job.kind];
    try {
      if (!handler) throw new Error(`no handler for ${job.kind}`);
      await withTenant(deps.db, { tenantId: job.tenantId, region: job.region }, (tx) => handler(tx, job.payload));
      await deps.queue.complete(job.id, deps.workerId);
      done++;
    } catch (err) {
      deps.onError?.(job.id, err);
      await deps.queue.fail(job.id, deps.workerId, (err as Error).message ?? String(err), backoffMs(job.attempts));
      failed++;
    }
  }
  return { done, failed };
}
