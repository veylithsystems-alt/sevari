import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type TenantTx } from '@sevari/db';
import { billLines, type Plan } from '@sevari/finance';
import { answer, ask, digestOf } from '@sevari/hitl';
import { authenticate, newOperatorToken, platformDecision } from '@sevari/identity';
import { cancelOffboarding, requestOffboarding } from '@sevari/privacy';
import { BILLING_RUN_JOB, billingRunHandler, finalBillHandler, startSubscription } from '@sevari/worker';
import { ownerQuery, superQuery } from '../support/fixtures.ts';
import { harness, type Harness } from '../support/hitl-harness.ts';

/** §21.1: leaving Sevari includes a final invoice, for the days used up to the end of the notice, and then nothing more. */
let house: Harness;
let founderTok: string;
const hdb = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(house.h.db, house.t, fn);

beforeAll(async () => {
  house = await harness('fin15', 153);
  await superQuery('UPDATE tenants SET is_house = true WHERE id = $1', [house.t.tenantId]);
  const tok = newOperatorToken();
  await ownerQuery('INSERT INTO operators (display_name, prefix, token_hash, role) VALUES ($1, $2, $3, $4)', ['Dan (test)', tok.prefix, tok.hash, 'founder']);
  founderTok = tok.full;
  const v1 = await platformDecision(house.h.db, (await authenticate(house.h.db, house.clock, founderTok))!, { decision: 'signoff', subjectRef: 'plans:fin15', scope: 'plans:fin15', reason: 'standard v1', expiresOn: '2027-12-31' });
  await ownerQuery(`INSERT INTO plans (region, plan_key, plan_version, name, price_minor, currency, vat_treatment, allowances, overage_per_enquiry_minor, effective_from, approval_decision_id) VALUES ('fin15','standard',1,'Standard',5900,'GBP','exclusive','{"enquiries":300,"seats":3,"channels":3}',0,'2026-01-01',$1)`, [v1]);
});
afterAll(async () => house?.close());

