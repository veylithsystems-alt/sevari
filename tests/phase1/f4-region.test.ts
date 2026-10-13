import { afterAll, beforeAll, expect, it } from 'vitest';
import { withTenant, type DbHandle } from '@sevari/db';
import { regionCode, type TenantScope } from '@sevari/domain';
import { contractSuite } from '../support/contract.ts';
import { appDb, ensureRegion, newTenant, ownerQuery, PROVENANCE } from '../support/fixtures.ts';

contractSuite('F4', () => {
  let h: DbHandle;
  let t: TenantScope;
  beforeAll(async () => {
    h = appDb();
    await ensureRegion('ie1', 'Ireland (EU)');
    t = await newTenant(h, 'uk');
  });
  afterAll(async () => h.close());

  it('refuses a null region', async () => {
    await expect(withTenant(h.db, t, (tx) =>
      // @ts-expect-error region is required by the type too
      tx.insertInto('contacts').values({ tenant_id: t.tenantId, region: null, ...PROVENANCE }).execute(),
    )).rejects.toThrow(/null value in column "region"|row-level security/);
  });

  it('refuses a session with no region set', async () => {
    await expect(withTenant(h.db, { tenantId: t.tenantId, region: '' as never }, async () => undefined)).rejects.toThrow();
  });

  it('refuses a cross-region write without a transfer contract', async () => {
    await expect(withTenant(h.db, t, (tx) =>
      tx.insertInto('contacts').values({ tenant_id: t.tenantId, region: 'ie1', ...PROVENANCE }).execute(),
    )).rejects.toThrow(/row-level security/);
  });

  it('does not show rows of another region even for the same tenant', async () => {
    const ie: TenantScope = { tenantId: t.tenantId, region: regionCode('ie1') };
    const rows = await withTenant(h.db, ie, (tx) => tx.selectFrom('tenants').select('id').execute());
    expect(rows).toEqual([]);
  });

  it('permits the cross-region write only for the tables an active, human-recorded contract names', async () => {
    await ownerQuery(
      `INSERT INTO region_transfer_contracts (tenant_id, region, to_region, tables, purpose, legal_basis, approved_by, effective_from)
       VALUES ($1, 'uk', 'ie1', ARRAY['messages'], 'SMS delivery via IE1', 'counsel ref TBC', 'Dan Hadfield', now() - interval '1 minute')`,
      [t.tenantId],
    );
    // Contract names messages, not contacts: still refused.
    await expect(withTenant(h.db, t, (tx) =>
      tx.insertInto('contacts').values({ tenant_id: t.tenantId, region: 'ie1', ...PROVENANCE }).execute(),
    )).rejects.toThrow(/row-level security/);
  });

  it('an expired transfer contract no longer permits the write', async () => {
    await ownerQuery(
      `INSERT INTO region_transfer_contracts (tenant_id, region, to_region, tables, purpose, legal_basis, approved_by, effective_from, effective_to)
       VALUES ($1, 'uk', 'ie1', ARRAY['contacts'], 'expired test', 'n/a', 'Dan Hadfield', now() - interval '2 days', now() - interval '1 day')`,
      [t.tenantId],
    );
    await expect(withTenant(h.db, t, (tx) =>
      tx.insertInto('contacts').values({ tenant_id: t.tenantId, region: 'ie1', ...PROVENANCE }).execute(),
    )).rejects.toThrow(/row-level security/);
  });

  it('an active contract naming the table permits it (and only then)', async () => {
    await ownerQuery(
      `INSERT INTO region_transfer_contracts (tenant_id, region, to_region, tables, purpose, legal_basis, approved_by, effective_from)
       VALUES ($1, 'uk', 'ie1', ARRAY['contacts'], 'test transfer', 'n/a', 'Dan Hadfield', now() - interval '1 minute')`,
      [t.tenantId],
    );
    await expect(withTenant(h.db, t, (tx) =>
      tx.insertInto('contacts').values({ tenant_id: t.tenantId, region: 'ie1', ...PROVENANCE }).execute(),
    )).resolves.toBeDefined();
  });

  it('the application role cannot create a transfer contract itself', async () => {
    await expect(withTenant(h.db, t, (tx) =>
      // @ts-expect-error not in the app schema type on purpose
      tx.insertInto('region_transfer_contracts').values({ tenant_id: t.tenantId }).execute(),
    )).rejects.toThrow(/permission denied/);
  });
});
