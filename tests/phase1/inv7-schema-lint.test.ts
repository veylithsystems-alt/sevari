import { afterAll, beforeAll, expect, it } from 'vitest';
import { connect, lintSchema, piiColumns, tableSecurity, type DbHandle } from '@sevari/db';
import { registryGaps } from '@sevari/privacy';
import { describe } from 'vitest';
import { dbInfo } from '../support/db.ts';

describe('[INV-7] every tenant-scoped table has tenant_id, region, RLS forced (schema lint) — with F1', () => {
  let h: DbHandle;
  beforeAll(() => {
    h = connect(dbInfo().ownerUrl);
  });
  afterAll(async () => h.close());

  it('has no schema-lint violations', async () => {
    expect(lintSchema(await tableSecurity(h.db))).toEqual([]);
  });

  it('flags a table missing tenancy columns or RLS', () => {
    const problems = lintSchema([{ table: 'naughty', rlsEnabled: false, rlsForced: false, policyCount: 0, owner: 'sevari_app', columns: [] }]);
    expect(problems).toEqual(expect.arrayContaining([
      'naughty: RLS not enabled', 'naughty: RLS not forced', 'naughty: no RLS policy', 'naughty: owned by the app role',
      'naughty: missing NOT NULL tenant_id (INV-7)', 'naughty: missing NOT NULL region region_code (INV-7)',
    ]));
  });

  it('[INV-6] every @pii column is in the erasure registry', async () => {
    const tables = await tableSecurity(h.db);
    expect(registryGaps(piiColumns(tables), tables.map((t) => t.table))).toEqual([]);
  });
});
