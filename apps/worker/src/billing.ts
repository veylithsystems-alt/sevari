/**
 * Sevari's own billing in the worker (Lifecycle V, §19.4), run in the house tenant (Veylith's account):
 *   billing.run      at each period end: usage counters from the business's own scope (never content), the
 *                    plan in force (approved versions only), pilot and founding terms honoured, an invoice
 *                    put to Veylith's owner for approval like any invoice. Once per subscription and period.
 *   billing.dunning  overdue past the grace period: the subscription is marked past due and Dan is told.
 *                    Reminders are the invoice's own chasing (each approved).
 *   billing.suspend  after the notice period, suspends ONLY if Dan has recorded the decision (§8.3); the
 *                    database refuses a suspension without it. Sevari never suspends anyone by itself.
 */
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { enqueue, findHouseTenant, sql, withTenant, type Db, type TenantTx } from '@sevari/db';
import { ContractViolation, regionCode, tenantId, type TenantScope } from '@sevari/domain';
import { billLines, draftInvoice, formatMoney, meterUsage, moneyPortFor, nextPeriod, planOn, type PaymentProcessor } from '@sevari/finance';
import { notify, ownerOf, type ConsumerRegistry } from '@sevari/hitl';
import { askToSendInvoice } from './invoicing.ts';

export const BILLING_RUN_JOB = 'billing.run';
export const BILLING_DUNNING_JOB = 'billing.dunning';
export const BILLING_SUSPEND_JOB = 'billing.suspend';
export const FINAL_BILL_JOB = 'offboarding.final_bill';
/** Days after the due date before a subscription is past due, and the notice before any suspension. */
export const GRACE_DAYS = 14;
export const NOTICE_DAYS = 7;

export interface BillingDeps {
  readonly db: Db;
  readonly keyring: TenantKeyring;
  readonly clock: Clock;
  readonly consumers: ConsumerRegistry;
  readonly payments?: PaymentProcessor;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const at9 = (date: string) => new Date(`${date}T09:00:00Z`);

/** A subscription, with terms set by a human decision (§47: founding and pilot terms are never set by the system). */
export async function startSubscription(tx: TenantTx, s: {
  businessTenantId: string; contactId: string; planKey: string; startedOn: string; termsInputId: string;
  pilotUntil?: string; foundingPriceMinor?: number; foundingLockUntil?: string;
}): Promise<string> {
  const house = await tx.selectFrom('tenants').select('is_house').where('id', '=', tx.scope.tenantId).executeTakeFirstOrThrow();
  if (!house.is_house) throw new ContractViolation('§19.4', 'subscriptions are Veylith\'s records, kept in the house tenant');
  const period = nextPeriod(s.startedOn);
  const row = await tx.insertInto('subscriptions').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, business_tenant_id: s.businessTenantId, contact_id: s.contactId, plan_key: s.planKey,
    pilot_until: s.pilotUntil ?? null, founding_price_minor: s.foundingPriceMinor ?? null, founding_lock_until: s.foundingLockUntil ?? null,
    status: s.pilotUntil ? 'pilot' : 'active', started_on: s.startedOn, period_start: s.startedOn, period_end: period.end, terms_input_id: s.termsInputId,
  }).returning('id').executeTakeFirstOrThrow();
  await enqueue(tx, { kind: BILLING_RUN_JOB, dedupeKey: `bill:${row.id}:${period.end}`, runAt: at9(period.end), payload: { subscription_id: row.id } });
  await appendAudit(tx, { type: 'subscription.started', actor: { kind: 'user' }, subject: `subscription:${row.id}`, payload: { plan: s.planKey, pilot_until: s.pilotUntil ?? null, founding: s.foundingPriceMinor !== undefined } });
  return row.id;
}

