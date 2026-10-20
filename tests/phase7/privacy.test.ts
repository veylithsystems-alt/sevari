import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, TokenBucketLimiter } from '@sevari/api';
import { piiColumns, tableSecurity, withTenant } from '@sevari/db';
import { hasConsent, recordConsent, reapplyErasures, registryGaps, retentionRun, dueDate, classifyRightsRequest, exportFieldsAreDeclared } from '@sevari/privacy';
import { reserve } from '@sevari/outbound';
import { ground } from '@sevari/grounding';
import { contractSuite } from '../support/contract.ts';
import { draftFor, harness, type Harness } from '../support/hitl-harness.ts';
import { newTenant, superQuery } from '../support/fixtures.ts';

let x: Harness;
beforeAll(async () => { x = await harness('priv7', 71); });
afterAll(async () => x.close());

const delivered = (to: string) => [...x.provider.accepted.values()].filter((v) => v.env.to === to).map((v) => v.env.text);
async function contactOf(email: string): Promise<string> {
  const { normaliseEmail } = await import('@sevari/domain');
  return withTenant(x.h.db, x.t, async (tx) => {
    const idx = await x.keyring.index(tx, 'email', normaliseEmail(email)!);
    return (await tx.selectFrom('contacts').select('id').where('email_bidx', '=', idx).executeTakeFirstOrThrow()).id;
  });
}
async function approveDraft(enquiryId: string) {
  const d = await draftFor(x, enquiryId);
  const q = await x.question(`draft:${d!.id}`);
  x.clock.advance(10_000);
  await x.answer({ questionId: q!.id, responderId: x.owner, response: 'approve', digestSeen: q!.digest });
  await x.drain();
}
async function rightsRequest(email: string, text: string) {
  const m = await x.send(text, email);
  const r = await x.process(m.messageId);
  const d = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('dsar_requests').selectAll().where('source_message_id', '=', m.messageId).executeTakeFirstOrThrow());
  const q = await x.question(`dsar:${d.id}`);
  return { m, r, d, q: q! };
}
/** Every row of every table in the database, as text, searched for a marker in plain text or as hex bytes. */
async function scanFor(marker: string): Promise<string[]> {
  const tables = (await superQuery(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows.map((r: { table_name: string }) => r.table_name);
  const hex = Buffer.from(marker, 'utf8').toString('hex');
  const hits: string[] = [];
  for (const t of tables) {
    const r = await superQuery(`SELECT count(*)::int AS n FROM ${t} x WHERE x::text ILIKE $1 OR x::text ILIKE $2`, [`%${marker}%`, `%${hex}%`]);
    if (r.rows[0].n > 0) hits.push(`${t}:${r.rows[0].n}`);
  }
  return hits;
}

contractSuite('F5', () => {
  it('every table and every personal-data column is in the erasure registry (INV-6)', async () => {
    const tables = await tableSecurity(x.h.db);
    expect(registryGaps(piiColumns(tables), tables.map((t) => t.table))).toEqual([]);
    expect(exportFieldsAreDeclared()).toEqual([]);
  });

  it('erasing a person leaves nothing recoverable: not in any table, and not in any copy made before (crypto-shred)', async () => {
    const marker = `XYZZY${randomUUID().slice(0, 8)}`;
    const email = `erase.${marker.toLowerCase()}@example.com`;
    const other = `keep.${randomUUID().slice(0, 8)}@example.com`;
    const otherMarker = `KEEPME${randomUUID().slice(0, 8)}`;
    // A full history for the person: enquiry, acknowledgement, approved reply, consent, an owner question.
    const first = await x.send(`How much to unblock a drain? Reference ${marker}. CH65 2AB`, email);
    const r1 = await x.process(first.messageId);
    await approveDraft(r1.enquiryId);
    const contactId = await contactOf(email);
    await withTenant(x.h.db, x.t, (tx) => recordConsent(tx, { contactId, purpose: 'reminders', channel: 'email', action: 'granted', basis: 'consent', source: 'web_form', wordingVersion: 'rem-1', at: x.clock.now() }));
    // Someone else, who must be untouched.
    const keep = await x.send(`How much to unblock a drain? Reference ${otherMarker}. CH65 2AB`, other);
    await x.process(keep.messageId);
    expect(await scanFor(marker)).toEqual([]); // encrypted at rest already: never plaintext in the database
    // "Backup" copies of their ciphertexts, taken before erasure.
    const backups = await withTenant(x.h.db, x.t, async (tx) => {
      const msg = await tx.selectFrom('messages').select(['id', 'body_enc']).where('id', '=', first.messageId).executeTakeFirstOrThrow();
      const out = await tx.selectFrom('outbox').select(['id', 'body_enc']).where('contact_id', '=', contactId).execute();
      const qs = await tx.selectFrom('human_questions').select(['id', 'body_enc']).where('subject_contact_id', '=', contactId).execute();
      return [{ table: 'messages', column: 'body_enc', rowId: msg.id, enc: msg.body_enc }, ...out.map((o) => ({ table: 'outbox', column: 'body_enc', rowId: o.id, enc: o.body_enc })), ...qs.map((q) => ({ table: 'human_questions', column: 'body_enc', rowId: q.id, enc: q.body_enc }))];
    });
    expect(backups.length).toBeGreaterThanOrEqual(3);
    for (const b of backups) await withTenant(x.h.db, x.t, (tx) => x.keyring.openText(tx, b, b.enc)); // readable before

    // They ask to be forgotten; the owner releases it.
    const { d, q } = await rightsRequest(email, 'Please delete my data. I want the right to be forgotten.');
    expect(d).toMatchObject({ kind: 'erasure', identity: 'channel_verified', status: 'awaiting_release' });
    x.clock.advance(10_000);
    const ans = await x.answer({ questionId: q.id, responderId: x.owner, response: 'erase', digestSeen: q.digest });
    expect(ans.accepted).toBe(true);
    await x.drain();
    await x.drain();

    // They were told, before the erasure.
    expect(delivered(email).some((t) => t.includes('deleted the information we held about you'))).toBe(true);
    const after = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('dsar_requests').select(['status', 'outcome', 'contact_id']).where('id', '=', d.id).executeTakeFirstOrThrow());
    expect(after).toEqual({ status: 'completed', outcome: 'erased', contact_id: null });
    // Nothing of theirs remains anywhere in the database, in any form.
    expect(await scanFor(marker)).toEqual([]);
    expect(await scanFor(email)).toEqual([]);
    expect(await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('contacts').select('id').where('id', '=', contactId).execute())).toHaveLength(0);
    // Every copy taken before is now unreadable.
    for (const b of backups) await expect(withTenant(x.h.db, x.t, (tx) => x.keyring.openText(tx, b, b.enc))).rejects.toThrow(/erased|shredded/);
    // Proof, with what was kept and why.
    const log = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('erasure_log').select(['certificate', 'reason']).where('subject_ref', '=', contactId).executeTakeFirstOrThrow());
    expect(log.reason).toBe('dsar_erasure');
    expect(log.certificate).toMatchObject({ keysShredded: 1, deleted: { contacts: 1, messages: 2 } });
    expect((await x.notices(x.owner)).some((n) => n.ref === `input:${ans.inputId}` && /deleted/.test(n.text))).toBe(true);
    // The other customer is untouched and readable.
    const keepId = await contactOf(other);
    const keepMsg = await withTenant(x.h.db, x.t, async (tx) => {
      const m = await tx.selectFrom('messages').select(['id', 'body_enc']).where('id', '=', keep.messageId).executeTakeFirstOrThrow();
      return x.keyring.openText(tx, { table: 'messages', column: 'body_enc', rowId: m.id }, m.body_enc);
    });
    expect(keepId).toBeTruthy();
    expect(keepMsg).toContain(otherMarker);
  });

  it('an opt-out survives erasure: the person is never messaged again', async () => {
    const email = `stopper.${randomUUID().slice(0, 8)}@example.com`;
    const stop = await x.send('STOP', email);
    await x.process(stop.messageId);
    const { q } = await rightsRequest(email, 'Delete my data please, right to be forgotten');
    x.clock.advance(10_000);
    await x.answer({ questionId: q.id, responderId: x.owner, response: 'erase', digestSeen: q.digest });
    await x.drain();
    await x.drain();
    const blocked = await withTenant(x.h.db, x.t, async (tx) => {
      const g = ground('Port Drains (example): hello', 'reply', { factTexts: ['Port Drains (example)'], factIds: [], customerText: '' }, { nowMs: x.clock.nowMs(), timezone: 'Europe/London' });
      if (!g.ok) throw new Error('grounding');
      const conv = await tx.insertInto('contacts').values({ tenant_id: x.t.tenantId, region: x.t.region, source: 'test', lawful_basis: 'test', captured_at: x.clock.now(), captured_by: 'test' }).returning('id').executeTakeFirstOrThrow();
      const c2 = await tx.insertInto('conversations').values({ tenant_id: x.t.tenantId, region: x.t.region, contact_id: conv.id }).returning('id').executeTakeFirstOrThrow();
      return reserve(tx, x.keyring, x.clock, { draft: g.draft, conversationId: c2.id, contactId: conv.id, channel: 'email', recipient: email, actionClass: 'info_reply', dedupeKey: `after-erase:${email}` });
    });
    expect(blocked.status).toBe('suppressed');
  });

  it('closing a business shreds every key: no ciphertext of that business can be read, by any key version', async () => {
    const h2 = x.h;
    const t2 = await newTenant(h2, 'priv7', 'Closing Ltd');
    const sealed = await withTenant(h2.db, t2, async (tx) => {
      await x.keyring.provision(tx);
      return {
        tenant: await x.keyring.seal(tx, { table: 'knowledge_records', column: 'body_enc', rowId: '00000000-0000-4000-8000-000000000001' }, 'business fact'),
        person: await x.keyring.seal(tx, { table: 'messages', column: 'body_enc', rowId: '00000000-0000-4000-8000-000000000002', subject: '00000000-0000-4000-8000-0000000000aa' }, 'personal text'),
      };
    });
    await withTenant(h2.db, t2, (tx) => x.keyring.shredAll(tx, x.clock.now()));
    await expect(withTenant(h2.db, t2, (tx) => x.keyring.openText(tx, { table: 'knowledge_records', column: 'body_enc', rowId: '00000000-0000-4000-8000-000000000001' }, sealed.tenant))).rejects.toThrow(/shredded/);
    await expect(withTenant(h2.db, t2, (tx) => x.keyring.openText(tx, { table: 'messages', column: 'body_enc', rowId: '00000000-0000-4000-8000-000000000002' }, sealed.person))).rejects.toThrow(/erased|shredded/);
  });

  it('after a backup restore, logged erasures are re-applied', async () => {
    const email = `restored.${randomUUID().slice(0, 8)}@example.com`;
    const m = await x.send('How much to unblock a drain? CH65 2AB', email);
    await x.process(m.messageId);
    const id = await contactOf(email);
    const { q } = await rightsRequest(email, 'Please delete my data');
    x.clock.advance(10_000);
    await x.answer({ questionId: q.id, responderId: x.owner, response: 'erase', digestSeen: q.digest });
    await x.drain();
    await x.drain();
    // Simulate a restore bringing the person (and a live key) back.
    await withTenant(x.h.db, x.t, async (tx) => {
      await tx.insertInto('contacts').values({ id, tenant_id: x.t.tenantId, region: x.t.region, source: 'restored', lawful_basis: 'restored', captured_at: x.clock.now(), captured_by: 'restore' }).execute();
      await tx.insertInto('subject_keys').values({ tenant_id: x.t.tenantId, region: x.t.region, subject_ref: id, kek_id: 'k', wrapped_dek: Buffer.alloc(40) }).execute();
    });
    expect(await withTenant(x.h.db, x.t, (tx) => reapplyErasures(x, tx))).toBe(1);
    expect(await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('contacts').select('id').where('id', '=', id).execute())).toHaveLength(0);
    expect(await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('subject_keys').select('id').where('subject_ref', '=', id).where('state', '=', 'active').execute())).toHaveLength(0);
  });
});

