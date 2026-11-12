/**
 * Metrics (§10.3) and the weekly owner report (§8.1). Everything is read through security_invoker views,
 * so a business only ever measures itself. Floors must be zero; any non-zero floor is an alert, not a
 * statistic. Numbers only: no message content leaves the encrypted columns except the "couldn't answer"
 * topics, which are the owner's own knowledge gaps.
 */
import { randomUUID } from 'node:crypto';
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { enqueue, sql, type TenantTx } from '@sevari/db';
import { notify, ownerOf } from '@sevari/hitl';

export const WEEKLY_REPORT_JOB = 'report.weekly';
const WEEK_MS = 7 * 86_400_000;

export interface WeeklyMetrics {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly enquiries: number;
  readonly acknowledged: number;
  /** People who asked to stop: deliberately not acknowledged (§50.3). */
  readonly optOuts: number;
  readonly ackP50Ms: number | null;
  readonly ackP95Ms: number | null;
  readonly ackMaxMs: number | null;
  readonly replied: number;
  readonly replyP50Minutes: number | null;
  readonly routes: Readonly<Record<string, number>>;
  readonly drafts: { readonly edited: number; readonly rejected: number; readonly expired: number };
  readonly ownerEditRate: number | null;
  readonly decisions: number;
  readonly decisionP50Minutes: number | null;
  readonly ownerMinutesPerEnquiry: number | null;
  readonly rubberStampShare: number | null;
  readonly unknownTop: readonly { readonly topic: string; readonly count: number }[];
  readonly floors: { readonly unauthorisedSends: number; readonly suppressedSends: number };
  readonly sendFailures: number;
  readonly oldestQueuedJobMinutes: number | null;
}

const pct = (xs: readonly number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? null;
};
const ms = (a: Date | string | null, b: Date | string | null) => (a && b ? new Date(b).getTime() - new Date(a).getTime() : null);
const round = (n: number | null, dp = 0) => (n === null ? null : Math.round(n * 10 ** dp) / 10 ** dp);

