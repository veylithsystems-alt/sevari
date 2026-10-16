import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql, withTenant, type DbHandle } from '@sevari/db';
import { tenantId, type TenantScope } from '@sevari/domain';
import { contractSuite } from '../support/contract.ts';
import { appDb, newTenant, PROVENANCE } from '../support/fixtures.ts';
import { dbInfo } from '../support/db.ts';
import pg from 'pg';

contractSuite('F1', () => {
  let h: DbHandle;
  let a: TenantScope;
  let b: TenantScope;
  let contactA: string;

  beforeAll(async () => {
    h = appDb();
    a = await newTenant(h, 'uk', 'Alpha Drains');
    b = await newTenant(h, 'uk', 'Beta Roofing');
    contactA = await withTenant(h.db, a, async (tx) => {
      const r = await tx.insertInto('contacts').values({ tenant_id: a.tenantId, region: a.region, email_bidx: Buffer.from('a1'), ...PROVENANCE })
        .returning('id').executeTakeFirstOrThrow();
      return r.id;
    });
  });
  afterAll(async () => h.close());

  it('tenant B cannot read tenant A rows', async () => {
    const seen = await withTenant(h.db, b, (tx) => tx.selectFrom('contacts').select('id').execute());
    expect(seen.map((r) => r.id)).not.toContain(contactA);
    const tenants = await withTenant(h.db, b, (tx) => tx.selectFrom('tenants').select('id').execute());
    expect(tenants.map((t) => t.id)).toEqual([b.tenantId]);
  });

  it('tenant B cannot update or delete tenant A rows (0 rows affected)', async () => {
    const upd = await withTenant(h.db, b, (tx) => tx.updateTable('contacts').set({ captured_by: 'evil' }).where('id', '=', contactA).executeTakeFirst());
    expect(Number(upd.numUpdatedRows)).toBe(0);
    const del = await withTenant(h.db, b, (tx) => tx.deleteFrom('contacts').where('id', '=', contactA).executeTakeFirst());
    expect(Number(del.numDeletedRows)).toBe(0);
    const still = await withTenant(h.db, a, (tx) => tx.selectFrom('contacts').select('captured_by').where('id', '=', contactA).executeTakeFirst());
    expect(still?.captured_by).toBe(PROVENANCE.captured_by);
  });

  it('tenant B cannot write rows labelled as tenant A', async () => {
    await expect(withTenant(h.db, b, (tx) =>
      tx.insertInto('contacts').values({ tenant_id: a.tenantId, region: a.region, ...PROVENANCE }).execute(),
    )).rejects.toThrow(/row-level security/);
  });

  it('a child row cannot reference another tenant\'s parent (composite foreign key)', async () => {
    await expect(withTenant(h.db, b, (tx) =>
      tx.insertInto('conversations').values({ tenant_id: b.tenantId, region: b.region, contact_id: contactA }).execute(),
    )).rejects.toThrow(/foreign key/);
  });

  it('with no tenant context the app role sees nothing and writes nothing', async () => {
    const pool = new pg.Pool({ connectionString: dbInfo().appUrl, max: 1 });
    try {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM contacts');
      expect(rows[0].n).toBe(0);
      await expect(pool.query("INSERT INTO contacts (tenant_id, region, source, lawful_basis, captured_at, captured_by) VALUES ($1, 'uk', 'x', 'x', now(), 'x')", [a.tenantId]))
        .rejects.toThrow(/row-level security/);
    } finally {
      await pool.end();
    }
  });

  it('a raw SQL attempt to switch tenant mid-transaction cannot see the other tenant once context is bound', async () => {
    // Even when application code sets a different context, it only ever sees the context it set: there is
    // no way to see two tenants at once, and the context dies with the transaction (no pool leakage).
    await withTenant(h.db, a, async (tx) => {
      await sql`SELECT set_config('app.tenant_id', ${b.tenantId}, true)`.execute(tx);
      const rows = await tx.selectFrom('contacts').select('id').execute();
      expect(rows.map((r) => r.id)).not.toContain(contactA);
    });
    const after = await h.db.selectFrom('contacts').select('id').execute();
    expect(after).toEqual([]);
  });

  it('the pool never leaks tenant context between transactions', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => {
      const s = i % 2 === 0 ? a : b;
      return withTenant(h.db, s, async (tx) => {
        const rows = await tx.selectFrom('tenants').select(['id', 'region']).execute();
        return { ok: rows.every((r) => r.id === s.tenantId) && rows.length === 1, expected: s.tenantId, rows };
      });
    }));
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  it('a malformed tenant id is refused before reaching the database', () => {
    expect(() => tenantId("x' OR 1=1 --")).toThrow();
  });

  // F1 via the API surface: tests/phase2/t-idem-intake.test.ts
});
