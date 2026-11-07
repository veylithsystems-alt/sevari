import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type TenantTx } from '@sevari/db';
import { regionCode, tenantId } from '@sevari/domain';
import { billLines, connectAccounting, disconnectAccounting, draftInvoice, FakeAccounting, issueInvoice, meterUsage, recordPaymentEvent, syncAccounting, trialBalance, type Plan } from '@sevari/finance';
import { ask, answer, digestOf } from '@sevari/hitl';
import { authenticate, newOperatorToken, platformDecision } from '@sevari/identity';
import { billingRunHandler, dunningCheck, startSubscription, suspendHandler } from '@sevari/worker';
import { contractSuite } from '../support/contract.ts';
import { ownerQuery, superQuery } from '../support/fixtures.ts';
import { draftFor, harness, type Harness } from '../support/hitl-harness.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
let house: Harness;
let biz: Harness;
let founderTok: string;
const plan: Plan = { planKey: 'standard', planVersion: 1, name: 'Standard', priceMinor: 5900, currency: 'GBP', vatTreatment: 'exclusive', allowances: { enquiries: 2, seats: 3, channels: 3 }, overagePerEnquiryMinor: 50 };

const decide = async (scope: string, reason: string) => platformDecision(house.h.db, (await authenticate(house.h.db, house.clock, founderTok))!, { decision: 'signoff', subjectRef: scope, scope, reason, expiresOn: '2027-12-31' });
const hdb = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(house.h.db, house.t, fn);

beforeAll(async () => {
  house = await harness('bill13', 131);
  await superQuery('UPDATE tenants SET is_house = true WHERE id = $1', [house.t.tenantId]);
  biz = await harness('bill13', 132);
  const tok = newOperatorToken();
  await ownerQuery('INSERT INTO operators (display_name, prefix, token_hash, role) VALUES ($1, $2, $3, $4)', ['Dan (test)', tok.prefix, tok.hash, 'founder']);
  founderTok = tok.full;
});
afterAll(async () => { await biz?.close(); await house?.close(); });