describe('[Phase 7] data-rights requests (§21.2)', () => {
  it('a request is recognised, clocked to one month, and waits for the owner', async () => {
    expect(classifyRightsRequest('Can I have a copy of my data? This is a subject access request.')).toBe('access');
    expect(classifyRightsRequest('Please delete my details')).toBe('erasure');
    expect(classifyRightsRequest('I have a question about GDPR')).toBe('unspecified');
    expect(dueDate(new Date('2026-01-31T10:00:00Z')).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(dueDate(new Date('2026-10-14T09:00:00Z')).toISOString()).toBe('2026-11-14T09:00:00.000Z');
  });

  it('access: the owner releases, the person gets a one-time link to a copy of exactly their data', async () => {
    const email = `access.${randomUUID().slice(0, 8)}@example.com`;
    const marker = `MINE${randomUUID().slice(0, 6)}`;
    const m0 = await x.send(`Do you clear blocked drains? ${marker} CH65 2AB`, email);
    await x.process(m0.messageId);
    const { d, q } = await rightsRequest(email, 'Can I have a copy of my data please? Subject access request.');
    expect(d.kind).toBe('access');
    expect(new Date(d.due_at).getTime() - new Date(d.received_at).getTime()).toBeGreaterThan(27 * 86_400_000);
    // Nothing happens until the owner decides.
    expect(delivered(email).some((t) => t.includes('/v1/dsar/'))).toBe(false);
    x.clock.advance(10_000);
    const ans = await x.answer({ questionId: q.id, responderId: x.owner, response: 'release', digestSeen: q.digest });
    expect(ans.accepted).toBe(true);
    await x.drain();
    const msg = delivered(email).find((t) => t.includes('/v1/dsar/'));
    expect(msg).toBeTruthy();
    const token = /\/v1\/dsar\/(dl_[a-z0-9]{12}\.[A-Za-z0-9_-]+)/.exec(msg!)?.[1];
    const app = buildServer({ intake: x.intake, publicBaseUrl: 'https://uk.sevari.example', limiter: new TokenBucketLimiter(x.clock, { capacity: 100, perMinute: 6000 }), ready: async () => true, owner: { db: x.h.db, keyring: x.keyring, clock: x.clock, consumers: x.deps.consumers } });
    const res = await app.inject({ method: 'GET', url: `/v1/dsar/${token}` });
    expect(res.statusCode).toBe(200);
    const copy = res.json();
    expect(copy.about_you.email).toBe(email);
    expect(copy.messages_from_you.map((mm: { text: string }) => mm.text).join(' ')).toContain(marker);
    expect(JSON.stringify(copy)).not.toMatch(/KEEPME|XYZZY/); // nobody else's data
    expect((await app.inject({ method: 'GET', url: `/v1/dsar/${token}` })).statusCode).toBe(410); // one time only
    expect((await app.inject({ method: 'GET', url: '/v1/dsar/dl_aaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })).statusCode).toBe(404);
    await app.close();
  });

  it('refusal is recorded, and the owner is told what they still owe the person', async () => {
    const email = `refuse.${randomUUID().slice(0, 8)}@example.com`;
    const { d, q } = await rightsRequest(email, 'Please delete my data');
    x.clock.advance(10_000);
    const ans = await x.answer({ questionId: q.id, responderId: x.owner, response: 'refuse', digestSeen: q.digest });
    expect(ans.accepted && ans.outcome).toMatch(/Information Commissioner/);
    expect((await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('dsar_requests').select('status').where('id', '=', d.id).executeTakeFirstOrThrow())).status).toBe('refused');
  });

  it('only the owner can release a request (a reserved decision, §8.3)', async () => {
    const { q } = await rightsRequest(`perm.${randomUUID().slice(0, 8)}@example.com`, 'Please delete my data');
    const r = await x.answer({ questionId: q.id, responderId: x.approver, response: 'erase', digestSeen: q.digest });
    expect(r).toMatchObject({ accepted: false, reason: 'wrong_role' });
  });
});

describe('[Phase 7] consent ledger and retention', () => {
  it('consent is an append-only record; the latest event wins; a grant needs the wording seen', async () => {
    const email = `consent.${randomUUID().slice(0, 8)}@example.com`;
    const m = await x.send('Hello', email);
    await x.process(m.messageId);
    const c = await contactOf(email);
    await withTenant(x.h.db, x.t, async (tx) => {
      expect(await hasConsent(tx, c, 'marketing', 'email')).toBe(false);
      await recordConsent(tx, { contactId: c, purpose: 'marketing', channel: 'email', action: 'granted', basis: 'consent', source: 'web_form', wordingVersion: 'mk-1', at: x.clock.now() });
      expect(await hasConsent(tx, c, 'marketing', 'email')).toBe(true);
      expect(await hasConsent(tx, c, 'marketing', 'sms')).toBe(false);
    });
    x.clock.advance(1_000);
    await withTenant(x.h.db, x.t, (tx) => recordConsent(tx, { contactId: c, purpose: 'marketing', channel: 'all', action: 'withdrawn', basis: 'consent', source: 'reply_stop', at: x.clock.now() }));
    expect(await withTenant(x.h.db, x.t, (tx) => hasConsent(tx, c, 'marketing', 'email'))).toBe(false);
    await expect(withTenant(x.h.db, x.t, (tx) => recordConsent(tx, { contactId: c, purpose: 'marketing', channel: 'email', action: 'granted', basis: 'consent', source: 'x', at: x.clock.now() }))).rejects.toThrow(/wording/);
    await expect(withTenant(x.h.db, x.t, (tx) => tx.updateTable('consents').set({ action: 'granted' }).where('contact_id', '=', c).execute())).rejects.toThrow(/permission denied/);
    await expect(withTenant(x.h.db, x.t, (tx) => tx.deleteFrom('consents').where('contact_id', '=', c).execute())).rejects.toThrow(/permission denied/);
  });

  it('retention runs report only, until counsel confirms a period', async () => {
    x.clock.advance(800 * 86_400_000);
    const findings = await withTenant(x.h.db, x.t, (tx) => retentionRun(x, tx));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.action === 'report_only' && f.status === 'H')).toBe(true);
    expect(findings.find((f) => f.table === 'drafts')?.overdue).toBeGreaterThan(0);
    expect((await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('drafts').select('id').execute())).length).toBeGreaterThan(0); // nothing deleted
  });
});