export function billingRunHandler(deps: BillingDeps) {
  return {
    scoped: async (house: TenantScope, p: Record<string, unknown>) => {
      const subId = String(p['subscription_id']);
      const today = day(deps.clock.nowMs());
      const sub = await withTenant(deps.db, house, (tx) => tx.selectFrom('subscriptions').selectAll()
        .select([sql<string>`period_start::text`.as('ps'), sql<string>`period_end::text`.as('pe'), sql<string>`started_on::text`.as('so'), sql<string | null>`pilot_until::text`.as('pu'), sql<string | null>`founding_lock_until::text`.as('fl')])
        .where('id', '=', subId).executeTakeFirst());
      if (!sub || sub.status === 'cancelled' || sub.status === 'suspended') return 'not_billable';
      // A final bill (§21.1) stops at the end of the business's notice period, part-way through a period.
      const finalOn = typeof p['final_on'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p['final_on']) ? p['final_on'] : null;
      const end = finalOn !== null && finalOn < sub.pe ? finalOn : sub.pe;
      if (end > today) throw new Error('billing period not finished yet');
      // Counters only, read in the business's own scope (§19.4: billing never reads message content).
      const usage = await meterUsage(deps.db, { tenantId: tenantId(sub.business_tenant_id), region: regionCode(house.region) }, sub.ps, end);
      const drafted = await withTenant(deps.db, house, async (tx) => {
        const plan = await planOn(tx, sub.plan_key, sub.ps);
        if (!plan) {
          const owner = await ownerOf(tx);
          if (owner) await notify(tx, deps.keyring, { userId: owner, kind: 'warning', ref: `subscription:${subId}`, dedupeKey: `noplan:${subId}:${sub.ps}`, text: `No approved price for the "${sub.plan_key}" plan on ${sub.ps}, so nothing was billed. Approve the plan's prices first.` });
          return null;
        }
        const run = await tx.insertInto('billing_runs').values({ tenant_id: house.tenantId, region: house.region, subscription_id: subId, period_start: sub.ps, period_end: end, usage: JSON.stringify(usage) })
          .onConflict((oc) => oc.columns(['tenant_id', 'subscription_id', 'period_start']).doNothing()).returning('id').executeTakeFirst();
        if (!run && finalOn === null) return 'already' as const;
        const lines = run ? billLines(plan, { startedOn: sub.so, pilotUntil: sub.pu, foundingPriceMinor: sub.founding_price_minor === null ? null : Number(sub.founding_price_minor), foundingLockUntil: sub.fl }, usage, sub.ps, sub.pe, end) : [];
        if (finalOn !== null) {
          // The last bill: the subscription ends here, and no further period is scheduled.
          await tx.updateTable('subscriptions').set({ status: 'cancelled' }).where('id', '=', subId).execute();
          await appendAudit(tx, { type: 'subscription.ended', actor: { kind: 'system' }, subject: `subscription:${subId}`, payload: { ended_on: end, reason: 'offboarding' } });
        } else {
          const next = nextPeriod(sub.pe);
          await tx.updateTable('subscriptions').set({ period_start: next.start, period_end: next.end, ...(sub.status === 'pilot' && sub.pu && next.start >= sub.pu ? { status: 'active' } : {}) }).where('id', '=', subId).execute();
          await enqueue(tx, { kind: BILLING_RUN_JOB, dedupeKey: `bill:${subId}:${next.end}`, runAt: at9(next.end), payload: { subscription_id: subId } });
        }
        if (!run || !lines.length) return 'nothing_to_bill' as const;
        const inv = await draftInvoice(tx, { contactId: sub.contact_id, vatTreatment: plan.vatTreatment, lines: lines.map((l) => ({ ...l, sourceRef: `subscription:${subId}` })), factsUsed: [`plan:${plan.planKey}@${plan.planVersion}`] });
        await tx.updateTable('billing_runs').set({ invoice_id: inv.id }).where('id', '=', run.id).execute();
        const msg = await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id').select('messages.id')
          .where('conversations.contact_id', '=', sub.contact_id).where('messages.direction', '=', 'inbound').orderBy('messages.received_at', 'desc').executeTakeFirst();
        if (!msg) throw new ContractViolation('§19.4', 'no way to reach this business for its invoice');
        await enqueue(tx, { kind: BILLING_DUNNING_JOB, dedupeKey: `dun:${subId}:${end}`, runAt: at9(day(Date.parse(`${end}T00:00:00Z`) + (GRACE_DAYS + 14) * 86_400_000)), payload: { subscription_id: subId } });
        return { invoiceId: inv.id, total: inv.total, currency: inv.currency, service: `your Sevari ${plan.name} plan (${sub.ps} to ${end})${finalOn !== null ? ', final bill' : ''}`, vat: plan.vatTreatment, messageId: msg.id };
      });
      if (!drafted || typeof drafted === 'string') return drafted ?? 'no_plan';
      let link: { providerLinkId: string; url: string; provider: string } | null = null;
      if (deps.payments) {
        const port = await withTenant(deps.db, house, (tx) => moneyPortFor(tx, deps.payments as PaymentProcessor));
        link = await port.createPaymentLink({ reference: drafted.invoiceId, amountMinor: drafted.total, currency: drafted.currency, description: 'Sevari subscription' });
      }
      return withTenant(deps.db, house, (tx) => askToSendInvoice(deps, tx, { ...drafted, link }));
    },
  };
}