/** The business owner's contact at Veylith, and a recorded human decision setting their terms. */
async function businessContact() {
  const m = await house.send('Hi, signing up for Sevari', `owner-${randomUUID()}@business.example`);
  const contactId = await hdb(async (tx) => (await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id').select('conversations.contact_id').where('messages.id', '=', m.messageId).executeTakeFirstOrThrow()).contact_id);
  const q = await hdb((tx) => ask({ keyring: house.keyring, clock: house.clock, consumers: house.deps.consumers }, tx, {
    kind: 'owner_task', subjectRef: `terms:${randomUUID()}`, contentDigest: digestOf({ terms: 1 }), requiredRole: 'owner',
    body: { title: 'Terms agreed', summary: 'Founding rate', optionLabels: { handled: 'Agreed', reply: 'x' }, safeDefaultText: '-' }, options: ['handled', 'reply'], safeDefault: 'hold',
    consumer: { kind: 'owner.task', ref: randomUUID() }, deadlineMs: 86_400_000,
  }));
  house.clock.advance(5_000);
  const r = await hdb((tx) => answer({ keyring: house.keyring, clock: house.clock, consumers: house.deps.consumers }, tx, { questionId: q, responderId: house.owner, response: 'handled', digestSeen: digestOf({ terms: 1 }).toString('hex'), channel: 'app' }));
  if (!r.accepted) throw new Error('terms not recorded');
  return { contactId, inputId: r.inputId };
}

describe('[Phase 13] pricing is pure data', () => {
  const terms = { startedOn: '2026-11-01', pilotUntil: null, foundingPriceMinor: null, foundingLockUntil: null };
  const usage = { resolvedEnquiries: 1, seats: 1, channels: 1 };
  it('a full period, a part period, the founding rate, the pilot, and overage', () => {
    expect(billLines(plan, terms, usage, '2026-11-01', '2026-12-01')).toEqual([{ description: 'Standard plan, 2026-11-01 to 2026-12-01', quantity: 1, unitMinor: 5900 }]);
    expect(billLines(plan, { ...terms, startedOn: '2026-11-16' }, usage, '2026-11-01', '2026-12-01')[0]).toMatchObject({ unitMinor: 2950, description: expect.stringMatching(/15 of 30 days/) });
    expect(billLines({ ...plan, priceMinor: 9900 }, { ...terms, foundingPriceMinor: 5900, foundingLockUntil: '2027-11-01' }, usage, '2027-03-01', '2027-04-01')[0]).toMatchObject({ unitMinor: 5900, description: expect.stringMatching(/founding rate/) });
    expect(billLines(plan, { ...terms, pilotUntil: '2026-12-27' }, usage, '2026-11-01', '2026-12-01')).toEqual([]);
    expect(billLines(plan, terms, { ...usage, resolvedEnquiries: 5 }, '2026-11-01', '2026-12-01')[1]).toEqual({ description: 'Enquiries beyond the 2 included', quantity: 3, unitMinor: 50 });
  });
});

contractSuite('T-BILL-1', () => {
  it('usage is read as counts in the business\'s own scope; billing code never opens message content', async () => {
    const u = await meterUsage(biz.h.db, biz.t, '2026-01-01', '2030-01-01');
    expect(Object.keys(u).sort()).toEqual(['channels', 'resolvedEnquiries', 'seats']);
    for (const v of Object.values(u)) expect(typeof v).toBe('number');
    for (const f of ['packages/finance/src/billing.ts', 'apps/worker/src/billing.ts']) {
      const src = readFileSync(resolve(ROOT, f), 'utf8');
      expect(src).not.toMatch(/body_enc|openText|analysis_enc|subject_enc/);
    }
  });
});

contractSuite('T-BILL-3', () => {
  it('a period is billed once, from the approved plan only, with the founding rate honoured when the list price rises', async () => {
    // Usage at the business: two replies sent this period.
    for (const t of ['How much to unblock a drain? CH65 2AB', 'How much to unblock a toilet? CH65 2AB']) {
      const m = await biz.send(t);
      const d = await draftFor(biz, (await biz.process(m.messageId)).enquiryId);
      const q = await biz.question(`draft:${d!.id}`);
      biz.clock.advance(5_000);
      await biz.answer({ questionId: q!.id, responderId: biz.owner, response: 'approve', digestSeen: q!.digest });
      await biz.drain();
    }
    const v1 = await decide('plans:bill13', 'standard v1');
    await ownerQuery(`INSERT INTO plans (region, plan_key, plan_version, name, price_minor, currency, vat_treatment, allowances, overage_per_enquiry_minor, effective_from, approval_decision_id) VALUES ('bill13','standard',1,'Standard',5900,'GBP','exclusive','{"enquiries":300,"seats":3,"channels":3}',0,'2026-01-01',$1)`, [v1]);
    // A later, higher price that was never approved: never used.
    await ownerQuery(`INSERT INTO plans (region, plan_key, plan_version, name, price_minor, currency, vat_treatment, allowances, overage_per_enquiry_minor, effective_from) VALUES ('bill13','standard',3,'Standard',99999,'GBP','exclusive','{"enquiries":300,"seats":3,"channels":3}',0,'2026-02-01')`);
    const v2 = await decide('plans:bill13:v2', 'standard v2');
    await ownerQuery(`INSERT INTO plans (region, plan_key, plan_version, name, price_minor, currency, vat_treatment, allowances, overage_per_enquiry_minor, effective_from, approval_decision_id) VALUES ('bill13','standard',2,'Standard',7900,'GBP','exclusive','{"enquiries":300,"seats":3,"channels":3}',0,'2026-02-01',$1)`, [v2]);
    const c = await businessContact();
    const subId = await hdb((tx) => startSubscription(tx, { businessTenantId: biz.t.tenantId, contactId: c.contactId, planKey: 'standard', startedOn: '2026-11-01', termsInputId: c.inputId, foundingPriceMinor: 5900, foundingLockUntil: '2027-11-01' }));
    house.clock.set(Date.parse('2026-12-01T10:00:00Z'));
    const run = billingRunHandler({ db: house.h.db, keyring: house.keyring, clock: house.clock, consumers: house.deps.consumers });
    expect(await run.scoped(house.t, { subscription_id: subId })).toBe('awaiting_approval');
    // Run again: that period is done, and the next one hasn't finished yet.
    await expect(run.scoped(house.t, { subscription_id: subId })).rejects.toThrow(/not finished/);
    const runs = await hdb((tx) => tx.selectFrom('billing_runs').select(['usage', 'invoice_id']).where('subscription_id', '=', subId).execute());
    expect(runs).toHaveLength(1);
    const inv = await hdb((tx) => tx.selectFrom('invoices').select(['net_minor', 'vat_minor', 'total_minor', 'status']).where('id', '=', runs[0]!.invoice_id!).executeTakeFirstOrThrow());
    expect(inv).toEqual({ net_minor: '5900', vat_minor: '1180', total_minor: '7080', status: 'draft' }); // founding £59 + VAT, not the £79 list price
    expect(runs[0]!.usage).toMatchObject({ seats: expect.any(Number) });
  });
});

contractSuite('T-BILL-2', () => {
  it('overdue: past due and Dan told; no suspension without his recorded decision; the database refuses a shortcut', async () => {
    const c = await businessContact();
    const b2 = await harness('bill13', 133);
    try {
      const subId = await hdb((tx) => startSubscription(tx, { businessTenantId: b2.t.tenantId, contactId: c.contactId, planKey: 'standard', startedOn: '2026-01-01', termsInputId: c.inputId }));
      // An issued invoice, long overdue.
      house.clock.set(Date.parse('2026-02-01T10:00:00Z'));
      await hdb(async (tx) => { const d = await draftInvoice(tx, { contactId: c.contactId, vatTreatment: 'exclusive', lines: [{ description: 'Standard plan', quantity: 1, unitMinor: 5900 }], factsUsed: [] }); await issueInvoice(house, tx, d.id); });
      house.clock.set(Date.parse('2026-04-01T10:00:00Z'));
      expect(await hdb((tx) => dunningCheck({ db: house.h.db, keyring: house.keyring, clock: house.clock, consumers: house.deps.consumers }, tx, { subscription_id: subId }))).toBe('past_due');
      const suspend = suspendHandler({ db: house.h.db, keyring: house.keyring, clock: house.clock, consumers: house.deps.consumers });
      expect(await suspend.scoped(house.t, { subscription_id: subId })).toBe('awaiting_decision');
      const status = async () => (await withTenant(b2.h.db, b2.t, (tx) => tx.selectFrom('tenants').select('status').where('id', '=', b2.t.tenantId).executeTakeFirstOrThrow())).status;
      expect(await status()).toBe('active');
      await expect(withTenant(b2.h.db, b2.t, (tx) => tx.updateTable('tenants').set({ status: 'suspended' }).where('id', '=', b2.t.tenantId).execute())).rejects.toThrow(/recorded decision/);
      await decide(`tenant:${b2.t.tenantId}:suspension`, 'non-payment after notice');
      expect(await suspend.scoped(house.t, { subscription_id: subId })).toBe('suspended');
      expect(await status()).toBe('suspended');
    } finally {
      await b2.close();
    }
    void tenantId; void regionCode;
  });
});

contractSuite('T-ACC-1', () => {
  it('every issued invoice and payment is pushed exactly once, and the pushed totals equal the ledger', async () => {
    const books = new FakeAccounting();
    const db = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(biz.h.db, biz.t, fn);
    const m = await biz.send('Hello', `acc-${randomUUID()}@example.com`);
    const contactId = await db(async (tx) => (await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id').select('conversations.contact_id').where('messages.id', '=', m.messageId).executeTakeFirstOrThrow()).contact_id);
    const invs = await db(async (tx) => {
      const out = [];
      for (const amt of [9500, 8500]) { const d = await draftInvoice(tx, { contactId, vatTreatment: 'inclusive', lines: [{ description: 'drain', quantity: 1, unitMinor: amt }], factsUsed: [] }); await issueInvoice(biz, tx, d.id); out.push(d.id); }
      return out;
    });
    await db((tx) => recordPaymentEvent(tx, { provider: 'fakepay', providerEventId: `acc_${randomUUID()}`, kind: 'payment_succeeded', invoiceId: invs[0]!, amountMinor: 9500, currency: 'GBP', occurredAt: biz.clock.now() }));
    await db((tx) => connectAccounting(biz, tx, books.name, 'access-token-123', { revenue: '200', vat_output: '820' }));
    const a = await syncAccounting({ db: biz.h.db, keyring: biz.keyring, clock: biz.clock }, biz.t, books);
    const b = await syncAccounting({ db: biz.h.db, keyring: biz.keyring, clock: biz.clock }, biz.t, books);
    expect(a.failed).toBe(0);
    expect(a.pushed).toBeGreaterThanOrEqual(3);
    expect(b.pushed).toBe(0);
    const pushedTotal = [...books.invoices.values()].reduce((s, i) => s + i.totalMinor, 0);
    const ar = await db(async (tx) => (await tx.selectFrom('ledger_entries').select((eb) => eb.fn.sum<string>('amount_minor').as('s')).where('account', '=', 'accounts_receivable').where('direction', '=', 'debit').executeTakeFirstOrThrow()).s);
    expect(pushedTotal).toBe(Number(ar));
    expect(Object.values(await db((tx) => trialBalance(tx))).reduce((x, y) => x + y, 0)).toBe(0);
  });
});

contractSuite('T-ACC-2', () => {
  it('a failed push is logged and handed to the owner, not retried in a loop; disconnecting shreds the token', async () => {
    const b3 = await harness('bill13', 134);
    try {
      const books = new FakeAccounting();
      const db = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(b3.h.db, b3.t, fn);
      const m = await b3.send('Hello', `f-${randomUUID()}@example.com`);
      const contactId = await db(async (tx) => (await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id').select('conversations.contact_id').where('messages.id', '=', m.messageId).executeTakeFirstOrThrow()).contact_id);
      await db(async (tx) => { const d = await draftInvoice(tx, { contactId, vatTreatment: 'inclusive', lines: [{ description: 'drain', quantity: 1, unitMinor: 7500 }], factsUsed: [] }); await issueInvoice(b3, tx, d.id); });
      const connId = await db((tx) => connectAccounting(b3, tx, books.name, 'tok-xyz', {}));
      books.failNext = 1;
      const told: string[] = [];
      const r = await syncAccounting({ db: b3.h.db, keyring: b3.keyring, clock: b3.clock }, b3.t, books, async (_tx, msg) => { told.push(msg); });
      expect(r).toMatchObject({ pushed: 0, failed: 1 });
      expect(told[0]).toMatch(/provider unavailable/);
      expect(await db((tx) => tx.selectFrom('accounting_sync_log').select('status').execute())).toEqual([{ status: 'failed' }]);
      expect((await syncAccounting({ db: b3.h.db, keyring: b3.keyring, clock: b3.clock }, b3.t, books)).pushed).toBe(1);
      await db((tx) => disconnectAccounting(b3, tx, connId));
      const row = await db((tx) => tx.selectFrom('accounting_connections').select(['status', 'token_enc']).where('id', '=', connId).executeTakeFirstOrThrow());
      expect(row).toEqual({ status: 'disconnected', token_enc: null });
      const key = await db((tx) => tx.selectFrom('subject_keys').select('state').where('subject_ref', '=', connId).executeTakeFirstOrThrow());
      expect(key.state).toBe('shredded');
    } finally {
      await b3.close();
    }
  });
});
