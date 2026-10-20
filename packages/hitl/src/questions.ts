/**
 * Structured questions to humans and their answers (§30, §74, §82; INV-12 to INV-16).
 *
 *   ask()            records a question with its consumer, options, safe default, deadline and the role
 *                    allowed to answer, and puts it in the assignee's inbox.
 *   answer()         validates a response (role and permission, open, not stale, not past deadline, a
 *                    known option), records it, ACKNOWLEDGES it at once on its channel, and hands it to
 *                    the consumer. A response that fails validation is recorded as rejected and the
 *                    human is told why and what happens instead. Nothing is ever inferred.
 *   completeEffect() writes the effect receipt and tells the human the outcome (or the failure).
 *
 * Silence, timeouts, ambiguity, the wrong role and stale answers never become an approval (F24, F54).
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { enqueue, type QuestionKind, type QuestionRow, type SafeDefault, type TenantTx } from '@sevari/db';
import { canonicalJson, ContractViolation } from '@sevari/domain';
import { notify, ownerOf } from './notify.ts';

/** Decisions faster than this are not treated as a considered approval (§30.6, F27). */
export const RUBBER_STAMP_MS = 2_000;
/** After this many ambiguous answers, the question escalates rather than guessing (§30.4). */
export const MAX_CLARIFICATIONS = 2;
/** An applied input must have its receipt within this time, or an alert fires (INV-13, F23). */
export const EFFECT_SLA_MS = 15 * 60_000;

/** The sweep job (sweep.ts) runs at every time something might become due; idempotent per minute. */
export const SWEEP_JOB = 'hitl.sweep';
export async function scheduleSweep(tx: TenantTx, atMs: number): Promise<void> {
  const minute = Math.ceil(atMs / 60_000);
  await enqueue(tx, { kind: SWEEP_JOB, dedupeKey: `sweep:${minute}`, runAt: new Date(minute * 60_000), maxAttempts: 10 });
}

export const digestOf = (v: unknown): Buffer => createHash('sha256').update(canonicalJson(v)).digest();

export interface QuestionBody {
  readonly title: string;
  /** What the human needs to decide, in plain English. */
  readonly summary: string;
  /** For drafts: the exact text that would be sent. */
  readonly preview?: string;
  readonly facts?: readonly string[];
  /** Label per option, in the same order as `options`. */
  readonly optionLabels: Readonly<Record<string, string>>;
  readonly safeDefaultText: string;
}

export interface AskSpec {
  readonly kind: QuestionKind;
  readonly subjectRef: string;
  readonly actionClass?: string;
  /** The content the answer binds to (INV-15). */
  readonly contentDigest: Buffer;
  readonly body: QuestionBody;
  readonly options: readonly string[];
  readonly safeDefault: SafeDefault;
  readonly consumer: { readonly kind: string; readonly ref: string };
  readonly requiredRole: 'owner' | 'approver';
  readonly deadlineMs: number;
  /** When the customer was promised a reply (§74.4 holding update). */
  readonly replyDueAt?: Date;
  readonly assignTo?: string;
  /** The customer this question is about: its text is sealed with their key (erasure, §6.3). */
  readonly subjectContactId?: string | null;
}

/** A consumer turns an accepted answer into an effect (INV-12). Registered by kind. */
export interface ConsumerContext {
  readonly tx: TenantTx;
  readonly question: QuestionRow;
  readonly inputId: string;
  readonly response: string;
  readonly detail: string | null;
  readonly responderId: string;
}
export type ConsumerResult =
  | { readonly status: 'done'; readonly effectKind: string; readonly effectRef: string; readonly outcomeText: string }
  | { readonly status: 'failed'; readonly effectKind: string; readonly effectRef: string; readonly outcomeText: string }
  /** The effect completes later (e.g. after a provider accepts a send); completeEffect() finishes it. */
  | { readonly status: 'pending' };