export async function weeklyMetrics(tx: TenantTx, start: Date, end: Date, nowMs: number): Promise<WeeklyMetrics> {
  const flow = await tx.selectFrom('metrics_enquiry_flow').selectAll().where('received_at', '>=', start).where('received_at', '<', end).execute();
  const decisions = await tx.selectFrom('metrics_decisions').selectAll().where('received_at', '>=', start).where('received_at', '<', end).where('status', '<>', 'rejected').execute();
  const unknowns = await tx.selectFrom('metrics_unknowns').select(['missing', sql<string>`count(*)`.as('n')]).where('analysed_at', '>=', start).where('analysed_at', '<', end)
    .groupBy('missing').orderBy(sql`count(*)`, 'desc').limit(5).execute();
  const floorA = await tx.selectFrom('metrics_floor_unauthorised_sends').select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow();
  const floorB = await tx.selectFrom('metrics_floor_suppressed_sends').select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow();
  const failures = await tx.selectFrom('outbox').select(sql<string>`count(*)`.as('n')).where('state', '=', 'failed').where('reserved_at', '>=', start).where('reserved_at', '<', end).executeTakeFirstOrThrow();
  const oldest = await tx.selectFrom('job_queue').select(sql<Date | null>`min(run_at)`.as('t')).where('state', '=', 'queued').where('run_at', '<=', new Date(nowMs)).executeTakeFirstOrThrow();

  const routes: Record<string, number> = {};
  for (const f of flow) routes[f.route] = (routes[f.route] ?? 0) + 1;
  const acks = flow.map((f) => ms(f.received_at, f.ack_sent_at)).filter((x): x is number => x !== null);
  const replies = flow.map((f) => ms(f.received_at, f.reply_sent_at)).filter((x): x is number => x !== null);
  const drafted = flow.filter((f) => f.first_draft_at !== null);
  const decided = decisions.filter((d) => d.kind === 'approve_draft');
  const times = decisions.map((d) => d.decision_ms).filter((x): x is number => x !== null);
  return {
    periodStart: start.toISOString(), periodEnd: end.toISOString(), enquiries: flow.length, acknowledged: acks.length, optOuts: routes['opt_out'] ?? 0,
    ackP50Ms: pct(acks, 50), ackP95Ms: pct(acks, 95), ackMaxMs: acks.length ? Math.max(...acks) : null,
    replied: replies.length, replyP50Minutes: round(pct(replies, 50) === null ? null : (pct(replies, 50) ?? 0) / 60_000, 1),
    routes, drafts: { edited: drafted.filter((f) => f.edited).length, rejected: drafted.filter((f) => f.rejected).length, expired: drafted.filter((f) => f.expired).length },
    ownerEditRate: drafted.length ? round(drafted.filter((f) => f.edited).length / drafted.length, 3) : null,
    decisions: decisions.length, decisionP50Minutes: round(pct(times, 50) === null ? null : (pct(times, 50) ?? 0) / 60_000, 1),
    ownerMinutesPerEnquiry: flow.length ? round(times.reduce((a, b) => a + Math.min(b, 10 * 60_000), 0) / 60_000 / flow.length, 2) : null,
    rubberStampShare: decided.length ? round(decided.filter((d) => d.rubber_stamp).length / decided.length, 3) : null,
    unknownTop: unknowns.map((u) => ({ topic: u.missing, count: Number(u.n) })),
    floors: { unauthorisedSends: Number(floorA.n), suppressedSends: Number(floorB.n) },
    sendFailures: Number(failures.n),
    oldestQueuedJobMinutes: oldest.t ? round((nowMs - new Date(oldest.t).getTime()) / 60_000, 1) : null,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const secs = (msv: number | null) => (msv === null ? 'n/a' : msv < 60_000 ? `${Math.max(1, Math.round(msv / 1000))} seconds` : `${Math.round(msv / 60_000)} minutes`);
const topic = (t: string) => t.replace(/^knowledge:/, '').replace(/^clarification_exhausted:/, 'unclear: ').replace(/[:_]/g, ' ');

/** The weekly report in plain English (§8.1). Numbers come from the views; nothing is invented. */
export function renderOwnerReport(m: WeeklyMetrics, business: string): string {
  const lines: string[] = [`${business}: your week with Sevari`, ''];
  if (m.floors.unauthorisedSends || m.floors.suppressedSends) {
    lines.push('⚠ Something went wrong that must never happen: a message was sent without approval, or to someone who had opted out. Veylith has been alerted and is investigating.', '');
  }
  const ackable = m.enquiries - m.optOuts;
  const missed = ackable - m.acknowledged;
  lines.push(`Enquiries: ${m.enquiries}. ${missed <= 0 ? 'Every one was acknowledged' : `${m.acknowledged} of ${ackable} were acknowledged (${missed} had no email or mobile number to reply to)`}${m.ackP95Ms !== null ? `, 95% within ${secs(m.ackP95Ms)}` : ''}.${m.optOuts ? ` ${plural(m.optOuts, 'person', 'people')} asked to stop and ${m.optOuts === 1 ? 'was' : 'were'} not messaged again.` : ''}`);
  if (m.replied) lines.push(`Replies sent: ${m.replied}. Typical time from enquiry to reply: ${m.replyP50Minutes} minutes.`);
  const needed = (m.routes['human_only'] ?? 0) + (m.routes['unknown'] ?? 0);
  if (needed) lines.push(`${plural(needed, 'enquiry', 'enquiries')} needed you personally (complaints, unusual requests, or things your records don't cover).`);
  if (m.routes['safety_first']) lines.push(`${plural(m.routes['safety_first'], 'safety message')} went out at once to someone describing a danger.`);
  if (m.decisions) lines.push(`You made ${plural(m.decisions, 'decision')}: about ${m.ownerMinutesPerEnquiry} minutes of your time per enquiry. You changed ${m.drafts.edited} of Sevari's drafts and turned down ${m.drafts.rejected}.`);
  if (m.drafts.expired) lines.push(`${plural(m.drafts.expired, 'reply', 'replies')} waited so long ${m.drafts.expired === 1 ? 'it was' : 'they were'} not sent. Tip: add someone to your approval list for when you're busy.`);
  if (m.rubberStampShare !== null && m.rubberStampShare >= 0.5) lines.push('Many approvals were made in under 2 seconds. Approvals only protect you if each message is read first.');
  if (m.unknownTop.length) {
    lines.push('', 'Customers asked about things your records don\'t cover yet. Adding them means Sevari can answer next time:');
    for (const u of m.unknownTop) lines.push(`• ${topic(u.topic)} (asked ${plural(u.count, 'time')})`);
  }
  if (m.sendFailures) lines.push('', `${plural(m.sendFailures, 'message')} could not be delivered; each one is in your inbox with what to do next.`);
  return lines.join('\n');
}

/** Monday 00:00 UTC of the week containing `ms`. */
export function weekStart(msv: number): Date {
  const d = new Date(msv);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

/** Queues the report for the end of the current week (idempotent; called as enquiries arrive). */
export async function scheduleWeeklyReport(tx: TenantTx, nowMs: number): Promise<void> {
  const end = weekStart(nowMs).getTime() + WEEK_MS;
  await enqueue(tx, { kind: WEEKLY_REPORT_JOB, dedupeKey: `weekly:${new Date(end).toISOString().slice(0, 10)}`, runAt: new Date(end), payload: { period_end: end } });
}

/** Builds, stores and delivers the report for the week ending `periodEnd`. Idempotent per week. */
export async function sendWeeklyReport(deps: { keyring: TenantKeyring; clock: Clock }, tx: TenantTx, periodEnd: number, business: string): Promise<{ id: string; metrics: WeeklyMetrics } | null> {
  const start = new Date(periodEnd - WEEK_MS);
  const done = await tx.selectFrom('owner_reports').select('id').where('kind', '=', 'weekly').where('period_start', '=', start).executeTakeFirst();
  if (done) return null;
  const m = await weeklyMetrics(tx, start, new Date(periodEnd), deps.clock.nowMs());
  const text = renderOwnerReport(m, business);
  const id = randomUUID();
  await tx.insertInto('owner_reports').values({
    id, tenant_id: tx.scope.tenantId, region: tx.scope.region, kind: 'weekly', period_start: start, period_end: new Date(periodEnd), metrics: JSON.stringify(m),
    body_enc: await deps.keyring.seal(tx, { table: 'owner_reports', column: 'body_enc', rowId: id }, text),
  }).execute();
  const owner = await ownerOf(tx);
  if (owner) await notify(tx, deps.keyring, { userId: owner, kind: 'info', ref: `report:${id}`, dedupeKey: `weekly_report:${start.toISOString()}`, text });
  await appendAudit(tx, { type: 'report.weekly', actor: { kind: 'system' }, subject: `report:${id}`, payload: { enquiries: m.enquiries, floors_ok: m.floors.unauthorisedSends + m.floors.suppressedSends === 0 } });
  await scheduleWeeklyReport(tx, periodEnd + 1);
  return { id, metrics: m };
}
export * from './brief.ts';
