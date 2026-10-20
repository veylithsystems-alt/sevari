import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '@sevari/clock';
import { KekRing, TenantKeyring } from '@sevari/crypto';
import { connect, withTenant, type DbHandle } from '@sevari/db';
import type { TenantScope } from '@sevari/domain';
import { eraseSubject, FileShredRegister, keyCompromiseDrill, reapplyShredRegister } from '@sevari/privacy';
import { contractSuite } from '../support/contract.ts';
import { isolatedDatabase } from '../support/db.ts';
import { appDb, fixtures, newTenant } from '../support/fixtures.ts';

const clock = new FixedClock(Date.parse('2026-10-14T09:00:00Z'));
const KEK_A = Buffer.alloc(32, 0xa1);
const KEK_B = Buffer.alloc(32, 0xb2);
const KEK_C = Buffer.alloc(32, 0xc3);

/** A tenant with one business-key secret and one person-key secret, sealed under `keyring`. */
async function seed(h: DbHandle, keyring: TenantKeyring, region: string) {
  const t = await newTenant(h, region, `Key Test ${randomUUID().slice(0, 4)}`);
  const person = randomUUID();
  const rows = await withTenant(h.db, t, async (tx) => {
    await keyring.provision(tx);
    const biz = { table: 'knowledge_records', column: 'body_enc', rowId: randomUUID() };
    const ppl = { table: 'messages', column: 'body_enc', rowId: randomUUID(), subject: person };
    return { biz, ppl, bizEnc: await keyring.seal(tx, biz, 'business secret'), pplEnc: await keyring.seal(tx, ppl, 'personal secret') };
  });
  const read = (kr: TenantKeyring) => withTenant(h.db, t, async (tx) => [await kr.openText(tx, rows.biz, rows.bizEnc), await kr.openText(tx, rows.ppl, rows.pplEnc)]);
  return { t, person, rows, read };
}

let h: DbHandle;
beforeAll(() => { h = appDb(); });
afterAll(async () => h.close());

contractSuite('T-KEY-1', () => {
  it('rotating the master key re-wraps every business and person key; nothing is lost; the old key is no longer needed', async () => {
    const ring = new KekRing([{ key: KEK_A, status: 'active' }]);
    const kr = new TenantKeyring(ring);
    const s = await seed(h, kr, 'key1');
    expect(await s.read(kr)).toEqual(['business secret', 'personal secret']);
    ring.rotateTo(KEK_B);
    const n = await withTenant(h.db, s.t, (tx) => kr.rewrapKeys(tx));
    expect(n).toBe(3); // data key, blind-index key, one person key
    const ids = await withTenant(h.db, s.t, async (tx) => [
      ...(await tx.selectFrom('tenant_keys').select('kek_id').execute()), ...(await tx.selectFrom('subject_keys').select('kek_id').execute()),
    ].map((r) => r.kek_id));
    expect(new Set(ids)).toEqual(new Set([ring.kekId]));
    // A cell that only holds the new KEK reads everything.
    expect(await s.read(new TenantKeyring(new KekRing([{ key: KEK_B, status: 'active' }])))).toEqual(['business secret', 'personal secret']);
    expect(await withTenant(h.db, s.t, (tx) => kr.rewrapKeys(tx))).toBe(0); // idempotent
  });
});

contractSuite('T-KEY-2', () => {
  it('a revoked master key can no longer unwrap anything', async () => {
    const ring = new KekRing([{ key: KEK_A, status: 'active' }]);
    const kr = new TenantKeyring(ring);
    const s = await seed(h, kr, 'key2');
    const oldId = ring.kekId;
    ring.rotateTo(KEK_B);
    ring.revoke(oldId); // revoked BEFORE re-wrapping: keys still under the old KEK become unreadable
    await expect(s.read(new TenantKeyring(ring))).rejects.toThrow(/revoked/);
    await expect(ring.unwrap(Buffer.alloc(45), 'x', oldId)).rejects.toThrow(/revoked/);
    expect(() => ring.revoke(ring.kekId)).toThrow(/rotate/);
  });
});