export interface Consumer {
  /** The acknowledgement shown the moment the answer is accepted (§74.1). */
  ack(response: string): string;
  apply(ctx: ConsumerContext): Promise<ConsumerResult>;
  /** What happens when the deadline passes unanswered: never an approval (INV-14). */
  onExpired?(tx: TenantTx, question: QuestionRow): Promise<void>;
  /** The customer's reply time passed while this was still open (§74.4). */
  onReplyDue?(tx: TenantTx, question: QuestionRow): Promise<void>;
}
export type ConsumerRegistry = Readonly<Record<string, Consumer>>;

export interface HitlDeps {
  readonly keyring: TenantKeyring;
  readonly clock: Clock;
  readonly consumers: ConsumerRegistry;
}

const field = (column: string, rowId: string) => ({ table: 'human_questions', column, rowId });

export async function ask(deps: HitlDeps, tx: TenantTx, spec: AskSpec): Promise<string> {
  if (!deps.consumers[spec.consumer.kind]) throw new ContractViolation('INV-12', `no consumer registered for ${spec.consumer.kind}`);
  if (!spec.options.length) throw new ContractViolation('§30.3', 'a question needs options');
  const owner = await ownerOf(tx);
  const assignee = spec.assignTo ?? owner;
  if (!assignee) throw new ContractViolation('§82', 'tenant has no active owner to ask');
  const now = deps.clock.nowMs();
  const firstRoute = await tx.selectFrom('approval_routes').select(['after_minutes']).orderBy('position').executeTakeFirst();
  const id = randomUUID();
  await tx.insertInto('human_questions').values({
    id, tenant_id: tx.scope.tenantId, region: tx.scope.region, kind: spec.kind, subject_ref: spec.subjectRef, action_class: spec.actionClass ?? null,
    content_digest: spec.contentDigest, body_enc: await deps.keyring.seal(tx, { ...field('body_enc', id), subject: spec.subjectContactId ?? null }, JSON.stringify(spec.body)),
    subject_contact_id: spec.subjectContactId ?? null,
    options: [...spec.options], safe_default: spec.safeDefault, consumer_kind: spec.consumer.kind, consumer_ref: spec.consumer.ref,
    required_role: spec.requiredRole, assigned_user_id: assignee,
    next_escalation_at: firstRoute ? new Date(now + firstRoute.after_minutes * 60_000) : null,
    reply_due_at: spec.replyDueAt ?? null, deadline_at: new Date(now + spec.deadlineMs), presented_at: new Date(now),
  }).execute();
  await notify(tx, deps.keyring, { userId: assignee, kind: 'question', ref: `question:${id}`, dedupeKey: `question:${id}:0`, text: `${spec.body.title}. ${spec.body.summary}`, subjectContactId: spec.subjectContactId ?? null });
  for (const at of [firstRoute ? now + firstRoute.after_minutes * 60_000 : null, spec.replyDueAt?.getTime() ?? null, now + spec.deadlineMs]) {
    if (at !== null) await scheduleSweep(tx, at);
  }
  await appendAudit(tx, { type: 'question.asked', actor: { kind: 'system' }, subject: `question:${id}`, payload: { kind: spec.kind, consumer: spec.consumer.kind, safe_default: spec.safeDefault, required_role: spec.requiredRole } });
  return id;
}

export interface AnswerInput {
  readonly questionId: string;
  readonly responderId: string;
  readonly response: string;
  /** Hex digest of the content the human was shown (INV-15). */
  readonly digestSeen: string;
  readonly detail?: string;
  readonly channel: 'app' | 'email' | 'sms' | 'api';
}

export type AnswerResult =
  | { readonly accepted: true; readonly inputId: string; readonly ack: string; readonly outcome?: string }
  | { readonly accepted: false; readonly inputId: string | null; readonly reason: RejectReason; readonly ack: string };

export type RejectReason = 'not_found' | 'unknown_user' | 'wrong_role' | 'not_permitted' | 'closed' | 'stale' | 'expired' | 'ambiguous' | 'no_consumer';

