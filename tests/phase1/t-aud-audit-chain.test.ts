import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql, withTenant, type DbHandle } from '@sevari/db';
import type { TenantScope } from '@sevari/domain';
import { appendAudit, checkpoint, Ed25519Signer, verifyAuditChain, verifyChainWithCheckpoints } from '@sevari/audit';
import { contractSuite } from '../support/contract.ts';
import { fixtures } from '../support/fixtures.ts';
import { isolatedDatabase } from '../support/db.ts';

contractSuite('T-AUD', () => {
  let h: DbHandle;
  let t: TenantScope;
  let other: TenantScope;
  const signer = Ed25519Signer.generate();
  // Tamper tests disable triggers as a superuser, so this file gets its own database.
  let iso: Awaited<ReturnType<typeof isolatedDatabase>>;
  let f: ReturnType<typeof fixtures>;
  const superQuery = (s: string, p: unknown[] = []) => f.superQuery(s, p);
  const ownerQuery = (s: string, p: unknown[] = []) => f.ownerQuery(s, p);
  const newTenant = (x: DbHandle) => f.newTenant(x);

  beforeAll(async () => {
    iso = await isolatedDatabase();
    f = fixtures(iso);
    h = f.appDb();
    t = await newTenant(h);
    other = await newTenant(h);
    for (let i = 0; i < 5; i++) {
      await withTenant(h.db, t, (tx) => appendAudit(tx, { type: 'test.event', actor: { kind: 'system' }, subject: `thing:${i}`, payload: { i } }));
    }
  });
  afterAll(async () => {
    await h.close();
    await iso.drop();
  });

  it('assigns a gapless sequence and links each hash to the previous one', async () => {
    const rows = await withTenant(h.db, t, (tx) => tx.selectFrom('audit_events').select(['seq', 'prev_hash', 'hash']).orderBy('seq').execute());
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.prev_hash.equals(rows[i - 1]!.hash)).toBe(true);
    expect(await withTenant(h.db, t, (tx) => verifyAuditChain(tx))).toBeNull();
  });

  it('ignores application-supplied seq and hash values', async () => {
    await withTenant(h.db, t, (tx) =>
      sql`INSERT INTO audit_events (tenant_id, region, event_type, actor_kind, seq, prev_hash, hash)
          VALUES (${t.tenantId}, ${t.region}, 'test.forged', 'system', 999, '\\x00', '\\x00')`.execute(tx));
    const last = await withTenant(h.db, t, (tx) => tx.selectFrom('audit_events').select(['seq', 'event_type']).orderBy('seq', 'desc').limit(1).executeTakeFirstOrThrow());
    expect(Number(last.seq)).toBe(6);
    expect(await withTenant(h.db, t, (tx) => verifyAuditChain(tx))).toBeNull();
  });

  it('the app role cannot UPDATE, DELETE or TRUNCATE audit rows', async () => {
    await expect(withTenant(h.db, t, (tx) => sql`UPDATE audit_events SET event_type = 'x.y.z' WHERE seq = 1`.execute(tx))).rejects.toThrow(/permission denied/);
    await expect(withTenant(h.db, t, (tx) => sql`DELETE FROM audit_events WHERE seq = 1`.execute(tx))).rejects.toThrow(/permission denied/);
    await expect(withTenant(h.db, t, (tx) => sql`TRUNCATE audit_events`.execute(tx))).rejects.toThrow(/permission denied/);
  });

  it('even the owner role cannot update or delete audit rows (no RLS policy for it, plus the trigger)', async () => {
    // The owner has no policy on tenant tables, so it cannot even see audit rows: 0 rows affected.
    expect((await ownerQuery("UPDATE audit_events SET event_type = 'x.y.z'")).rowCount).toBe(0);
    expect((await ownerQuery('DELETE FROM audit_events')).rowCount).toBe(0);
    await expect(ownerQuery('TRUNCATE audit_events')).rejects.toThrow(/append-only/);
    // And when RLS is out of the way (superuser), the trigger still refuses.
    await expect(superQuery("UPDATE audit_events SET event_type = 'x.y.z'")).rejects.toThrow(/append-only/);
    await expect(superQuery('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
    expect(await withTenant(h.db, t, (tx) => verifyAuditChain(tx))).toBeNull();
  });

  it('tampering by a superuser (triggers disabled) is detected by verification', async () => {
    await withTenant(h.db, t, (tx) => checkpoint(tx, signer));
    await superQuery('ALTER TABLE audit_events DISABLE TRIGGER audit_no_update');
    try {
      await superQuery(`UPDATE audit_events SET payload = '{"i": 42}' WHERE tenant_id = $1 AND seq = 3`, [t.tenantId]);
    } finally {
      await superQuery('ALTER TABLE audit_events ENABLE TRIGGER audit_no_update');
    }
    const broken = await withTenant(h.db, t, (tx) => verifyAuditChain(tx));
    expect(broken).toEqual({ brokenSeq: 3, reason: 'hash_mismatch' });
  });

  it('rewriting the whole chain is still caught by the signed checkpoint', async () => {
    // Attacker recomputes every hash from seq 3 onwards so the chain looks intact again.
    await superQuery('ALTER TABLE audit_events DISABLE TRIGGER audit_no_update');
    try {
      await superQuery(`
        DO $$ DECLARE r record; prev bytea; BEGIN
          SELECT hash INTO prev FROM audit_events WHERE tenant_id = '${t.tenantId}' AND seq = 2;
          FOR r IN SELECT * FROM audit_events WHERE tenant_id = '${t.tenantId}' AND seq >= 3 ORDER BY seq LOOP
            UPDATE audit_events SET prev_hash = prev, hash = sha256(prev || sevari_meta.audit_material(audit_events)) WHERE id = r.id
              RETURNING hash INTO prev;
          END LOOP; END $$`);
    } finally {
      await superQuery('ALTER TABLE audit_events ENABLE TRIGGER audit_no_update');
    }
    const report = await withTenant(h.db, t, (tx) => verifyChainWithCheckpoints(tx, signer));
    expect(report.brokenAt).toBeUndefined();
    expect(report.intact).toBe(false);
    expect(report.checkpointFailures.length).toBe(1);
  });

  it('concurrent appends never fork or gap the chain', async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) =>
      withTenant(h.db, other, (tx) => appendAudit(tx, { type: 'test.concurrent', actor: { kind: 'system' }, payload: { i } }))));
    const seqs = await withTenant(h.db, other, (tx) => tx.selectFrom('audit_events').select('seq').orderBy('seq').execute());
    expect(seqs.map((r) => Number(r.seq))).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(await withTenant(h.db, other, (tx) => verifyAuditChain(tx))).toBeNull();
  });

  it('refuses payload keys that look like personal data', async () => {
    await expect(withTenant(h.db, other, (tx) =>
      appendAudit(tx, { type: 'test.pii', actor: { kind: 'system' }, payload: { customer_email: 'a@b.c' } }))).rejects.toThrow(/personal data/);
  });
});
