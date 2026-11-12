/**
 * Owner briefs (§78): a morning brief at 07:00 and an evening summary at 19:00, in the business's own time
 * zone. Built only from this business's own records (A5): what came in, what was sent, what is waiting for
 * the owner (each with its deadline), what happened to their earlier answers, and anything to check.
 * Every line carries the audit events behind it. Briefs are owner-facing service messages, not marketing.
 */
import { randomUUID } from 'node:crypto';
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { enqueue, type TenantTx } from '@sevari/db';
import { notify, ownerOf } from '@sevari/hitl';

export const BRIEF_JOB = 'brief.owner';
export const BRIEF_TIMES = { morning: '07:00', evening: '19:00' } as const;
export type BriefKind = keyof typeof BRIEF_TIMES;
const WINDOW_MS = 12 * 3_600_000;

export interface BriefLine {
  readonly section: 'activity' | 'waiting' | 'outcomes' | 'check';
  readonly text: string;
  /** The audit events this line is built from (A5). */
  readonly auditRefs: readonly string[];
}
export interface Brief {
  readonly kind: BriefKind;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly lines: readonly BriefLine[];
  readonly waiting: number;
}

/** Local calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
function offsetMs(ms: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p['year']), Number(p['month']) - 1, Number(p['day']), Number(p['hour']), Number(p['minute']), Number(p['second'])) - Math.floor(ms / 1000) * 1000;
}
/** The instant a local wall-clock time happens on a local date in a time zone (DST-safe). */
export function zonedInstant(date: string, hhmm: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}
/** The next brief after `nowMs`, in the business's time zone. */
export function nextBrief(nowMs: number, tz: string): { kind: BriefKind; at: number } {
  const today = localDate(nowMs, tz);
  const tomorrow = localDate(zonedInstant(today, '12:00', tz) + 86_400_000, tz);
  const candidates = [
    { kind: 'morning' as const, at: zonedInstant(today, BRIEF_TIMES.morning, tz) },
    { kind: 'evening' as const, at: zonedInstant(today, BRIEF_TIMES.evening, tz) },
    { kind: 'morning' as const, at: zonedInstant(tomorrow, BRIEF_TIMES.morning, tz) },
  ];
  const next = candidates.find((c) => c.at > nowMs);
  if (!next) throw new Error('no next brief time');
  return next;
}

async function timezoneOf(tx: TenantTx): Promise<string> {
  const r = await tx.selectFrom('regions').innerJoin('tenants', 'tenants.region', 'regions.code').select('regions.contact_rules').where('tenants.id', '=', tx.scope.tenantId).executeTakeFirst();
  const tz = (r?.contact_rules as { timezone?: unknown } | null | undefined)?.timezone;
  return typeof tz === 'string' ? tz : 'Europe/London';
}

/** Queues the next brief (idempotent). Only live businesses, and those in practice mode, get briefs. */
export async function scheduleBrief(tx: TenantTx, nowMs: number): Promise<void> {
  const t = await tx.selectFrom('tenants').select('status').where('id', '=', tx.scope.tenantId).executeTakeFirst();
  if (!t || (t.status !== 'active' && t.status !== 'shadow')) return;
  const next = nextBrief(nowMs, await timezoneOf(tx));
  await enqueue(tx, { kind: BRIEF_JOB, dedupeKey: `brief:${next.kind}:${new Date(next.at).toISOString()}`, runAt: new Date(next.at), payload: { kind: next.kind, at: next.at } });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const clockTime = (ms: number, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));