contractSuite('T-KEY-3', () => {
  let iso: Awaited<ReturnType<typeof isolatedDatabase>>;
  let live: DbHandle;
  const backupDb = `sevari_backup_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
  const withDb = (url: string, db: string) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };
  beforeAll(async () => { iso = await isolatedDatabase(); });
  afterAll(async () => {
    const admin = new pg.Client({ connectionString: withDb(iso.superUrl, 'postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${backupDb} WITH (FORCE)`);
    await admin.end();
    await iso.drop();
  });

  it('a restored backup keeps tenants\' keys apart and does not bring back keys destroyed after it was taken', async () => {
    const ring = new KekRing([{ key: KEK_C, status: 'active' }]);
    const kr = new TenantKeyring(ring);
    const register = new FileShredRegister(join(await mkdtemp(join(tmpdir(), 'sevari-shred-')), 'register.jsonl'));
    live = connect(iso.appUrl);
    const f = fixtures(iso);
    await f.ensureRegion('uk');
    const a = await seed(live, kr, 'uk');
    const b = await seed(live, kr, 'uk');
    const c = await seed(live, kr, 'uk');
    await withTenant(live.db, a.t, (tx) => tx.insertInto('contacts').values({ id: a.person, tenant_id: a.t.tenantId, region: a.t.region, source: 't', lawful_basis: 't', captured_at: clock.now(), captured_by: 't' }).execute());
    await live.close();

    // The backup: a full physical copy of the database at this moment.
    const admin = new pg.Client({ connectionString: withDb(iso.superUrl, 'postgres') });
    await admin.connect();
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [iso.database]);
    await admin.query(`CREATE DATABASE ${backupDb} TEMPLATE ${iso.database}`);
    await admin.end();

    // After the backup: person P in tenant A is erased, and tenant C closes (every key destroyed).
    live = connect(iso.appUrl);
    await withTenant(live.db, a.t, (tx) => eraseSubject({ keyring: kr, clock, register }, tx, a.person, 'dsar_erasure', 'dsar:test'));
    await withTenant(live.db, c.t, (tx) => kr.shredAll(tx, clock.now()));
    await register.append({ at: clock.now().toISOString(), tenantId: c.t.tenantId, region: c.t.region, kind: 'tenant', reason: 'tenant_exit' });
    await expect(withTenant(live.db, a.t, (tx) => kr.openText(tx, a.rows.ppl, a.rows.pplEnc))).rejects.toThrow(/erased|shredded/);
    await live.close();

    // Restore: the old copy comes back, still holding P's and C's live keys...
    const restored = connect(withDb(iso.appUrl, backupDb));
    try {
      expect(await withTenant(restored.db, a.t, (tx) => kr.openText(tx, a.rows.ppl, a.rows.pplEnc))).toBe('personal secret');
      // ...so before it serves anything, the register is re-applied.
      const r = await reapplyShredRegister({ db: restored.db, keyring: kr, clock }, register);
      expect(r).toEqual({ subjects: 1, tenants: 1 });
      await expect(withTenant(restored.db, a.t, (tx) => kr.openText(tx, a.rows.ppl, a.rows.pplEnc))).rejects.toThrow(/erased|shredded/);
      await expect(withTenant(restored.db, c.t, (tx) => kr.openText(tx, c.rows.biz, c.rows.bizEnc))).rejects.toThrow(/shredded/);
      expect(await withTenant(restored.db, a.t, (tx) => tx.selectFrom('contacts').select('id').where('id', '=', a.person).execute())).toHaveLength(0);
      // A's business data and B's everything survive the restore and re-application.
      expect(await withTenant(restored.db, a.t, (tx) => kr.openText(tx, a.rows.biz, a.rows.bizEnc))).toBe('business secret');
      const bRead = await withTenant(restored.db, b.t, async (tx) => [await kr.openText(tx, b.rows.biz, b.rows.bizEnc), await kr.openText(tx, b.rows.ppl, b.rows.pplEnc)]);
      expect(bRead).toEqual(['business secret', 'personal secret']);
      // Tenant isolation holds in the restored copy: B can't see A's keys, nor open A's data.
      const seen = await withTenant(restored.db, b.t, (tx) => tx.selectFrom('tenant_keys').select('tenant_id').execute());
      expect(new Set(seen.map((r) => r.tenant_id))).toEqual(new Set([b.t.tenantId]));
      await expect(withTenant(restored.db, b.t, (tx) => kr.openText(tx, a.rows.biz, a.rows.bizEnc))).rejects.toThrow();
    } finally {
      await restored.close();
    }
  });
});

contractSuite('T-KEY-4', () => {
  it('the key-compromise drill runs end to end: rotate, re-wrap every tenant, verify, revoke, assess', async () => {
    const ring = new KekRing([{ key: KEK_A, status: 'active' }]);
    const kr = new TenantKeyring(ring);
    const tenants = [await seed(h, kr, 'key4'), await seed(h, kr, 'key4'), await seed(h, kr, 'key4')];
    const onlyNew = new TenantKeyring(new KekRing([{ key: KEK_B, status: 'active' }]));
    const report = await keyCompromiseDrill({ db: h.db, ring, keyring: kr, clock }, tenants.map((s) => s.t), KEK_B, async (scope: TenantScope) => {
      const s = tenants.find((x) => x.t.tenantId === scope.tenantId);
      return Boolean(s && (await s.read(onlyNew)).length === 2);
    });
    expect(report).toMatchObject({ rewrapped: 9, tenantsVerified: 3, oldKekRevoked: true, oldKekStillUnwraps: false, breachAssessment: 'opened' });
    expect(report.steps).toHaveLength(5);
    const audit = await withTenant(h.db, tenants[0]!.t, (tx) => tx.selectFrom('audit_events').select('event_type').where('event_type', '=', 'key.compromise_response').execute());
    expect(audit).toHaveLength(1);
  });
});