const REJECT_TEXT: Record<RejectReason, string> = {
  not_found: 'That question no longer exists. Nothing was changed.',
  unknown_user: 'That sign-in is not allowed to answer for this business. Nothing was changed.',
  wrong_role: 'Only the business owner can answer this one. Nothing was changed, and it is still waiting for them.',
  not_permitted: 'You have not been given permission to approve this kind of message. Nothing was changed, and the owner has been told.',
  closed: 'This has already been dealt with. Nothing more was changed.',
  stale: 'The details changed after you looked, so your answer was not used. Please look again at the latest version.',
  expired: 'This question had passed its deadline, so nothing was sent. It went to its safe option instead.',
  ambiguous: 'Sorry, that answer wasn\'t one of the options, so nothing was changed. Please pick one of the options.',
  no_consumer: 'This answer has nothing to act on, so it was not used. The team has been alerted.',
};

export async function answer(deps: HitlDeps, tx: TenantTx, a: AnswerInput): Promise<AnswerResult> {
  const nowMs = deps.clock.nowMs();
  const q = await tx.selectFrom('human_questions').selectAll().where('id', '=', a.questionId).forUpdate().executeTakeFirst();
  if (!q) return { accepted: false, inputId: null, reason: 'not_found', ack: REJECT_TEXT.not_found };
  const user = await tx.selectFrom('users').select(['id', 'role', 'status']).where('id', '=', a.responderId).executeTakeFirst();
  if (!user || user.status !== 'active') return { accepted: false, inputId: null, reason: 'unknown_user', ack: REJECT_TEXT.unknown_user };

  const reject = async (reason: RejectReason): Promise<AnswerResult> => {
    const inputId = await recordInput(deps, tx, q, a, user.role, nowMs, { status: 'rejected', rejectionReason: reason });
    await notify(tx, deps.keyring, { userId: user.id, kind: 'ack', ref: `input:${inputId}`, dedupeKey: `ack:${inputId}`, text: REJECT_TEXT[reason] });
    if (reason === 'not_permitted') {
      const owner = await ownerOf(tx);
      if (owner && owner !== user.id) await notify(tx, deps.keyring, { userId: owner, kind: 'warning', ref: `input:${inputId}`, dedupeKey: `not_permitted:${inputId}`, text: 'A team member tried to approve something they do not have permission for. Nothing was changed.' });
    }
    await appendAudit(tx, { type: 'input.rejected', actor: { kind: 'user', ref: user.id }, subject: `question:${q.id}`, payload: { reason, kind: q.kind } });
    return { accepted: false, inputId, reason, ack: REJECT_TEXT[reason] };
  };

  // Role and permission (§30.5, §82, F26, F55).
  if (user.role === 'viewer') return reject('wrong_role');
  if (q.required_role === 'owner' && user.role !== 'owner') return reject('wrong_role');
  if (user.role === 'approver') {
    const permitted = q.action_class
      ? await tx.selectFrom('user_permissions').select('id').where('user_id', '=', user.id).where('action_class', '=', q.action_class).where('revoked_at', 'is', null).executeTakeFirst()
      : null;
    if (!permitted) return reject('not_permitted');
  }
  if (q.status !== 'open') return reject('closed');
  if (q.deadline_at.getTime() <= nowMs) return reject('expired');
  if (!/^[0-9a-f]{64}$/.test(a.digestSeen) || !Buffer.from(a.digestSeen, 'hex').equals(q.content_digest)) return reject('stale');
  if (!q.options.includes(a.response)) {
    const n = q.clarifications + 1;
    await tx.updateTable('human_questions').set({ clarifications: n, ...(n >= MAX_CLARIFICATIONS ? { next_escalation_at: new Date(nowMs) } : {}) }).where('id', '=', q.id).execute();
    if (n >= MAX_CLARIFICATIONS) await scheduleSweep(tx, nowMs);
    return reject('ambiguous');
  }
  const consumer = deps.consumers[q.consumer_kind];
  if (!consumer) return reject('no_consumer');

  const inputId = await recordInput(deps, tx, q, a, user.role, nowMs, { status: 'pending_effect', consumedBy: `${q.consumer_kind}:${q.consumer_ref}` });
  await tx.updateTable('human_questions').set({ status: 'answered', closed_reason: a.response }).where('id', '=', q.id).execute();
  // Acknowledge at once, on the channel it came from (§74.1, F51).
  const ackText = consumer.ack(a.response);
  await notify(tx, deps.keyring, { userId: user.id, kind: 'ack', ref: `input:${inputId}`, dedupeKey: `ack:${inputId}`, text: ackText });
  await appendAudit(tx, { type: 'input.accepted', actor: { kind: 'user', ref: user.id }, subject: `question:${q.id}`, payload: { kind: q.kind, response: a.response, channel: a.channel } });

  const result = await consumer.apply({ tx, question: q, inputId, response: a.response, detail: a.detail ?? null, responderId: user.id });
  if (result.status === 'pending') return { accepted: true, inputId, ack: ackText };
  await completeEffect(deps, tx, inputId, { effectKind: result.effectKind, effectRef: result.effectRef, outcome: result.status === 'done' ? 'done' : 'failed', text: result.outcomeText });
  return { accepted: true, inputId, ack: ackText, outcome: result.outcomeText };
}