async function subscribed(biz: Harness, startedOn: string) {
  const m = await house.send('Hi, signing up for Sevari', `owner-${randomUUID()}@business.example`);
  const contactId = await hdb(async (tx) => (await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id').select('conversations.contact_id').where('messages.id', '=', m.messageId).executeTakeFirstOrThrow()).contact_id);
  const deps = { keyring: house.keyring, clock: house.clock, consumers: house.deps.consumers };
  const q = await hdb((tx) => ask(deps, tx, {
    kind: 'owner_task', subjectRef: `terms:${randomUUID()}`, contentDigest: digestOf({ terms: 1 }), requiredRole: 'owner',
    body: { title: 'Terms agreed', summary: 'Standard', optionLabels: { handled: 'Agreed', reply: 'x' }, safeDefaultText: '-' }, options: ['handled', 'reply'], safeDefault: 'hold',
    consumer: { kind: 'owner.task', ref: randomUUID() }, deadlineMs: 86_400_000,
  }));
  house.clock.advance(5_000);
  const r = await hdb((tx) => answer(deps, tx, { questionId: q, responderId: house.owner, response: 'handled', digestSeen: digestOf({ terms: 1 }).toString('hex'), channel: 'app' }));
  if (!r.accepted) throw new Error('terms not recorded');
  return hdb((tx) => startSubscription(tx, { businessTenantId: biz.t.tenantId, contactId, planKey: 'standard', startedOn, termsInputId: r.inputId }));
}

const plan: Plan = { planKey: 'standard', planVersion: 1, name: 'Standard', priceMinor: 5900, currency: 'GBP', vatTreatment: 'exclusive', allowances: { enquiries: 300, seats: 3, channels: 3 }, overagePerEnquiryMinor: 0 };

describe('[Phase 15] the final bill when a business leaves (§21.1)', () => {
  it('a stop date part-way through a period charges only the days up to it', () => {
    const terms = { startedOn: '2026-11-01', pilotUntil: null, foundingPriceMinor: null, foundingLockUntil: null };
    const usage = { resolvedEnquiries: 0, seats: 1, channels: 1 };
    expect(billLines(plan, terms, usage, '2026-11-01', '2026-12-01', '2026-11-16')).toEqual([{ description: 'Standard plan, 2026-11-01 to 2026-11-16 (15 of 30 days)', quantity: 1, unitMinor: 2950 }]);
    expect(billLines(plan, terms, usage, '2026-11-01', '2026-12-01', '2026-12-20')[0]).toMatchObject({ unitMinor: 5900 });
  });

  it('at the end of the notice: billed for the days used, the subscription ends, and no further period is scheduled', async () => {
    const biz = await harness('fin15', 154);
    try {
      const subId = await subscribed(biz, '2026-11-01');
      biz.clock.set(Date.parse('2026-10-17T10:00:00Z'));
      const ob = await withTenant(biz.h.db, biz.t, (tx) => requestOffboarding(biz, tx, 'owner'));
      expect(ob.noticeUntil.toISOString().slice(0, 10)).toBe('2026-11-16');
      const job = await withTenant(biz.h.db, biz.t, (tx) => tx.selectFrom('job_queue').select(['kind', 'run_at']).where('kind', '=', 'offboarding.final_bill').executeTakeFirstOrThrow());
      expect(job.run_at.toISOString()).toBe(ob.noticeUntil.toISOString());

      biz.clock.set(Date.parse('2026-11-16T10:00:00Z'));
      const deps = { db: house.h.db, keyring: house.keyring, clock: biz.clock, consumers: house.deps.consumers };
      expect(await finalBillHandler(deps).scoped(biz.t, { offboarding_id: ob.id })).toBe('final_bill_scheduled');
      const queued = await hdb((tx) => tx.selectFrom('job_queue').select('payload').where('kind', '=', BILLING_RUN_JOB).where('dedupe_key', '=', `bill:${subId}:final`).executeTakeFirstOrThrow());
      expect(queued.payload).toMatchObject({ subscription_id: subId, final_on: '2026-11-16' });

      house.clock.set(Date.parse('2026-11-16T10:00:00Z'));
      const run = billingRunHandler({ ...deps, clock: house.clock });
      expect(await run.scoped(house.t, queued.payload as Record<string, unknown>)).toBe('awaiting_approval');
      const inv = await hdb((tx) => tx.selectFrom('billing_runs').innerJoin('invoices', 'invoices.id', 'billing_runs.invoice_id').select(['invoices.net_minor', 'invoices.status']).where('billing_runs.subscription_id', '=', subId).executeTakeFirstOrThrow());
      expect(inv).toEqual({ net_minor: '2950', status: 'draft' }); // half of November, put to Veylith's owner for approval like any invoice
      const sub = await hdb((tx) => tx.selectFrom('subscriptions').select('status').where('id', '=', subId).executeTakeFirstOrThrow());
      expect(sub.status).toBe('cancelled');
      // The regular end-of-period run finds nothing to bill, and a repeat of the final run bills nothing twice.
      house.clock.set(Date.parse('2026-12-01T10:00:00Z'));
      expect(await run.scoped(house.t, { subscription_id: subId })).toBe('not_billable');
      expect(await run.scoped(house.t, queued.payload as Record<string, unknown>)).toBe('not_billable');
      expect(await hdb((tx) => tx.selectFrom('billing_runs').select('id').where('subscription_id', '=', subId).execute())).toHaveLength(1);
    } finally {
      await biz.close();
    }
  });

  it('a business that changes its mind during the notice gets no final bill and keeps its subscription', async () => {
    const biz = await harness('fin15', 155);
    try {
      const subId = await subscribed(biz, '2026-11-01');
      biz.clock.set(Date.parse('2026-10-20T10:00:00Z'));
      const ob = await withTenant(biz.h.db, biz.t, (tx) => requestOffboarding(biz, tx, 'owner'));
      expect(await withTenant(biz.h.db, biz.t, (tx) => cancelOffboarding(tx))).toBe(true);
      expect(await withTenant(biz.h.db, biz.t, (tx) => cancelOffboarding(tx))).toBe(false);
      biz.clock.set(Date.parse('2026-11-19T10:00:00Z'));
      expect(await finalBillHandler({ db: house.h.db, keyring: house.keyring, clock: biz.clock, consumers: house.deps.consumers }).scoped(biz.t, { offboarding_id: ob.id })).toBe('offboarding_cancelled');
      const sub = await hdb((tx) => tx.selectFrom('subscriptions').select('status').where('id', '=', subId).executeTakeFirstOrThrow());
      expect(sub.status).not.toBe('cancelled');
    } finally {
      await biz.close();
    }
  });
});