/** Builds the brief for the 12 hours up to `atMs`. Reads only this business's own rows (row-level security). */
export async function buildBrief(deps: { keyring: TenantKeyring }, tx: TenantTx, kind: BriefKind, atMs: number): Promise<Brief> {
  const tz = await timezoneOf(tx);
  const start = new Date(atMs - WINDOW_MS);
  const end = new Date(atMs);
  const events = await tx.selectFrom('audit_events').select(['id', 'event_type', 'payload'])
    .where('created_at', '>', start).where('created_at', '<=', end)
    .where('event_type', 'in', ['message.received', 'send.sent', 'input.effect', 'send.ambiguous', 'send.needs_human', 'send.failed', 'question.expired'])
    .orderBy('seq').execute();
  const of = (type: string) => events.filter((e) => e.event_type === type);
  const lines: BriefLine[] = [];
  const since = kind === 'morning' ? 'overnight' : 'today';

  const received = of('message.received');
  const sent = of('send.sent');
  lines.push(received.length || sent.length
    ? { section: 'activity', text: `${plural(received.length, 'new message', 'new messages')} from customers ${since}; ${plural(sent.length, 'reply', 'replies')} sent.`, auditRefs: [...received, ...sent].map((e) => e.id) }
    : { section: 'activity', text: `Quiet ${kind === 'morning' ? 'night' : 'day'}: no new messages from customers.`, auditRefs: [] });

  const open = await tx.selectFrom('human_questions').select(['id', 'body_enc', 'deadline_at']).where('status', '=', 'open').orderBy('deadline_at').limit(20).execute();
  const askedAudit = open.length
    ? await tx.selectFrom('audit_events').select(['id', 'subject_ref']).where('event_type', '=', 'question.asked').where('subject_ref', 'in', open.map((q) => `question:${q.id}`)).execute()
    : [];
  for (const q of open) {
    const body = JSON.parse(await deps.keyring.openText(tx, { table: 'human_questions', column: 'body_enc', rowId: q.id }, q.body_enc)) as { title?: string };
    const ref = askedAudit.find((a) => a.subject_ref === `question:${q.id}`);
    lines.push({ section: 'waiting', text: `${body.title ?? 'A decision'}: answer by ${clockTime(q.deadline_at.getTime(), tz)}.`, auditRefs: ref ? [ref.id] : [] });
  }

  const effects = of('input.effect');
  const failed = effects.filter((e) => (e.payload as { outcome?: string }).outcome === 'failed');
  if (effects.length) {
    lines.push({ section: 'outcomes', text: `${plural(effects.length - failed.length, 'of your answers was', 'of your answers were')} carried out${failed.length ? `; ${plural(failed.length, 'couldn\'t', 'couldn\'t')} be done (see Updates for why)` : ''}.`, auditRefs: effects.map((e) => e.id) });
  }
  const expired = of('question.expired');
  if (expired.length) lines.push({ section: 'outcomes', text: `${plural(expired.length, 'question', 'questions')} closed without an answer, so nothing was sent for ${expired.length === 1 ? 'it' : 'them'}.`, auditRefs: expired.map((e) => e.id) });

  const check = [...of('send.ambiguous'), ...of('send.needs_human'), ...of('send.failed')];
  if (check.length) lines.push({ section: 'check', text: `${plural(check.length, 'message needs', 'messages need')} checking: Sevari couldn't confirm ${check.length === 1 ? 'it' : 'they'} reached the customer, and never re-sends blindly.`, auditRefs: check.map((e) => e.id) });

  return { kind, periodStart: start.toISOString(), periodEnd: end.toISOString(), lines, waiting: open.length };
}

export function renderBrief(b: Brief, business: string): string {
  const title = b.kind === 'morning' ? `Good morning. Your brief for ${business}` : `Your evening summary for ${business}`;
  const block = (section: BriefLine['section'], heading: string) => {
    const ls = b.lines.filter((l) => l.section === section);
    return ls.length ? [`${heading}`, ...ls.map((l) => `• ${l.text}`)].join('\n') : null;
  };
  return [title, block('waiting', b.waiting ? `Waiting for you (${b.waiting})` : 'Waiting for you'), block('activity', 'What happened'), block('outcomes', 'Your earlier answers'), block('check', 'Please check')]
    .filter((x): x is string => x !== null).join('\n\n') + (b.waiting ? '' : '\n\nNothing needs you right now.');
}

/** Builds, stores and shows the brief in the app; returns it so the caller can email a short notice. Once per slot. */
export async function sendBrief(deps: { keyring: TenantKeyring; clock: Clock }, tx: TenantTx, kind: BriefKind, atMs: number, business: string): Promise<{ id: string; brief: Brief; ownerId: string | null } | null> {
  const b = await buildBrief(deps, tx, kind, atMs);
  const id = randomUUID();
  const inserted = await tx.insertInto('owner_reports').values({
    id, tenant_id: tx.scope.tenantId, region: tx.scope.region, kind, period_start: new Date(b.periodStart), period_end: new Date(b.periodEnd),
    metrics: JSON.stringify({ lines: b.lines.length, waiting: b.waiting, audit_refs: b.lines.reduce((n, l) => n + l.auditRefs.length, 0) }),
    body_enc: await deps.keyring.seal(tx, { table: 'owner_reports', column: 'body_enc', rowId: id }, JSON.stringify(b)),
  }).onConflict((oc) => oc.columns(['tenant_id', 'kind', 'period_start']).doNothing()).returning('id').executeTakeFirst();
  await scheduleBrief(tx, atMs + 1);
  if (!inserted) return null;
  const owner = await ownerOf(tx);
  if (owner) await notify(tx, deps.keyring, { userId: owner, kind: 'info', ref: `brief:${id}`, dedupeKey: `brief:${kind}:${b.periodEnd}`, text: renderBrief(b, business) });
  await appendAudit(tx, { type: `brief.${kind}`, actor: { kind: 'system' }, subject: `report:${id}`, payload: { lines: b.lines.length, waiting: b.waiting } });
  return { id, brief: b, ownerId: owner };
}

/** The latest brief, for the top of the owner's inbox. */
export async function latestBrief(deps: { keyring: TenantKeyring }, tx: TenantTx): Promise<(Brief & { readonly id: string }) | null> {
  const r = await tx.selectFrom('owner_reports').select(['id', 'body_enc']).where('kind', 'in', ['morning', 'evening']).orderBy('period_end', 'desc').limit(1).executeTakeFirst();
  if (!r) return null;
  return { id: r.id, ...(JSON.parse(await deps.keyring.openText(tx, { table: 'owner_reports', column: 'body_enc', rowId: r.id }, r.body_enc)) as Brief) };
}
