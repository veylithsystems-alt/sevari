/**
 * Worker loop over the queue port (ADR-0002). Claims as sevari_worker (queue rows only), runs each job
 * as sevari_app inside its tenant scope, completes or fails with backoff. A crash mid-job leaves the
 * lease to expire and the job re-runs; handlers are idempotent per (job, step) (§5.2, T-CHAOS).
 */
import type { Clock } from '@sevari/clock';
import { withTenant, type Db, type TenantTx, type WorkerQueue } from '@sevari/db';
import type { TenantScope } from '@sevari/domain';

/** A handler runs inside one tenant transaction, or (scoped) manages its own transactions, e.g. to call a provider between commits. */
export type JobHandler =
  | ((tx: TenantTx, payload: Record<string, unknown>) => Promise<unknown>)
  | { readonly scoped: (scope: TenantScope, payload: Record<string, unknown>) => Promise<unknown> };

export interface RunnerDeps {
  readonly queue: WorkerQueue;
  readonly db: Db;
  readonly clock: Clock;
  readonly workerId: string;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly leaseMs?: number;
  /** Jobs run concurrently up to this bound, so one slow provider can't hold up every ACK (F7). */
  readonly concurrency?: number;
  readonly onError?: (jobId: string, err: unknown) => void;
}

/** Exponential backoff with a cap: 5s, 15s, 45s ... 15 min. Deterministic (no jitter needed with SKIP LOCKED). */
export const backoffMs = (attempt: number) => Math.min(15 * 60_000, 5_000 * 3 ** Math.max(0, attempt - 1));

/** Runs until stopped: drains the queue, then sleeps until a NOTIFY or the poll interval. */
export function runForever(deps: RunnerDeps & { pollMs?: number }): { stop: () => Promise<void> } {
  let stopped = false;
  let wake: (() => void) | null = null;
  const unsubscribe = deps.queue.subscribe(() => wake?.());
  const loop = (async () => {
    while (!stopped) {
      const r = await runOnce(deps, 25).catch((err) => { deps.onError?.('loop', err); return { done: 0, failed: 0 }; });
      if (r.done + r.failed > 0) continue;
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, deps.pollMs ?? 2_000);
      });
      wake = null;
    }
  })();
  return { stop: async () => { stopped = true; wake?.(); await loop; await unsubscribe(); } };
}

export async function runOnce(deps: RunnerDeps, limit = 10): Promise<{ done: number; failed: number }> {
  await deps.queue.reapExpired();
  const jobs = await deps.queue.claim({ workerId: deps.workerId, limit, leaseMs: deps.leaseMs ?? 60_000, kinds: Object.keys(deps.handlers) });
  let done = 0;
  let failed = 0;
  const runJob = async (job: (typeof jobs)[number]) => {
    const handler = deps.handlers[job.kind];
    try {
      if (!handler) throw new Error(`no handler for ${job.kind}`);
      const scope = { tenantId: job.tenantId, region: job.region };
      if (typeof handler === 'function') await withTenant(deps.db, scope, (tx) => handler(tx, job.payload));
      else await handler.scoped(scope, job.payload);
      await deps.queue.complete(job.id, deps.workerId);
      done++;
    } catch (err) {
      deps.onError?.(job.id, err);
      await deps.queue.fail(job.id, deps.workerId, (err as Error).message ?? String(err), backoffMs(job.attempts));
      failed++;
    }
  };
  const width = Math.max(1, deps.concurrency ?? 8);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if (job) await runJob(job);
    }
  }));
  return { done, failed };
}
