import { mkdtemp, readdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connect, type DbHandle } from '@sevari/db';
import { MIGRATIONS_DIR } from '@sevari/db/admin';
import { LocalKeyFileKms, type Kms } from '@sevari/crypto';
import { runBootChecks, assertBoot, BootRefused, type BootDeps } from '@sevari/boot';
import { FixedClock } from '@sevari/clock';
import { contractSuite } from '../support/contract.ts';
import { isolatedDatabase } from '../support/db.ts';
import { fixtures } from '../support/fixtures.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

contractSuite('T-BOOT', () => {
  let iso: Awaited<ReturnType<typeof isolatedDatabase>>;
  let app: DbHandle;
  let f: ReturnType<typeof fixtures>;
  const kms = LocalKeyFileKms.fromKey(Buffer.alloc(32, 7));
  let deps: BootDeps;

  beforeAll(async () => {
    iso = await isolatedDatabase();
    f = fixtures(iso);
    app = connect(iso.appUrl);
    deps = { db: app.db, kms, region: 'uk', configDir: join(ROOT, 'config'), egressPolicyPath: join(ROOT, 'config', 'egress.allowlist.yaml'), clock: new FixedClock(Date.parse('2026-10-14T09:00:00Z')) };
  });
  afterAll(async () => {
    await app.close();
    await iso.drop();
  });

  const failing = async (d: BootDeps) => (await runBootChecks(d)).checks.filter((c) => !c.ok).map((c) => c.name);

  it('starts when every check passes', async () => {
    const report = await assertBoot(deps);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name).sort()).toEqual(
      ['db.migrations', 'db.role', 'db.rls', 'egress.policy', 'kms', 'region.config', 'lifecycles', 'registry.erasure', 'signoffs', 'slo'].sort());
  });

  it('refuses when RLS is switched off on any table', async () => {
    await f.superQuery('ALTER TABLE contacts NO FORCE ROW LEVEL SECURITY');
    try {
      expect(await failing(deps)).toEqual(['db.rls']);
      await expect(assertBoot(deps)).rejects.toBeInstanceOf(BootRefused);
    } finally {
      await f.superQuery('ALTER TABLE contacts FORCE ROW LEVEL SECURITY');
    }
  });

  it('refuses when it is running as a role that owns tables (the migration role)', async () => {
    const owner = connect(iso.ownerUrl);
    try {
      expect(await failing({ ...deps, db: owner.db })).toContain('db.role');
    } finally {
      await owner.close();
    }
  });

  it('refuses when it runs as a role with BYPASSRLS', async () => {
    // Roles are cluster-wide: never alter the shared sevari_app role in a test (it would switch off RLS
    // for every test running in parallel). Use a throwaway role instead.
    const role = `boot_bypass_${Math.random().toString(36).slice(2, 10)}`;
    await f.superQuery(`CREATE ROLE ${role} LOGIN PASSWORD 'bypass_test_only' BYPASSRLS NOSUPERUSER`);
    await f.superQuery(`GRANT CONNECT ON DATABASE ${iso.database} TO ${role}`);
    await f.superQuery(`GRANT USAGE ON SCHEMA public, sevari_meta TO ${role}`);
    await f.superQuery(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    const u = new URL(iso.appUrl);
    u.username = role;
    u.password = 'bypass_test_only';
    const bypass = connect(u.toString());
    try {
      expect(await failing({ ...deps, db: bypass.db })).toContain('db.role');
    } finally {
      await bypass.close();
      await f.superQuery(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
      await f.superQuery(`REVOKE ALL ON SCHEMA public, sevari_meta FROM ${role}`);
      await f.superQuery(`REVOKE ALL ON DATABASE ${iso.database} FROM ${role}`);
      await f.superQuery(`DROP ROLE ${role}`);
    }
  });

  it('refuses when migrations are pending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sevari-mig-'));
    for (const file of await readdir(MIGRATIONS_DIR)) await copyFile(join(MIGRATIONS_DIR, file), join(dir, file));
    const next = String((await readdir(MIGRATIONS_DIR)).filter((x) => x.endsWith('.up.sql')).length + 1).padStart(4, '0');
    await writeFile(join(dir, `${next}_pending.up.sql`), 'SELECT 1;');
    await writeFile(join(dir, `${next}_pending.down.sql`), 'SELECT 1;');
    expect(await failing({ ...deps, migrationsDir: dir })).toEqual(['db.migrations']);
  });

  it('refuses when an applied migration file was edited', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sevari-mig-'));
    for (const file of await readdir(MIGRATIONS_DIR)) await copyFile(join(MIGRATIONS_DIR, file), join(dir, file));
    await writeFile(join(dir, '0001_foundation.up.sql'), '-- edited\n', { flag: 'a' });
    expect(await failing({ ...deps, migrationsDir: dir })).toEqual(['db.migrations']);
  });

  it('refuses when the KMS is unreachable', async () => {
    const broken: Kms = { kekId: 'broken', wrap: async () => { throw new Error('KMS down'); }, unwrap: async () => { throw new Error('KMS down'); }, healthCheck: async () => { throw new Error('KMS down'); } };
    expect(await failing({ ...deps, kms: broken })).toEqual(['kms']);
  });

  it('refuses when the egress policy is missing or not default-deny', async () => {
    expect(await failing({ ...deps, egressPolicyPath: '/nonexistent/egress.yaml' })).toEqual(['egress.policy']);
    const dir = await mkdtemp(join(tmpdir(), 'sevari-egress-'));
    await writeFile(join(dir, 'e.yaml'), 'version: 1\ndefault: allow\ncells: { uk: { hosts: [] } }\n');
    expect(await failing({ ...deps, egressPolicyPath: join(dir, 'e.yaml') })).toEqual(['egress.policy']);
  });

  it('refuses when the region config is missing', async () => {
    expect(await failing({ ...deps, region: 'zz' })).toEqual(expect.arrayContaining(['region.config', 'egress.policy']));
  });

  it('refuses when a personal-data column is not in the erasure registry', async () => {
    await f.ownerQuery('ALTER TABLE contacts ADD COLUMN nickname text');
    await f.ownerQuery("COMMENT ON COLUMN contacts.nickname IS '@pii contact'");
    try {
      expect(await failing(deps)).toEqual(['registry.erasure']);
    } finally {
      await f.ownerQuery('ALTER TABLE contacts DROP COLUMN nickname');
    }
  });
});
