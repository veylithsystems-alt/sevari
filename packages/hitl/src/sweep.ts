/**
 * The clock that keeps human questions moving (§30.6, §74.3–4, §82). Run every minute by the worker.
 *   1. Escalation: an unanswered question moves to the next person in the owner's order. The owner is
 *      told. Never approved by the timeout (F57, F54).
 *   2. Reply due: while an approval is still open at the customer's promised reply time, the consumer
 *      may send one deterministic holding update (F53).
 *   3. Deadline: the question closes to its declared safe default; the consumer's onExpired runs (F24).
 *   4. Missing receipts: an applied input without a receipt past its SLA raises an alert (F23).
 *   5. Rubber-stamping: a pattern of instant approvals produces a warning to the owner (F27).
 */
import { appendAudit } from '@sevari/audit';
import type { TenantTx } from '@sevari/db';
import { notify, ownerOf } from './notify.ts';
import { MAX_CLARIFICATIONS, scheduleSweep, type HitlDeps } from './questions.ts';

export interface SweepReport { escalated: number; replyDue: number; expired: number; receiptAlerts: number; rubberStampWarnings: number }

const RUBBER_STAMP_WINDOW = 10;
const RUBBER_STAMP_MIN = 5;

const SAFE_DEFAULT_TEXT = {
  hold: 'Nothing was sent. It is on hold until someone decides.',
  reask: 'Nothing was sent. You will be asked again.',
  escalate: 'Nothing was sent. It has been passed on for a decision.',
  fail_closed: 'Nothing was sent, and this request has been closed.',
} as const;

