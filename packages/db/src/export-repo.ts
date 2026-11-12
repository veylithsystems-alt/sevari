import { sql } from 'kysely';
import type { TenantTx } from './session.ts';

/**
 * Reads named columns from a tenant table for a data export (§21.1, F20). Table and column names come only
 * from the registry's export list (never from input); row-level security limits rows to this tenant.
 */
export async function selectColumns(tx: TenantTx, table: string, columns: readonly string[]): Promise<Record<string, unknown>[]> {
  if (!/^[a-z_]+$/.test(table) || columns.some((c) => !/^[a-z_]+$/.test(c))) throw new Error('invalid export table or column name');
  const r = await sql<Record<string, unknown>>`SELECT ${sql.join(columns.map((c) => sql.ref(c)))} FROM ${sql.table(table)}`.execute(tx);
  return r.rows;
}
