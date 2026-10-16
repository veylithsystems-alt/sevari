/**
 * Privileged database operations: cluster bootstrap (superuser) and migrations (owner role).
 * Never imported by request-handling code; the API and worker run as sevari_app only.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', 'migrations');
const BOOTSTRAP_SQL = join(here, '..', 'sql', 'bootstrap.sql');

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
  readonly down: string;
  readonly checksum: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.up.sql')).sort();
  const out: Migration[] = [];
  for (const file of files) {
    const m = /^(\d{4})_([a-z0-9_]+)\.up\.sql$/.exec(file);
    if (!m) throw new Error(`Bad migration filename: ${file}`);
    const up = await readFile(join(dir, file), 'utf8');
    const down = await readFile(join(dir, file.replace('.up.sql', '.down.sql')), 'utf8');
    out.push({ version: Number(m[1]), name: m[2] ?? '', up, down, checksum: createHash('sha256').update(up).digest('hex') });
  }
  out.forEach((mig, i) => {
    if (mig.version !== i + 1) throw new Error(`Migration versions must be contiguous from 1; found ${mig.version} at position ${i + 1}`);
  });
  return out;
}

const quoteIdent = (s: string): string => `"${s.replaceAll('"', '""')}"`;
const quoteLiteral = (s: string): string => `'${s.replaceAll("'", "''")}'`;

export interface BootstrapOptions {
  readonly superUrl: string;
  readonly database: string;
  readonly ownerPassword: string;
  readonly appPassword: string;
  readonly workerPassword: string;
}

/**
 * Creates the owner and app roles and hands the schema to the owner. Idempotent. Roles are cluster-wide
 * (and advisory locks are per database), so two databases bootstrapped at the same moment can collide
 * on the same role row ("tuple concurrently updated"); that one error is retried.
 */
export async function bootstrapCluster(opts: BootstrapOptions): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await bootstrapOnce(opts);
    } catch (err) {
      if (attempt >= 8 || !/tuple concurrently (updated|deleted)/.test((err as Error).message)) throw err;
      await new Promise((r) => setTimeout(r, 25 * attempt));
    }
  }
}

async function bootstrapOnce(opts: BootstrapOptions): Promise<void> {
  const client = new pg.Client({ connectionString: opts.superUrl });
  await client.connect();
  try {
    await client.query(await readFile(BOOTSTRAP_SQL, 'utf8'));
    await client.query(`ALTER ROLE sevari_owner PASSWORD ${quoteLiteral(opts.ownerPassword)}`);
    await client.query(`ALTER ROLE sevari_app PASSWORD ${quoteLiteral(opts.appPassword)}`);
    await client.query(`ALTER ROLE sevari_worker PASSWORD ${quoteLiteral(opts.workerPassword)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${quoteIdent(opts.database)} TO sevari_worker`);
    await client.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${quoteIdent(opts.database)} TO sevari_app`);
    await client.query(`GRANT CONNECT, CREATE ON DATABASE ${quoteIdent(opts.database)} TO sevari_owner`);
  } finally {
    await client.end();
  }
}

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version    integer PRIMARY KEY,
    name       text NOT NULL,
    checksum   text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    version_no integer NOT NULL DEFAULT 1
  )`;

/** Applies pending migrations as the owner role, each in its own transaction. Refuses edited migrations. */
export async function runMigrations(opts: { ownerUrl: string; target?: number; dir?: string }): Promise<number[]> {
  const migrations = await loadMigrations(opts.dir);
  const client = new pg.Client({ connectionString: opts.ownerUrl });
  await client.connect();
  const applied: number[] = [];
  try {
    await client.query(LEDGER_DDL);
    await client.query('GRANT SELECT ON public.schema_migrations TO sevari_app');
    await client.query('ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY');
    await client.query('ALTER TABLE public.schema_migrations FORCE ROW LEVEL SECURITY');
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'schema_migrations' AND policyname = 'ledger_read') THEN
        CREATE POLICY ledger_read ON public.schema_migrations FOR SELECT TO sevari_app USING (true);
        CREATE POLICY ledger_owner ON public.schema_migrations FOR ALL TO sevari_owner USING (true) WITH CHECK (true);
      END IF; END $$`);
    const { rows } = await client.query<{ version: number; checksum: string }>('SELECT version, checksum FROM public.schema_migrations');
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const m of migrations) {
      if (opts.target !== undefined && m.version > opts.target) break;
      const prior = done.get(m.version);
      if (prior) {
        if (prior !== m.checksum) throw new Error(`Migration ${m.version}_${m.name} was edited after it was applied (checksum mismatch)`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.up);
        await client.query('INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum]);
        await client.query('COMMIT');
        applied.push(m.version);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.version}_${m.name} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

/** Rolls back to `target` (exclusive of higher versions). Development and T-MIG only. */
export async function rollbackMigrations(opts: { ownerUrl: string; target: number; dir?: string }): Promise<number[]> {
  const migrations = await loadMigrations(opts.dir);
  const client = new pg.Client({ connectionString: opts.ownerUrl });
  await client.connect();
  const rolled: number[] = [];
  try {
    const { rows } = await client.query<{ version: number }>('SELECT version FROM public.schema_migrations ORDER BY version DESC');
    for (const { version } of rows) {
      if (version <= opts.target) break;
      const m = migrations.find((x) => x.version === version);
      if (!m) throw new Error(`No migration file for applied version ${version}`);
      await client.query('BEGIN');
      try {
        await client.query(m.down);
        await client.query('DELETE FROM public.schema_migrations WHERE version = $1', [version]);
        await client.query('COMMIT');
        rolled.push(version);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
  return rolled;
}
