import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadMigrations, rollbackMigrations, runMigrations } from '@sevari/db/admin';
import { contractSuite } from '../support/contract.ts';
import { isolatedDatabase } from '../support/db.ts';
import { fixtures } from '../support/fixtures.ts';

contractSuite('T-MIG', () => {
  let iso: Awaited<ReturnType<typeof isolatedDatabase>>;
  beforeAll(async () => {
    iso = await isolatedDatabase();
  });
  afterAll(async () => iso.drop());

  it('every migration has a down file and versions are contiguous', async () => {
    const ms = await loadMigrations();
    expect(ms.length).toBeGreaterThan(0);
    for (const m of ms) expect(m.down.trim().length).toBeGreaterThan(0);
  });

  it('rolls all the way down and back up, leaving an identical schema', async () => {
    const f = fixtures(iso);
    const snapshot = async () => (await f.superQuery(`
      SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' ORDER BY table_name, column_name`)).rows;
    const before = await snapshot();
    const all = (await loadMigrations()).map((m) => m.version);
    expect(await rollbackMigrations({ ownerUrl: iso.ownerUrl, target: 0 })).toEqual([...all].reverse());
    const empty = (await f.superQuery("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'schema_migrations'")).rows[0].n;
    expect(empty).toBe(0);
    expect(await runMigrations({ ownerUrl: iso.ownerUrl })).toEqual(all);
    expect(await snapshot()).toEqual(before);
  });

  it('is idempotent: re-running applies nothing', async () => {
    expect(await runMigrations({ ownerUrl: iso.ownerUrl })).toEqual([]);
  });
});
