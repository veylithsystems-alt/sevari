import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, TokenBucketLimiter } from '@sevari/api';
import { LocalKeyFileKms, TenantKeyring } from '@sevari/crypto';
import { withTenant, type TenantTx } from '@sevari/db';
import { loadProcessorRegistry } from '@sevari/egress';
import { connectAccounting, draftInvoice, issueInvoice } from '@sevari/finance';
import { ask, digestOf } from '@sevari/hitl';
import { authenticate, newOperatorToken, platformDecision } from '@sevari/identity';
import {
  casesWithoutOwner, disableUser, eraseTenant, exportTenantBundle, FileShredRegister, issuePortalLink, requestOffboarding, requestOffload, TENANT_EXPORT, tenantExportIsDeclared,
} from '@sevari/privacy';
import { askOffload } from '@sevari/worker';
import { contractSuite } from '../support/contract.ts';
import { ownerQuery } from '../support/fixtures.ts';
import { harness, type Harness } from '../support/hitl-harness.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
let x: Harness;
const db = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(x.h.db, x.t, fn);
const contactOf = (messageId: string) => db(async (tx) => (await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id').select('conversations.contact_id').where('messages.id', '=', messageId).executeTakeFirstOrThrow()).contact_id);

beforeAll(async () => { x = await harness('off15', 151); });
afterAll(async () => x?.close());

contractSuite('F19', () => {
  it('a handover goes only to an approved supplier or a registered partner, with the owner\'s approval and only the fields named', async () => {
    const reg = await loadProcessorRegistry(join(ROOT, 'config', 'processors.yaml'));
    const approved = new Set(reg.processors.filter((p) => p.review.status === 'approved').map((p) => p.id));
    const m = await x.send('Can you come and unblock a drain? CH65 2AB', `o-${randomUUID()}@example.com`);
    const contactId = await contactOf(m.messageId);
    const base = { caseRef: `enquiry:${m.messageId}`, contactId, purpose: 'subcontract' as const, lawfulBasis: 'contract: the customer\'s job', fields: ['name', 'phone'] as const, ownerUserId: x.owner };
    await expect(db((tx) => requestOffload({ clock: x.clock, approvedProcessors: approved }, tx, { ...base, recipient: { partnerId: randomUUID() } }))).resolves.toMatchObject({ status: 'refused', reason: expect.stringMatching(/not registered/) });
    await expect(db((tx) => requestOffload({ clock: x.clock, approvedProcessors: approved }, tx, { ...base, recipient: { processorId: 'some-unknown-crm' } }))).resolves.toMatchObject({ status: 'refused', reason: expect.stringMatching(/not an approved supplier/) });
    await expect(db((tx) => requestOffload({ clock: x.clock, approvedProcessors: approved }, tx, { ...base, lawfulBasis: ' ', recipient: { processorId: 'brevo' } }))).resolves.toMatchObject({ status: 'refused', reason: expect.stringMatching(/lawful basis/) });
    const refused = await db((tx) => tx.selectFrom('audit_events').select('event_type').where('event_type', '=', 'offload.refused').execute());
    expect(refused.length).toBe(3);
    // The database refuses a partner who processes data for the business without a data processing agreement on record.
    await expect(db((tx) => tx.insertInto('partners').values({ tenant_id: x.t.tenantId, region: x.t.region, name: 'No Agreement Ltd (example)', kind: 'subcontractor', relationship: 'processor', lawful_basis: 'contract', recorded_by: `user:${x.owner}` }).execute())).rejects.toThrow(/check constraint/);
    const partner = await db(async (tx) => (await tx.insertInto('partners').values({ tenant_id: x.t.tenantId, region: x.t.region, name: 'Deep Drains Ltd (example)', kind: 'subcontractor', relationship: 'controller', lawful_basis: 'legitimate interests: completing the customer\'s job', recorded_by: `user:${x.owner}` }).returning('id').executeTakeFirstOrThrow()).id);
    const req = await db((tx) => requestOffload({ clock: x.clock, approvedProcessors: approved }, tx, { ...base, recipient: { partnerId: partner } }));
    if (req.status !== 'requested') throw new Error(req.reason);
    const id = req.id;
    const qid = await db((tx) => askOffload({ keyring: x.keyring, clock: x.clock, consumers: x.deps.consumers }, tx, id));
    const q = await db((tx) => tx.selectFrom('human_questions').select('content_digest').where('id', '=', qid).executeTakeFirstOrThrow());
    x.clock.advance(5_000);
    const r = await x.answer({ questionId: qid, responderId: x.owner, response: 'approve', digestSeen: q.content_digest.toString('hex') });
    expect(r).toMatchObject({ accepted: true, outcome: expect.stringMatching(/name, phone/) });
    const o = await db((tx) => tx.selectFrom('offloads').select(['status', 'bundle_enc']).where('id', '=', id).executeTakeFirstOrThrow());
    expect(o.status).toBe('approved');
    const bundle = JSON.parse(await db((tx) => x.keyring.openText(tx, { table: 'offloads', column: 'bundle_enc', rowId: id }, o.bundle_enc!))) as Record<string, unknown>;
    expect(Object.keys(bundle).sort()).toEqual(['name', 'phone']);
  });
});

contractSuite('F20', () => {
  it('a business\'s export contains only the fields its registry declares, readable, and nothing else', async () => {
    expect(tenantExportIsDeclared()).toEqual([]);
    const who = `exp-${randomUUID()}@example.com`;
    await x.send('Hello, how much to unblock a drain? CH65 2AB', who);
    const bundle = await db((tx) => exportTenantBundle(x, tx));
    for (const [table, rows] of Object.entries(bundle.tables)) {
      const allowed = new Set([...TENANT_EXPORT[table]!.plain, ...(TENANT_EXPORT[table]!.sealed ?? [])]);
      for (const r of rows) for (const k of Object.keys(r)) expect(allowed.has(k), `${table}.${k}`).toBe(true);
    }
    expect(bundle.tables['contacts']!.some((c) => c['email_enc'] === who)).toBe(true);
    const flat = JSON.stringify(bundle);
    for (const never of ['email_bidx', 'raw_enc', 'analysis_enc', 'token_hash', 'recipient_bidx']) expect(flat).not.toContain(never);
    expect(bundle.tables['knowledge_records']!.length).toBeGreaterThan(0);
  });
});

contractSuite('T-OFF-1', () => {
  it('no open case is ever without an owner, including when a team member leaves', async () => {
    const qid = await db((tx) => ask({ keyring: x.keyring, clock: x.clock, consumers: x.deps.consumers }, tx, {
      kind: 'owner_task', subjectRef: `test:${randomUUID()}`, contentDigest: digestOf({ t: 1 }), requiredRole: 'approver', assignTo: x.approver,
      body: { title: 't', summary: 't', optionLabels: { handled: 'ok', reply: 'r' }, safeDefaultText: '-' }, options: ['handled', 'reply'], safeDefault: 'hold', consumer: { kind: 'owner.task', ref: randomUUID() }, deadlineMs: 86_400_000,
    }));
    expect(await db((tx) => casesWithoutOwner(tx))).toEqual([]);
    expect(await db((tx) => disableUser(tx, x.approver))).toMatchObject({ reassigned: expect.any(Number) });
    const q = await db((tx) => tx.selectFrom('human_questions').select('assigned_user_id').where('id', '=', qid).executeTakeFirstOrThrow());
    expect(q.assigned_user_id).toBe(x.owner);
    expect(await db((tx) => casesWithoutOwner(tx))).toEqual([]);
    await expect(db((tx) => disableUser(tx, x.owner))).rejects.toThrow(/owner can't be switched off/);
    await expect(db((tx) => tx.insertInto('offloads').values({ tenant_id: x.t.tenantId, region: x.t.region, case_ref: 'x', processor_id: 'brevo', purpose: 'specialist', lawful_basis: 'x', fields: ['name'], owner_user_id: null as never }).execute())).rejects.toThrow(/null value|not-null/);
  });
});

describe('[Phase 15] the customer\'s own page', () => {
  it('shows their booking and invoices, and stops marketing or all messages in one click', async () => {
    const who = `portal-${randomUUID()}@example.com`;
    const m = await x.send('Hello', who);
    const contactId = await contactOf(m.messageId);
    await db(async (tx) => { const d = await draftInvoice(tx, { contactId, vatTreatment: 'inclusive', lines: [{ description: 'drain', quantity: 1, unitMinor: 9500 }], factsUsed: [] }); await issueInvoice(x, tx, d.id); });
    const token = await db((tx) => issuePortalLink(x, tx, contactId));
    const app = buildServer({ intake: x.intake, publicBaseUrl: 'https://t.example', limiter: new TokenBucketLimiter(x.clock, { capacity: 100, perMinute: 6000 }), ready: async () => true, owner: { db: x.h.db, keyring: x.keyring, clock: x.clock, consumers: x.deps.consumers } });
    try {
      const page = await app.inject({ method: 'GET', url: `/p/${token}` });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-security-policy']).toMatch(/default-src 'none'/);
      expect(page.body).toMatch(/Port Drains \(example\)/);
      expect(page.body).toMatch(/£95\.00, to pay/);
      expect(page.body).not.toMatch(/<script/);
      const stopM = await app.inject({ method: 'POST', url: `/p/${token}/stop-marketing` });
      expect(stopM.body).toMatch(/any more marketing messages/);
      const consent = await db((tx) => tx.selectFrom('consents').select(['action', 'source']).where('contact_id', '=', contactId).execute());
      expect(consent).toEqual([{ action: 'withdrawn', source: 'portal' }]);
      const stopAll = await app.inject({ method: 'POST', url: `/p/${token}/stop-all` });
      expect(stopAll.body).toMatch(/asked us not to contact you/);
      expect((await app.inject({ method: 'GET', url: `/p/${token.slice(0, -2)}xx` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/p/pl_aaaaaaaaaaaa.nonsense-token-that-is-long-enough-xx' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

contractSuite('F21', () => {
  it('a business that leaves is erased end to end after notice and grace, only with Veylith\'s decision: keys, tokens, links and people; tax records kept unlinked', async () => {
    const b = await harness('off15b', 152);
    try {
      const bdb = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(b.h.db, b.t, fn);
      const m = await b.send('How much to unblock a drain? CH65 2AB', `gone-${randomUUID()}@example.com`);
      await b.process(m.messageId);
      const contactId = await bdb(async (tx) => (await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id').select('conversations.contact_id').where('messages.id', '=', m.messageId).executeTakeFirstOrThrow()).contact_id);
      const invId = await bdb(async (tx) => { const d = await draftInvoice(tx, { contactId, vatTreatment: 'inclusive', lines: [{ description: 'drain', quantity: 1, unitMinor: 9500 }], factsUsed: [] }); await issueInvoice(b, tx, d.id); return d.id; });
      const connId = await bdb((tx) => connectAccounting(b, tx, 'fakebooks', 'secret-token', {}));
      await bdb((tx) => issuePortalLink(b, tx, contactId));
      const sealed = await bdb((tx) => tx.selectFrom('messages').select(['id', 'body_enc']).where('id', '=', m.messageId).executeTakeFirstOrThrow());
      const tokenRow = await bdb((tx) => tx.selectFrom('accounting_connections').select(['id', 'token_enc']).where('id', '=', connId).executeTakeFirstOrThrow());
      const register = new FileShredRegister(join(await mkdtemp(join(tmpdir(), 'sevari-off-')), 'register.jsonl'));
      const ob = await bdb((tx) => requestOffboarding(b, tx, 'owner'));
      await expect(bdb((tx) => eraseTenant({ ...b, register }, tx))).rejects.toThrow(/grace window/);
      b.clock.set(ob.graceUntil.getTime() + 1_000);
      await expect(bdb((tx) => eraseTenant({ ...b, register }, tx))).rejects.toThrow(/Veylith's recorded decision/);
      const tok = newOperatorToken();
      await ownerQuery('INSERT INTO operators (display_name, prefix, token_hash, role) VALUES ($1, $2, $3, $4)', ['Dan (test)', tok.prefix, tok.hash, 'founder']);
      await platformDecision(b.h.db, (await authenticate(b.h.db, b.clock, tok.full))!, { decision: 'signoff', subjectRef: `tenant:${b.t.tenantId}`, scope: `tenant:${b.t.tenantId}:erasure`, reason: 'left; grace ended', expiresOn: '2030-01-01' });
      const cert = await bdb((tx) => eraseTenant({ ...b, register }, tx));
      expect(cert).toMatchObject({ processor_tokens_revoked: 1, portal_links_destroyed: 1, channels_disabled: 1 });
      expect(cert.people_deleted).toBeGreaterThanOrEqual(1);
      expect(cert.keys_shredded).toBeGreaterThanOrEqual(3);
      // Nothing that was sealed can be read again, by any keyring, in any later transaction (no cache survives).
      const fresh = new TenantKeyring(LocalKeyFileKms.fromKey(Buffer.alloc(32, 152)));
      await expect(bdb((tx) => fresh.openText(tx, { table: 'messages', column: 'body_enc', rowId: sealed.id }, sealed.body_enc))).rejects.toThrow(/shredded|erased/);
      await expect(bdb((tx) => b.keyring.openText(tx, { table: 'accounting_connections', column: 'token_enc', rowId: tokenRow.id }, tokenRow.token_enc!))).rejects.toThrow(/shredded|erased/);
      const left = await bdb(async (tx) => ({
        contacts: (await tx.selectFrom('contacts').select('id').execute()).length,
        messages: (await tx.selectFrom('messages').select('id').execute()).length,
        portal: (await tx.selectFrom('portal_tokens').select('id').execute()).length,
        endpoints: (await tx.selectFrom('channel_endpoints').select('status').execute()).map((e) => e.status),
        invoice: await tx.selectFrom('invoices').select(['contact_id', 'total_minor', 'number']).where('id', '=', invId).executeTakeFirst(),
        tenant: (await tx.selectFrom('tenants').select('status').where('id', '=', b.t.tenantId).executeTakeFirstOrThrow()).status,
      }));
      expect(left).toMatchObject({ contacts: 0, messages: 0, portal: 0, endpoints: ['disabled'], tenant: 'closed' });
      expect(left.invoice).toMatchObject({ contact_id: null, total_minor: '9500' });
      expect((await register.entries()).map((e) => e.kind)).toContain('tenant');
    } finally {
      await b.close();
    }
  });
});
