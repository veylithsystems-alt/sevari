import { sql } from 'kysely';
import type { Db } from './session.ts';
import { loadMigrations } from './admin.ts';

/** Tables that are cell-global by design and therefore carry no tenant_id. Each needs a reason. */
export const GLOBAL_TABLES: Readonly<Record<string, string>> = {
  regions: 'cell configuration, no personal data',
  schema_migrations: 'migration ledger, no personal data',
  model_registry: 'cell model registry (§9), no personal data',
  purpose_rules: 'purpose limitation per source tier (§17.2), no personal data',
  plans: 'versioned plans and prices (§47), no personal data',
  platform_decisions: 'platform-scope decisions (§82); references and reason codes only',
  operators: 'platform operator credentials (§82 platform scope); cell-global, not tenant data',
};

export interface TableSecurity {
  readonly table: string;
  readonly rlsEnabled: boolean;
  readonly rlsForced: boolean;
  readonly policyCount: number;
  readonly owner: string;
  readonly columns: ReadonlyArray<{ name: string; type: string; notNull: boolean; comment: string | null }>;
}

export async function tableSecurity(db: Db): Promise<TableSecurity[]> {
  const { rows } = await sql<{
    table: string; rls_enabled: boolean; rls_forced: boolean; policy_count: number; owner: string;
    columns: Array<{ name: string; type: string; not_null: boolean; comment: string | null }>;
  }>`
    SELECT c.relname AS table, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count,
           pg_get_userbyid(c.relowner) AS owner,
           (SELECT json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
                     'not_null', a.attnotnull, 'comment', col_description(c.oid, a.attnum)) ORDER BY a.attnum)
              FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     ORDER BY c.relname`.execute(db);
  return rows.map((r) => ({
    table: r.table, rlsEnabled: r.rls_enabled, rlsForced: r.rls_forced, policyCount: r.policy_count, owner: r.owner,
    columns: r.columns.map((c) => ({ name: c.name, type: c.type, notNull: c.not_null, comment: c.comment })),
  }));
}

/** INV-7 schema lint: returns a list of violations (empty = pass). */
export function lintSchema(tables: readonly TableSecurity[]): string[] {
  const problems: string[] = [];
  for (const t of tables) {
    const col = (n: string) => t.columns.find((c) => c.name === n);
    if (!t.rlsEnabled) problems.push(`${t.table}: RLS not enabled`);
    if (!t.rlsForced) problems.push(`${t.table}: RLS not forced`);
    if (t.policyCount === 0) problems.push(`${t.table}: no RLS policy`);
    if (t.owner === 'sevari_app' || t.owner === 'sevari_worker') problems.push(`${t.table}: owned by a runtime role`);
    const versionCol = t.table === 'schema_migrations' ? 'version_no' : 'version';
    for (const required of ['created_at', 'updated_at', versionCol]) {
      if (!col(required)?.notNull) problems.push(`${t.table}: missing NOT NULL ${required}`);
    }
    if (t.table in GLOBAL_TABLES) continue;
    const id = col('id');
    if (!id || id.type !== 'uuid') problems.push(`${t.table}: id must be uuid`);
    if (!col('tenant_id')?.notNull) problems.push(`${t.table}: missing NOT NULL tenant_id (INV-7)`);
    const region = col('region');
    if (!region?.notNull || region.type !== 'region_code') problems.push(`${t.table}: missing NOT NULL region region_code (INV-7)`);
  }
  return problems;
}

export interface RoleFacts {
  readonly user: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  readonly ownsTables: number;
}

export async function currentRoleFacts(db: Db): Promise<RoleFacts> {
  const { rows } = await sql<{ user: string; superuser: boolean; bypass: boolean; owns: number }>`
    SELECT current_user AS user, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
           (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relowner = r.oid) AS owns
      FROM pg_roles r WHERE r.rolname = current_user`.execute(db);
  const r = rows[0];
  if (!r) throw new Error('current role not found in pg_roles');
  return { user: r.user, superuser: r.superuser, bypassRls: r.bypass, ownsTables: r.owns };
}

export interface MigrationState {
  readonly current: boolean;
  readonly pending: number[];
  readonly tampered: number[];
  readonly unknown: number[];
}

export async function migrationState(db: Db, dir?: string): Promise<MigrationState> {
  const files = await loadMigrations(dir);
  const { rows } = await sql<{ version: number; checksum: string }>`SELECT version, checksum FROM public.schema_migrations`.execute(db);
  const applied = new Map(rows.map((r) => [r.version, r.checksum]));
  const pending = files.filter((f) => !applied.has(f.version)).map((f) => f.version);
  const tampered = files.filter((f) => applied.has(f.version) && applied.get(f.version) !== f.checksum).map((f) => f.version);
  const unknown = [...applied.keys()].filter((v) => !files.some((f) => f.version === v));
  return { current: pending.length === 0 && tampered.length === 0 && unknown.length === 0, pending, tampered, unknown };
}

/** Columns tagged '@pii' in migration comments. The erasure registry must cover every one (INV-6). */
export function piiColumns(tables: readonly TableSecurity[]): Array<{ table: string; column: string; comment: string }> {
  return tables.flatMap((t) =>
    t.columns.filter((c) => c.comment?.startsWith('@pii')).map((c) => ({ table: t.table, column: c.name, comment: c.comment ?? '' })),
  );
}

/** Views that would run with their owner's rights (bypassing the caller's row-level security). Must be empty. */
export async function insecureViews(db: Db): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'v'
       AND NOT coalesce(c.reloptions @> ARRAY['security_invoker=true'], false)
     ORDER BY 1`.execute(db);
  return rows.map((r) => r.name);
}