/** Overdue beyond the grace period: past due, Dan told what he may decide. Never suspends anything. */
export async function dunningCheck(deps: BillingDeps, tx: TenantTx, p: Record<string, unknown>): Promise<string> {
  const subId = String(p['subscription_id']);
  const today = day(deps.clock.nowMs());
  const sub = await tx.selectFrom('subscriptions').select(['id', 'status', 'contact_id', 'business_tenant_id']).where('id', '=', subId).executeTakeFirst();
  if (!sub || sub.status === 'cancelled' || sub.status === 'suspended') return 'not_applicable';
  const overdue = await tx.selectFrom('invoices').select(['id', 'number', sql<string>`total_minor - paid_minor`.as('due'), sql<string>`due_on::text`.as('due_on'), 'currency'])
    .where('contact_id', '=', sub.contact_id).where('status', 'in', ['issued', 'part_paid']).where(sql<boolean>`due_on + ${GRACE_DAYS} * interval '1 day' < ${today}::date`).execute();
  if (!overdue.length) {
    if (sub.status === 'past_due') await tx.updateTable('subscriptions').set({ status: 'active' }).where('id', '=', subId).execute();
    return 'up_to_date';
  }
  if (sub.status !== 'past_due') await tx.updateTable('subscriptions').set({ status: 'past_due' }).where('id', '=', subId).execute();
  const noticeEnds = day(deps.clock.nowMs() + NOTICE_DAYS * 86_400_000);
  const owner = await ownerOf(tx);
  const amount = overdue.reduce((a, i) => a + Number(i.due), 0);
  if (owner) {
    await notify(tx, deps.keyring, { userId: owner, kind: 'warning', ref: `subscription:${subId}`, dedupeKey: `pastdue:${subId}:${overdue.map((i) => i.id).join(',')}`,
      text: `A business is ${GRACE_DAYS}+ days overdue: ${formatMoney(amount, overdue[0]?.currency ?? 'GBP')} unpaid (${overdue.map((i) => i.number).join(', ')}). Reminders continue, each with your approval. Sevari will never suspend them by itself: if you decide to, record a suspension decision for business ${sub.business_tenant_id}; it takes effect no earlier than ${noticeEnds}, after the notice period.` });
  }
  await enqueue(tx, { kind: BILLING_SUSPEND_JOB, dedupeKey: `suspend:${subId}:${noticeEnds}`, runAt: at9(noticeEnds), payload: { subscription_id: subId } });
  return 'past_due';
}

/** After the notice period: suspends only with Dan's recorded decision, and only if still unpaid. */
export function suspendHandler(deps: BillingDeps) {
  return {
    scoped: async (house: TenantScope, p: Record<string, unknown>) => {
      const subId = String(p['subscription_id']);
      const sub = await withTenant(deps.db, house, (tx) => tx.selectFrom('subscriptions').select(['business_tenant_id', 'status']).where('id', '=', subId).executeTakeFirst());
      if (!sub || sub.status !== 'past_due') return 'not_past_due';
      const business = { tenantId: tenantId(sub.business_tenant_id), region: regionCode(house.region) };
      const decided = await withTenant(deps.db, house, (tx) => tx.selectFrom('platform_decisions').select('id').where('scope', '=', `tenant:${sub.business_tenant_id}:suspension`)
        .where('decision', '=', 'signoff').where('approver_role', '=', 'founder').where(sql<boolean>`expires_on >= current_date`).executeTakeFirst());
      if (!decided) {
        await withTenant(deps.db, house, async (tx) => {
          const owner = await ownerOf(tx);
          if (owner) await notify(tx, deps.keyring, { userId: owner, kind: 'info', ref: `subscription:${subId}`, dedupeKey: `suspend-wait:${subId}:${day(deps.clock.nowMs())}`, text: 'The notice period has ended. The business has not been suspended, because suspension needs your recorded decision.' });
        });
        return 'awaiting_decision';
      }
      await withTenant(deps.db, business, async (tx) => {
        await tx.updateTable('tenants').set({ status: 'suspended' }).where('id', '=', business.tenantId).execute();
        await appendAudit(tx, { type: 'tenant.suspended', actor: { kind: 'operator', ref: `decision:${decided.id}` }, subject: `tenant:${business.tenantId}`, payload: { reason: 'non_payment' } });
      });
      await withTenant(deps.db, house, (tx) => tx.updateTable('subscriptions').set({ status: 'suspended' }).where('id', '=', subId).execute());
      return 'suspended';
    },
  };
}

/**
 * At the end of a business's notice period (§21.1): unless they changed their mind, their Sevari subscription
 * gets its final bill, for the days used, and ends. Runs in the business's scope; the bill is Veylith's record.
 */
export function finalBillHandler(deps: BillingDeps) {
  return {
    scoped: async (business: TenantScope, p: Record<string, unknown>) => {
      const ob = await withTenant(deps.db, business, (tx) => tx.selectFrom('tenant_offboardings').select(['id', 'status', sql<string>`notice_until::date::text`.as('end_on')])
        .where('id', '=', String(p['offboarding_id'])).executeTakeFirst());
      if (!ob || ob.status === 'cancelled') return 'offboarding_cancelled';
      const house = await findHouseTenant(deps.db, business.region);
      if (!house) return 'no_house_account';
      return withTenant(deps.db, house, async (tx) => {
        const sub = await tx.selectFrom('subscriptions').select('id').where('business_tenant_id', '=', business.tenantId).where('status', '<>', 'cancelled').executeTakeFirst();
        if (!sub) return 'no_subscription';
        await enqueue(tx, { kind: BILLING_RUN_JOB, dedupeKey: `bill:${sub.id}:final`, runAt: deps.clock.now(), payload: { subscription_id: sub.id, final_on: ob.end_on } });
        return 'final_bill_scheduled';
      });
    },
  };
}
