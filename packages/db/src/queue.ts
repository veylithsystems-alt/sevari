/**
 * Postgres job queue: the v1 implementation behind the workflow port (ADR-0002, DEV-007).
 * - enqueue() runs inside the tenant transaction that created the work (outbox pattern, §5.2), and is
 *   idempotent on (tenant, kind, dedupe_key).
 * - claim() runs as sevari_worker, which sees queue rows for its cell only, never any tenant data.
 *   Leases expire, so a crashed worker's job is picked up again (T-CHAOS).
 * - The job body itself must run inside withTenant() as sevari_app, keyed (job id, step) for idempotency.
 */
import { sql, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { RegionCode, TenantId } from '@sevari/domain';
import type { Database } from './schema.ts';
import type { TenantTx } from './session.ts';

export interface JobSpec {
  readonly kind: string;
  readonly dedupeKey: string;
  /** Ids and codes only. Never personal data. */
  readonly payload?: Readonly<Record<string, string | number | boolean | null>>;
  readonly runAt?: Date;
  readonly maxAttempts?: number;
}

export async function enqueue(tx: TenantTx, job: JobSpec): Promise<{ id: string; created: boolean }> {
  const inserted = await tx.insertInto('job_queue').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, kind: job.kind, dedupe_key: job.dedupeKey,
    payload: JSON.stringify(job.payload ?? {}), ...(job.runAt ? { run_at: job.runAt } : {}),
    ...(job.maxAttempts ? { max_attempts: job.maxAttempts } : {}),
  }).onConflict((oc) => oc.columns(['tenant_id', 'kind', 'dedupe_key']).doNothing()).returning('id').executeTakeFirst();
  if (inserted) return { id: inserted.id, created: true };
  const existing = await tx.selectFrom('job_queue').select('id')
    .where('kind', '=', job.kind).where('dedupe_key', '=', job.dedupeKey).executeTakeFirstOrThrow();
  return { id: existing.id, created: false };
}

export interface ClaimedJob {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly region: RegionCode;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface WorkerQueue {
  claim(opts: { workerId: string; limit: number; leaseMs: number; kinds?: readonly string[] }): Promise<ClaimedJob[]>;
  complete(jobId: string, workerId: string): Promise<boolean>;
  fail(jobId: string, workerId: string, error: string, retryInMs: number): Promise<'retry' | 'dead' | 'lost'>;
  /** Returns expired leases to the queue (crashed workers). */
  reapExpired(): Promise<number>;
  /** Calls `onQueued` whenever any job is queued in this database (LISTEN sevari_jobs). */
  subscribe(onQueued: () => void): () => Promise<void>;
  close(): Promise<void>;
}

/** Queue access as sevari_worker, bound to one cell. */
export function workerQueue(workerUrl: string, region: RegionCode): WorkerQueue {
  const pool = new pg.Pool({ connectionString: workerUrl, max: 4 });
  pool.on('error', () => undefined);
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  const inCell = <T>(fn: (trx: Kysely<Database>) => Promise<T>) => db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.region', ${region}, true)`.execute(trx);
    return fn(trx);
  });
  return {
    claim: ({ workerId, limit, leaseMs, kinds }) => inCell(async (trx) => {
      const kindFilter = kinds && kinds.length ? sql`AND kind = ANY(${sql.val(kinds)})` : sql``;
      const { rows } = await sql<{ id: string; tenant_id: string; region: string; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number }>`
        UPDATE job_queue j SET state = 'running', locked_by = ${workerId},
               locked_until = clock_timestamp() + make_interval(secs => ${leaseMs / 1000}), attempts = j.attempts + 1
         WHERE j.id IN (
           SELECT id FROM job_queue
            WHERE state = 'queued' AND run_at <= clock_timestamp() ${kindFilter}
            ORDER BY run_at
            FOR UPDATE SKIP LOCKED
            LIMIT ${limit})
        RETURNING j.id, j.tenant_id, j.region, j.kind, j.payload, j.attempts, j.max_attempts`.execute(trx);
      return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id as TenantId, region: r.region as RegionCode, kind: r.kind, payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts }));
    }),
    complete: (jobId, workerId) => inCell(async (trx) => {
      const r = await trx.updateTable('job_queue').set({ state: 'done', locked_by: null, locked_until: null })
        .where('id', '=', jobId).where('locked_by', '=', workerId).where('state', '=', 'running').executeTakeFirst();
      return Number(r.numUpdatedRows) === 1;
    }),
    fail: (jobId, workerId, error, retryInMs) => inCell(async (trx) => {
      const { rows } = await sql<{ state: string }>`
        UPDATE job_queue SET
          state = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
          run_at = clock_timestamp() + make_interval(secs => ${retryInMs / 1000}),
          last_error = left(${error}, 500), locked_by = NULL, locked_until = NULL
         WHERE id = ${jobId} AND locked_by = ${workerId} AND state = 'running'
        RETURNING state`.execute(trx);
      const s = rows[0]?.state;
      return s === 'dead' ? 'dead' : s === 'queued' ? 'retry' : 'lost';
    }),
    reapExpired: () => inCell(async (trx) => {
      const r = await trx.updateTable('job_queue').set({ state: 'queued', locked_by: null, locked_until: null })
        .where('state', '=', 'running').where('locked_until', '<', sql<Date>`clock_timestamp()`).executeTakeFirst();
      return Number(r.numUpdatedRows);
    }),
    subscribe: (onQueued) => {
      const client = new pg.Client({ connectionString: workerUrl });
      client.on('error', () => undefined);
      client.on('notification', () => onQueued());
      const ready = client.connect().then(() => client.query('LISTEN sevari_jobs'));
      return async () => {
        await ready.catch(() => undefined);
        await client.end().catch(() => undefined);
      };
    },
    close: () => db.destroy(),
  };
}
