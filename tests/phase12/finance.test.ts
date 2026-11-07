import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, withTenant, type TenantTx } from '@sevari/db';
import { ContractViolation } from '@sevari/domain';
import {
  AUTO_APPLY_THRESHOLD, draftInvoice, FakePaymentProcessor, formatMoney, importLines, issueInvoice, moneyPortFor, post, processorTotals,
  reconcile, recordPaymentEvent, trialBalance, vatSplit,
} from '@sevari/finance';
import { journeyOf } from '@sevari/lifecycle';
import { runTimer } from '@sevari/worker';
import { contractSuite } from '../support/contract.ts';
import { draftFor, harness, type Harness } from '../support/hitl-harness.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
let x: Harness;
const payments = new FakePaymentProcessor();
const db = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(x.h.db, x.t, fn);

beforeAll(async () => {
  x = await harness('fin12', 121, undefined, 'drainage', { payments });
  const now = await db(async (tx) => (await tx.selectNoFrom((eb) => eb.fn<Date>('clock_timestamp', []).as('now')).executeTakeFirstOrThrow()).now);
  x.clock.set(new Date(now).getTime());
});
afterAll(async () => x?.close());

/** A customer with an issued invoice, for the ledger and reconciliation tests. */
async function issued(amountMinor: number, name = 'Casey Jones') {
  const m = await x.send('Hello', `p-${randomUUID()}@example.com`);
  const contactId = await db(async (tx) => (await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id').select('conversations.contact_id').where('messages.id', '=', m.messageId).executeTakeFirstOrThrow()).contact_id);
  await db(async (tx) => tx.updateTable('contacts').set({}).where('id', '=', contactId).execute()).catch(() => undefined);
  void name;
  return db(async (tx) => {
    const d = await draftInvoice(tx, { contactId, vatTreatment: 'inclusive', lines: [{ description: 'drain unblocking', quantity: 1, unitMinor: amountMinor }], factsUsed: [] });
    const { number } = await issueInvoice(x, tx, d.id);
    return { id: d.id, number, total: d.total, contactId };
  });
}

describe('[Phase 12] money arithmetic', () => {
  it('VAT is split once per invoice, in whole pennies, from the owner\'s own VAT status', () => {
    expect(vatSplit(9500, 'inclusive', 2000)).toEqual({ net: 7917, vat: 1583, total: 9500 });
    expect(vatSplit(10000, 'exclusive', 2000)).toEqual({ net: 10000, vat: 2000, total: 12000 });
    expect(vatSplit(9500, 'not_registered', 2000)).toEqual({ net: 9500, vat: 0, total: 9500 });
    expect(() => vatSplit(10.5, 'inclusive', 2000)).toThrow(/whole minor units/);
    expect(formatMoney(9500)).toBe('£95.00');
  });
});

contractSuite('F15', () => {
  it('every posting balances; an unbalanced one is refused by the code and, at commit, by the database', async () => {
    await expect(db((tx) => post(tx, { kind: 'adjustment', ref: 'x', currency: 'GBP', occurredAt: x.clock.now(), idempotencyKey: `k:${randomUUID()}`, lines: [{ account: 'bank', direction: 'debit', amountMinor: 100 }, { account: 'revenue', direction: 'credit', amountMinor: 99 }] })))
      .rejects.toBeInstanceOf(ContractViolation);
    // Straight into the tables, around the code: the database refuses it when the transaction commits.
    await expect(db(async (tx) => {
      const t = await tx.insertInto('ledger_transactions').values({ tenant_id: x.t.tenantId, region: x.t.region, kind: 'adjustment', ref: 'forged', currency: 'GBP', occurred_at: x.clock.now(), idempotency_key: `forged:${randomUUID()}` }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('ledger_entries').values({ tenant_id: x.t.tenantId, region: x.t.region, transaction_id: t.id, account: 'bank', direction: 'debit', amount_minor: 500 }).execute();
    })).rejects.toThrow(/does not balance/);
    await issued(9500);
    const tb = await db((tx) => trialBalance(tx));
    expect(Object.values(tb).reduce((a, b) => a + b, 0)).toBe(0);
    // Append-only: nothing in the ledger can be changed or removed.
    await expect(db((tx) => tx.updateTable('ledger_entries').set({ account: 'bank' } as never).execute())).rejects.toThrow(/permission denied/);
    await expect(db((tx) => tx.deleteFrom('ledger_entries').execute())).rejects.toThrow(/permission denied/);
  });

  it('an issued invoice never changes, and its number is gapless', async () => {
    const a = await issued(1000);
    const b = await issued(2000);
    expect(Number(b.number.slice(4))).toBe(Number(a.number.slice(4)) + 1);
    await expect(db((tx) => tx.updateTable('invoices').set({ number: 'INV-99999' }).where('id', '=', a.id).execute())).rejects.toThrow(/never change/);
  });
});

contractSuite('F16', () => {
  it('the same processor event, or the same bank line, twice gives one effect', async () => {
    const inv = await issued(5000);
    const ev = { provider: 'fakepay', providerEventId: `evt_${randomUUID()}`, kind: 'payment_succeeded' as const, invoiceId: inv.id, amountMinor: 5000, feeMinor: 95, currency: 'GBP', occurredAt: x.clock.now() };
    const first = await db((tx) => recordPaymentEvent(tx, ev));
    const second = await db((tx) => recordPaymentEvent(tx, ev));
    const third = await Promise.all([1, 2, 3].map(() => db((tx) => recordPaymentEvent(tx, ev)).catch((e: Error) => e.message)));
    expect(first.status).toBe('recorded');
    expect(second.status).toBe('duplicate');
    expect(third.every((t) => typeof t !== 'string' || /duplicate key/.test(t))).toBe(true);
    const status = await db((tx) => tx.selectFrom('invoices').select(['status', 'paid_minor']).where('id', '=', inv.id).executeTakeFirstOrThrow());
    expect(status).toEqual({ status: 'paid', paid_minor: '5000' });
    const posted = await db((tx) => tx.selectFrom('ledger_transactions').select('id').where('ref', '=', ev.providerEventId).execute());
    expect(posted).toHaveLength(2); // the payment and its fee, once each
    const line = { source: 'bank' as const, externalId: `bank_${randomUUID()}`, amountMinor: 1234, currency: 'GBP', bookedOn: '2026-11-01', reference: 'unknown' };
    expect(await db((tx) => importLines(tx, [line, line]))).toEqual({ added: 1, duplicates: 1 });
    expect(await db((tx) => importLines(tx, [line]))).toEqual({ added: 0, duplicates: 1 });
  });
});

contractSuite('F17', () => {
  it('only exact or high-confidence, full-amount matches are applied automatically; everything else waits for a person', async () => {
    const byRef = await issued(7000);
    const byAmount = await issued(4321);
    const fuzzy = await issued(10000);
    const today = x.clock.now().toISOString().slice(0, 10);
    await db((tx) => importLines(tx, [
      { source: 'bank', externalId: `b1_${randomUUID()}`, amountMinor: 7000, currency: 'GBP', bookedOn: today, reference: `Payment ${byRef.number} thanks` },
      { source: 'bank', externalId: `b2_${randomUUID()}`, amountMinor: 4321, currency: 'GBP', bookedOn: today, reference: 'BACS' },
      { source: 'bank', externalId: `b3_${randomUUID()}`, amountMinor: 9950, currency: 'GBP', bookedOn: today, reference: 'transfer' },
      { source: 'bank', externalId: `b4_${randomUUID()}`, amountMinor: 3, currency: 'GBP', bookedOn: today, reference: 'interest' },
    ]));
    await db((tx) => reconcile(x, tx));
    const rows = await db((tx) => tx.selectFrom('recon_matches').select(['invoice_id', 'rule', 'confidence', 'status', 'outcome']).execute());
    const of = (id: string) => rows.find((r) => r.invoice_id === id);
    expect(of(byRef.id)).toMatchObject({ rule: 'exact_reference', status: 'auto_applied', outcome: 'matched' });
    expect(of(byAmount.id)).toMatchObject({ rule: 'amount_date', status: 'suggested' });
    expect(of(fuzzy.id)).toMatchObject({ rule: 'fuzzy', status: 'suggested' });
    expect(rows.some((r) => r.invoice_id === null && r.outcome === 'unmatched')).toBe(true);
    for (const r of rows.filter((r) => r.status === 'auto_applied')) expect(Number(r.confidence)).toBeGreaterThanOrEqual(AUTO_APPLY_THRESHOLD);
    expect((await db((tx) => tx.selectFrom('invoices').select('status').where('id', '=', byAmount.id).executeTakeFirstOrThrow())).status).toBe('issued');
    // The database itself refuses an automatic application below the threshold.
    const line = await db((tx) => tx.selectFrom('recon_lines').select('id').executeTakeFirstOrThrow());
    await expect(db((tx) => tx.insertInto('recon_matches').values({ tenant_id: x.t.tenantId, region: x.t.region, line_id: line.id, invoice_id: byAmount.id, rule: 'amount_date', confidence: 0.8, outcome: 'matched', evidence: '{}', status: 'auto_applied' }).execute()))
      .rejects.toThrow(/check constraint/);
  });
});

contractSuite('F18', () => {
  it('on a fixture of payments, fees, a refund and a payout, the processor\'s totals equal the ledger\'s', async () => {
    const before = await db((tx) => processorTotals(tx));
    const invs = [await issued(9500), await issued(8500), await issued(7500)];
    const at = x.clock.now();
    const evs = [
      ...invs.map((i, n) => ({ provider: 'fakepay', providerEventId: `f18_pay_${n}_${randomUUID()}`, kind: 'payment_succeeded' as const, invoiceId: i.id, amountMinor: i.total, feeMinor: 20 + n, currency: 'GBP', occurredAt: at })),
      { provider: 'fakepay', providerEventId: `f18_ref_${randomUUID()}`, kind: 'refund_succeeded' as const, invoiceId: invs[2]!.id, amountMinor: 1500, currency: 'GBP', occurredAt: at },
      { provider: 'fakepay', providerEventId: `f18_po_${randomUUID()}`, kind: 'payout' as const, amountMinor: 20000, currency: 'GBP', occurredAt: at },
    ];
    for (const e of evs) await db((tx) => recordPaymentEvent(tx, e));
    for (const e of evs) await db((tx) => recordPaymentEvent(tx, e)); // replayed: no change
    const after = await db((tx) => processorTotals(tx));
    expect(after.processor.collected - before.processor.collected).toBe(25500);
    expect(after.processor.fees - before.processor.fees).toBe(63);
    expect(after.processor.balance).toBe(after.ledgerClearing);
    const tb = await db((tx) => trialBalance(tx));
    expect(Object.values(tb).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

contractSuite('F14', () => {
  it('in the default (direct) mode, no payout, transfer or balance operation can happen', async () => {
    const proc = new FakePaymentProcessor();
    const port = await db((tx) => moneyPortFor(tx, proc));
    expect(port.mode).toBe('direct');
    await expect(port.platform().createPayout({ amountMinor: 100, currency: 'GBP', reference: 'x' })).rejects.toThrow(/F14/);
    await expect(port.platform().createTransfer({ amountMinor: 100, currency: 'GBP', destination: 'acct', reference: 'x' })).rejects.toThrow(/F14/);
    await expect(port.platform().adjustBalance({ amountMinor: 100, currency: 'GBP', reason: 'x' })).rejects.toThrow(/F14/);
    expect(proc.calls).toEqual([]);
    // The app can't switch a business to platform mode, and the database won't accept it without a sign-off.
    await expect(db((tx) => tx.updateTable('tenants').set({ money_mode: 'platform_signed_off' } as never).where('id', '=', x.t.tenantId).execute())).rejects.toThrow(/platform decision|check constraint/);
  });

  it('static: platform money operations are named only behind the locked port', () => {
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        if (e === 'node_modules') continue;
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('money-port.ts') && /\b(createPayout|createTransfer|adjustBalance)\s*\(/.test(readFileSync(p, 'utf8'))) offenders.push(p.replace(ROOT + '/', ''));
      }
    };
    walk(join(ROOT, 'packages'));
    walk(join(ROOT, 'apps'));
    expect(offenders).toEqual([]);
  });
});

describe('[Phase 12] end to end: job done → invoice approved and issued → paid', () => {
  it('a fixed-price job is invoiced from the owner\'s price, with a payment link, issued only when the owner approves', async () => {
    const who = `inv-${randomUUID()}@example.com`;
    const m1 = await x.send('Can you come and unblock a drain? CH65 2AB', who);
    const d1 = await draftFor(x, (await x.process(m1.messageId)).enquiryId);
    const ok = async (draftId: string) => {
      const q = await x.question(`draft:${draftId}`);
      x.clock.advance(5_000);
      expect((await x.answer({ questionId: q!.id, responderId: x.owner, response: 'approve', digestSeen: q!.digest })).accepted).toBe(true);
      await x.drain();
    };
    await ok(d1!.id);
    const m2 = await x.send('The first one please', who);
    const d2 = await draftFor(x, (await x.process(m2.messageId)).enquiryId);
    await ok(d2!.id);
    const contactId = await db(async (tx) => (await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id').select('conversations.contact_id').where('messages.id', '=', m2.messageId).executeTakeFirstOrThrow()).contact_id);
    const j = await db((tx) => journeyOf(tx, contactId));
    const timer = await db((tx) => tx.selectFrom('lifecycle_timers').select(['id', 'fires_at']).where('subject_id', '=', j!.id).where('status', '=', 'pending').executeTakeFirstOrThrow());
    x.clock.set(timer.fires_at.getTime() + 1_000);
    await db((tx) => runTimer(x, tx, timer.id));
    await x.drain();
    const q = await x.question(`lifecycle:${j!.id}`);
    x.clock.advance(5_000);
    await x.answer({ questionId: q!.id, responderId: x.owner, response: 'job_done', digestSeen: q!.digest });
    await x.drain();
    const inv = await db((tx) => tx.selectFrom('invoices').selectAll().where('contact_id', '=', contactId).executeTakeFirstOrThrow());
    expect(inv).toMatchObject({ status: 'draft', number: null, total_minor: '9500', vat_minor: '1583', vat_treatment: 'inclusive' });
    const draftId = inv.send_draft_id!;
    const preview = await db(async (tx) => (await tx.selectFrom('drafts').select('action_class').where('id', '=', draftId).executeTakeFirstOrThrow()).action_class);
    expect(preview).toBe('invoice_send');
    await ok(draftId);
    const issuedInv = await db((tx) => tx.selectFrom('invoices').select(['status', 'number', 'due_on']).where('id', '=', inv.id).executeTakeFirstOrThrow());
    expect(issuedInv.status).toBe('issued');
    expect(issuedInv.number).toMatch(/^INV-\d{5}$/);
    const sent = [...x.provider.accepted.values()].map((v) => v.env.text).at(-1);
    expect(sent).toMatch(/Your invoice for blocked drain is £95\.00 including VAT/);
    expect(sent).toMatch(/https:\/\/pay\.fakepay\.example\/l\/\d+/);
    // The customer pays through the link: the invoice is paid and the ledger balances.
    await db((tx) => recordPaymentEvent(tx, { provider: 'fakepay', providerEventId: `evt_${randomUUID()}`, kind: 'payment_succeeded', invoiceId: inv.id, amountMinor: 9500, feeMinor: 160, currency: 'GBP', occurredAt: x.clock.now() }));
    expect((await db((tx) => tx.selectFrom('invoices').select('status').where('id', '=', inv.id).executeTakeFirstOrThrow())).status).toBe('paid');
    const tb = await db((tx) => trialBalance(tx));
    expect(Object.values(tb).reduce((a, b) => a + b, 0)).toBe(0);
    void sql;
  });
});