async function recordInput(deps: HitlDeps, tx: TenantTx, q: { id: string; kind: string; presented_at: Date; subject_contact_id: string | null }, a: AnswerInput, role: string, nowMs: number,
  s: { status: 'rejected' | 'pending_effect'; rejectionReason?: string; consumedBy?: string }): Promise<string> {
  const id = randomUUID();
  const decisionMs = Math.max(0, nowMs - q.presented_at.getTime());
  await tx.insertInto('human_inputs').values({
    id, tenant_id: tx.scope.tenantId, region: tx.scope.region, question_id: q.id, kind: q.kind, response: a.response.slice(0, 40),
    detail_enc: a.detail ? await deps.keyring.seal(tx, { table: 'human_inputs', column: 'detail_enc', rowId: id, subject: q.subject_contact_id }, a.detail) : null,
    response_digest: /^[0-9a-f]{64}$/.test(a.digestSeen) ? Buffer.from(a.digestSeen, 'hex') : Buffer.alloc(32),
    responder_id: a.responderId, responder_role: role, channel: a.channel, received_at: new Date(nowMs), decision_ms: decisionMs,
    rubber_stamp: s.status === 'pending_effect' && decisionMs < RUBBER_STAMP_MS, status: s.status,
    rejection_reason: s.rejectionReason ?? null, consumed_by: s.consumedBy ?? null,
    effect_due_at: s.status === 'pending_effect' ? new Date(nowMs + EFFECT_SLA_MS) : null,
  }).execute();
  if (s.status === 'pending_effect') await scheduleSweep(tx, nowMs + EFFECT_SLA_MS);
  return id;
}

/** Writes the receipt for an applied input and tells the human the outcome (INV-13, §74.2). Idempotent. */
export async function completeEffect(deps: { keyring: TenantKeyring }, tx: TenantTx, inputId: string,
  r: { effectKind: string; effectRef: string; outcome: 'done' | 'failed'; text: string; detail?: Record<string, string | number | boolean> }): Promise<boolean> {
  const input = await tx.selectFrom('human_inputs').select(['id', 'status', 'responder_id', 'effect_receipt_id']).where('id', '=', inputId).forUpdate().executeTakeFirst();
  if (!input || input.status !== 'pending_effect') return false;
  const receipt = await tx.insertInto('effect_receipts').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, input_id: inputId, effect_kind: r.effectKind, effect_ref: r.effectRef, outcome: r.outcome, detail: JSON.stringify(r.detail ?? {}),
  }).returning('id').executeTakeFirstOrThrow();
  await tx.updateTable('human_inputs').set({ status: r.outcome === 'done' ? 'applied' : 'failed', effect_receipt_id: receipt.id }).where('id', '=', inputId).execute();
  await notify(tx, deps.keyring, { userId: input.responder_id, kind: r.outcome === 'done' ? 'outcome' : 'failure', ref: `input:${inputId}`, dedupeKey: `outcome:${inputId}`, text: r.text });
  await appendAudit(tx, { type: 'input.effect', actor: { kind: 'system' }, subject: `input:${inputId}`, payload: { effect: r.effectKind, ref: r.effectRef, outcome: r.outcome } });
  return true;
}
