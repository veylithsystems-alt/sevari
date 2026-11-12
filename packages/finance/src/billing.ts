/**
 * Sevari's own billing (Lifecycle V, §19.4, §47). Pure pricing from versioned plan data, and usage read
 * only as counters (never message content). Pilot terms and the founding-rate lock are honoured
 * automatically; a price change is a data change with an approval record, never code.
 */
import { sql, withTenant, type Db, type TenantTx } from '@sevari/db';
import type { TenantScope } from '@sevari/domain';
import type { VatTreatment } from './money.ts';

export interface Plan {
  readonly planKey: string;
  readonly planVersion: number;
  readonly name: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly vatTreatment: VatTreatment;
  readonly allowances: { readonly enquiries: number; readonly seats: number; readonly channels: number };
  readonly overagePerEnquiryMinor: number;
}

/** The approved plan version in force on a date. Unapproved versions are never used. */
export async function planOn(tx: TenantTx, planKey: string, onDate: string): Promise<Plan | null> {
  const p = await tx.selectFrom('plans').selectAll().where('plan_key', '=', planKey).where('approval_decision_id', 'is not', null)
    .where('effective_from', '<=', onDate as never).orderBy('effective_from', 'desc').orderBy('plan_version', 'desc').executeTakeFirst();
  if (!p) return null;
  return {
    planKey: p.plan_key, planVersion: p.plan_version, name: p.name, priceMinor: Number(p.price_minor), currency: p.currency, vatTreatment: p.vat_treatment,
    allowances: p.allowances as unknown as Plan['allowances'], overagePerEnquiryMinor: Number(p.overage_per_enquiry_minor),
  };
}

export interface Usage { readonly resolvedEnquiries: number; readonly seats: number; readonly channels: number }

/**
 * Usage for one business and period, read in that business's own scope: counts only. A resolved enquiry is
 * one that got a reply sent. Nothing here can see what anyone wrote.
 */
export async function meterUsage(db: Db, business: TenantScope, start: string, end: string): Promise<Usage> {
  return withTenant(db, business, async (tx) => {
    const n = async (q: Promise<{ n: string } | undefined>) => Number((await q)?.n ?? 0);
    return {
      resolvedEnquiries: await n(tx.selectFrom('reply_records').select(sql<string>`count(DISTINCT enquiry_id)`.as('n')).where('purpose', '=', 'reply').where('send_result', '=', 'sent')
        .where('created_at', '>=', new Date(`${start}T00:00:00Z`)).where('created_at', '<', new Date(`${end}T00:00:00Z`)).executeTakeFirst()),
      seats: await n(tx.selectFrom('users').select(sql<string>`count(*)`.as('n')).where('role', 'in', ['owner', 'approver']).executeTakeFirst()),
      channels: await n(tx.selectFrom('channel_endpoints').select(sql<string>`count(*)`.as('n')).where('status', '=', 'active').executeTakeFirst()),
    };
  });
}

export interface Terms { readonly startedOn: string; readonly pilotUntil: string | null; readonly foundingPriceMinor: number | null; readonly foundingLockUntil: string | null }
export interface BillLine { readonly description: string; readonly quantity: number; readonly unitMinor: number }

const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** The lines for one period: the plan (or founding rate, or pilot), prorated for a part period, plus overage. */
export function billLines(plan: Plan, terms: Terms, usage: Usage, periodStart: string, periodEnd: string, stopOn?: string): BillLine[] {
  // A final bill (§21.1) stops part-way through a period: charged for the days up to the stop date only.
  const until = stopOn !== undefined && stopOn < periodEnd ? stopOn : periodEnd;
  if (terms.pilotUntil && periodEnd <= terms.pilotUntil) return [];
  const founding = terms.foundingPriceMinor !== null && terms.foundingLockUntil !== null && periodStart < terms.foundingLockUntil;
  const base = founding ? terms.foundingPriceMinor ?? plan.priceMinor : plan.priceMinor;
  const billedFrom = [terms.startedOn, terms.pilotUntil ?? '0000-01-01', periodStart].sort().at(-1) ?? periodStart;
  const total = days(periodStart, periodEnd);
  const used = Math.max(0, days(billedFrom, until));
  const lines: BillLine[] = [];
  const amount = used >= total ? base : Math.round((base * used) / total);
  const label = `${plan.name} plan${founding ? ' (founding rate)' : ''}, ${periodStart} to ${until}${used < total ? ` (${used} of ${total} days)` : ''}`;
  if (amount > 0) lines.push({ description: label, quantity: 1, unitMinor: amount });
  const over = Math.max(0, usage.resolvedEnquiries - plan.allowances.enquiries);
  if (over > 0 && plan.overagePerEnquiryMinor > 0) lines.push({ description: `Enquiries beyond the ${plan.allowances.enquiries} included`, quantity: over, unitMinor: plan.overagePerEnquiryMinor });
  return lines;
}

/** The next monthly period after one that ends on `end`. */
export function nextPeriod(end: string): { start: string; end: string } {
  const d = new Date(`${end}T00:00:00Z`);
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
  return { start: end, end: n.toISOString().slice(0, 10) };
}
