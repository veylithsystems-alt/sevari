import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { TenantIdSchema, RegionCodeSchema, type TenantScope } from '@sevari/domain';
import type { Database } from './schema.ts';

export type Db = Kysely<Database>;
export type TenantTx = Transaction<Database> & { readonly scope: TenantScope };

export interface DbHandle {
  readonly db: Db;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

/** Connects as the application role. All tenant data access goes through withTenant(). */
export function connect(appUrl: string, opts: { max?: number; onIdleError?: (err: Error) => void } = {}): DbHandle {
  const pool = new pg.Pool({ connectionString: appUrl, max: opts.max ?? 10 });
  // An idle client can be terminated by the server (restart, failover). pg emits that on the pool;
  // without a listener it would crash the process. The next checkout reconnects.
  pool.on('error', (err) => opts.onIdleError?.(err));
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool, close: () => db.destroy() };
}

/**
 * Runs `fn` in a transaction bound to one tenant and one region. The settings are LOCAL to the
 * transaction, so a pooled connection can never leak one tenant's context into another request.
 * RLS (FORCE'd, NOBYPASSRLS role) does the enforcement; this only sets the context.
 */
export async function withTenant<T>(db: Db, scope: TenantScope, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  const tenantId = TenantIdSchema.parse(scope.tenantId);
  const region = RegionCodeSchema.parse(scope.region);
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.region', ${region}, true)`.execute(trx);
    const scoped = Object.assign(trx, { scope: { tenantId, region } }) as TenantTx;
    return fn(scoped);
  });
}

/** Verifies the session's audit chain (INV-8). Returns null when intact. */
export async function verifyAuditChain(tx: TenantTx, fromSeq = 1): Promise<{ brokenSeq: number; reason: string } | null> {
  const { rows } = await sql<{ broken_seq: string; reason: string }>`SELECT broken_seq, reason FROM sevari_meta.audit_verify(${fromSeq})`.execute(tx);
  const r = rows[0];
  return r ? { brokenSeq: Number(r.broken_seq), reason: r.reason } : null;
}

export { sql };