export async function sweep(deps: HitlDeps, tx: TenantTx): Promise<SweepReport> {
  const now = deps.clock.nowMs();
  const nowD = new Date(now);
  const report: SweepReport = { escalated: 0, replyDue: 0, expired: 0, receiptAlerts: 0, rubberStampWarnings: 0 };
  const owner = await ownerOf(tx);

  // 1. Escalation in the owner's order.
  const due = await tx.selectFrom('human_questions').selectAll().where('status', '=', 'open').where('next_escalation_at', '<=', nowD).forUpdate().skipLocked().execute();
  for (const q of due) {
    const routes = await tx.selectFrom('approval_routes').innerJoin('users', 'users.id', 'approval_routes.user_id')
      .select(['approval_routes.position', 'approval_routes.user_id', 'approval_routes.after_minutes', 'users.role', 'users.status'])
      .where('approval_routes.position', '>', q.escalation_level).orderBy('approval_routes.position').execute();
    const eligible = [];
    for (const r of routes) {
      if (r.status !== 'active' || r.role === 'viewer') continue;
      if (q.required_role === 'owner' && r.role !== 'owner') continue;
      if (r.role === 'approver') {
        const ok = q.action_class ? await tx.selectFrom('user_permissions').select('id').where('user_id', '=', r.user_id).where('action_class', '=', q.action_class).where('revoked_at', 'is', null).executeTakeFirst() : null;
        if (!ok) continue;
      }
      eligible.push(r);
    }
    const next = eligible[0];
    const after = eligible[1];
    const tooAmbiguous = q.clarifications >= MAX_CLARIFICATIONS;
    if (next) {
      await tx.updateTable('human_questions').set({ assigned_user_id: next.user_id, escalation_level: next.position, next_escalation_at: after ? new Date(now + after.after_minutes * 60_000) : null }).where('id', '=', q.id).execute();
      if (after) await scheduleSweep(tx, now + after.after_minutes * 60_000);
      await notify(tx, deps.keyring, { userId: next.user_id, kind: 'question', ref: `question:${q.id}`, dedupeKey: `question:${q.id}:${next.position}`, text: 'A decision is waiting for you (passed on because it had no answer yet).' });
      if (owner) await notify(tx, deps.keyring, { userId: owner, kind: 'escalation', ref: `question:${q.id}`, dedupeKey: `escalated:${q.id}:${next.position}`, text: `No answer yet${tooAmbiguous ? ' (the replies so far were unclear)' : ''}, so it has also been passed to the next person on your list. Nothing has been sent.` });
      await appendAudit(tx, { type: 'question.escalated', actor: { kind: 'system' }, subject: `question:${q.id}`, payload: { to_position: next.position, reason: tooAmbiguous ? 'ambiguous' : 'timeout' } });
      report.escalated++;
    } else {
      await tx.updateTable('human_questions').set({ next_escalation_at: null }).where('id', '=', q.id).execute();
      if (owner) await notify(tx, deps.keyring, { userId: owner, kind: 'escalation', ref: `question:${q.id}`, dedupeKey: `escalated:${q.id}:end`, text: 'This is still waiting for a decision and there is nobody else on your list to ask. Nothing has been sent.' });
    }
  }

  // 2. The customer's reply time has passed while the approval is still open.
  const replyDue = await tx.selectFrom('human_questions').selectAll().where('status', '=', 'open').where('reply_due_at', '<=', nowD).forUpdate().skipLocked().execute();
  for (const q of replyDue) {
    await tx.updateTable('human_questions').set({ reply_due_at: null }).where('id', '=', q.id).execute();
    await deps.consumers[q.consumer_kind]?.onReplyDue?.(tx, q);
    report.replyDue++;
  }

  // 3. Deadline: close to the safe default. Never approve.
  const expired = await tx.selectFrom('human_questions').selectAll().where('status', '=', 'open').where('deadline_at', '<=', nowD).forUpdate().skipLocked().execute();
  for (const q of expired) {
    await tx.updateTable('human_questions').set({ status: 'expired', closed_reason: `safe_default:${q.safe_default}`, next_escalation_at: null, reply_due_at: null }).where('id', '=', q.id).execute();
    await deps.consumers[q.consumer_kind]?.onExpired?.(tx, q);
    if (owner) await notify(tx, deps.keyring, { userId: owner, kind: 'info', ref: `question:${q.id}`, dedupeKey: `expired:${q.id}`, text: `A decision passed its deadline without an answer. ${SAFE_DEFAULT_TEXT[q.safe_default]}` });
    await appendAudit(tx, { type: 'question.expired', actor: { kind: 'system' }, subject: `question:${q.id}`, payload: { safe_default: q.safe_default } });
    report.expired++;
  }

  // 4. Inputs applied without a receipt in time (INV-13).
  const late = await tx.selectFrom('human_inputs').select(['id', 'responder_id']).where('status', '=', 'pending_effect').where('effect_due_at', '<=', nowD).where('alerted_at', 'is', null).execute();
  for (const i of late) {
    await tx.updateTable('human_inputs').set({ alerted_at: nowD }).where('id', '=', i.id).execute();
    for (const u of new Set([i.responder_id, owner].filter((x): x is string => Boolean(x)))) {
      await notify(tx, deps.keyring, { userId: u, kind: 'alert', ref: `input:${i.id}`, dedupeKey: `receipt_late:${i.id}:${u}`, text: 'Something you approved has not been confirmed as done yet. It is being checked; nothing will be sent twice.' });
    }
    await appendAudit(tx, { type: 'input.receipt_overdue', actor: { kind: 'system' }, subject: `input:${i.id}`, payload: {} });
    report.receiptAlerts++;
  }

  // 5. Rubber-stamping (§30.6): 5 or more of a person's last 10 decisions made in under 2 seconds.
  const since = new Date(now - 30 * 86_400_000);
  const recent = await tx.selectFrom('human_inputs').select(['responder_id', 'rubber_stamp', 'received_at'])
    .where('status', 'in', ['pending_effect', 'applied', 'failed']).where('received_at', '>=', since).orderBy('received_at', 'desc').execute();
  const lastTen = new Map<string, boolean[]>();
  for (const r of recent) {
    const xs = lastTen.get(r.responder_id) ?? [];
    if (xs.length < RUBBER_STAMP_WINDOW) xs.push(r.rubber_stamp);
    lastTen.set(r.responder_id, xs);
  }
  const day = new Date(now).toISOString().slice(0, 10);
  for (const [userId, xs] of lastTen) {
    const fast = xs.filter(Boolean).length;
    if (fast >= RUBBER_STAMP_MIN) {
      const sent = await notify(tx, deps.keyring, { userId: owner ?? userId, kind: 'warning', ref: `user:${userId}`, dedupeKey: `rubber_stamp:${userId}:${day}`,
        text: `${fast} of the last ${xs.length} approvals were made in under 2 seconds. Approvals only protect you if each message is read first.` });
      if (sent) report.rubberStampWarnings++;
    }
  }
  return report;
}
