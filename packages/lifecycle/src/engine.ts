/**
 * The lifecycle engine (§16). One generic engine runs both lifecycles: V (Veylith → tenant, on the
 * house tenant) and T (tenant → end customer). Every transition is:
 *   - idempotent: (subject, idempotency key) is unique, so a replayed event is one transition;
 *   - serialised per subject (row lock + unique seq), so racing events produce one winner per step;
 *   - audited, region-scoped (row-level security), and pinned to the definition version it ran on;
 *   - authorised: a step with an action class goes through the autonomy policy (§7), a human step needs
 *     a person's recorded answer (§8.3). Nothing bypasses it, and a clock never authorises anything.
 * Effects (asking the owner, notifying, closing a booking) are queued in the same transaction and run
 * after commit, each once.
 */
import { appendAudit } from '@sevari/audit';
import { decide } from '@sevari/autonomy';
import type { Clock } from '@sevari/clock';
import { enqueue, type LifecycleSubjectRow, type TenantTx, type TransitionAuthority } from '@sevari/db';
import { ContractViolation, isActionClass } from '@sevari/domain';
import { transitionFor, type Effect, type LifecycleDefinition } from './definition.ts';

export const TIMER_JOB = 'lifecycle.timer';
export const EFFECT_JOB = 'lifecycle.effect';

export type Authority =
  | { readonly kind: 'system' }
  | { readonly kind: 'approval'; readonly approvalId: string }
  | { readonly kind: 'grant'; readonly grantId: string }
  | { readonly kind: 'human'; readonly inputId: string };

export type Facts = Readonly<Record<string, boolean | string | number>>;
export type Anchors = Readonly<Record<string, string | number>>;

export interface FireInput {
  readonly event: string;
  /** Same key → same transition, however many times the event arrives. */
  readonly idempotencyKey: string;
  /** Who or what caused it, for the record (ids only): 'system', 'user:<id>', 'customer:<message id>'. */
  readonly actor: string;
  readonly authority?: Authority;
  /** Facts the definition's guards may read. A guard whose fact is missing does not pass (fail closed). */
  readonly facts?: Facts;
  /** Merged into the subject's anchors when the step happens (times as epoch ms, ids as strings). */
  readonly anchors?: Anchors;
}

export type FireResult =
  | { readonly status: 'moved'; readonly transitionId: string; readonly from: string; readonly to: string; readonly seq: number; readonly effects: readonly Effect[] }
  | { readonly status: 'replayed'; readonly transitionId: string; readonly to: string }
  | { readonly status: 'ignored'; readonly reason: 'no_transition' | 'guard' | 'missing_fact' }
  | { readonly status: 'needs_authority'; readonly reason: 'human' | 'approval'; readonly actionClass?: string };

export interface EngineDeps { readonly clock: Clock }

/** The journey for this person, started at the initial state if it doesn't exist yet. */
export async function ensureSubject(deps: EngineDeps, tx: TenantTx, def: LifecycleDefinition, contactId: string): Promise<LifecycleSubjectRow> {
  const found = await tx.selectFrom('lifecycle_subjects').selectAll().where('lifecycle', '=', def.id).where('contact_id', '=', contactId).executeTakeFirst();
  if (found) return found;
  const now = deps.clock.now();
  const row = await tx.insertInto('lifecycle_subjects').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, lifecycle: def.id, definition_version: def.version, definition_hash: def.hash,
    subject_type: def.subject_type, contact_id: contactId, state: def.initial, state_entered_at: now,
  }).onConflict((oc) => oc.columns(['tenant_id', 'lifecycle', 'contact_id']).doNothing()).returningAll().executeTakeFirst();
  if (!row) return tx.selectFrom('lifecycle_subjects').selectAll().where('lifecycle', '=', def.id).where('contact_id', '=', contactId).executeTakeFirstOrThrow();
  await tx.insertInto('lifecycle_transitions').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, subject_id: row.id, seq: 1, from_state: null, to_state: def.initial, event: 'started',
    authority: 'system', idempotency_key: 'start', actor: 'system', definition_version: def.version, definition_hash: def.hash, occurred_at: now,
  }).execute();
  await appendAudit(tx, { type: 'lifecycle.started', actor: { kind: 'system' }, subject: `lifecycle:${row.id}`, payload: { lifecycle: def.id, version: def.version, state: def.initial } });
  await scheduleTimers(tx, def, row.id, def.initial, 1, now.getTime(), {});
  return row;
}

export async function fire(deps: EngineDeps, tx: TenantTx, def: LifecycleDefinition, subjectId: string, input: FireInput): Promise<FireResult> {
  const replay = await tx.selectFrom('lifecycle_transitions').select(['id', 'to_state']).where('subject_id', '=', subjectId).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
  if (replay) return { status: 'replayed', transitionId: replay.id, to: replay.to_state };
  const s = await tx.selectFrom('lifecycle_subjects').selectAll().where('id', '=', subjectId).forUpdate().executeTakeFirst();
  if (!s) throw new ContractViolation('§16', `lifecycle subject ${subjectId} not found for this tenant`);
  if (s.lifecycle !== def.id) throw new ContractViolation('§16', `subject ${subjectId} runs ${s.lifecycle}, not ${def.id}`);
  if (!def.states[s.state]) throw new ContractViolation('§16', `state "${s.state}" is not in ${def.id} v${def.version}: the subject needs a recorded migration`);
  // A racing duplicate may have committed while we waited for the lock.
  const raced = await tx.selectFrom('lifecycle_transitions').select(['id', 'to_state']).where('subject_id', '=', subjectId).where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
  if (raced) return { status: 'replayed', transitionId: raced.id, to: raced.to_state };

  const t = transitionFor(def, s.state, input.event);
  if (!t) return { status: 'ignored', reason: 'no_transition' };
  if (t.guard) {
    const v = input.facts?.[t.guard.fact];
    if (v === undefined) return { status: 'ignored', reason: 'missing_fact' };
    if (v !== t.guard.equals) return { status: 'ignored', reason: 'guard' };
  }

  const auth = await authorise(tx, subjectId, t.human, t.action_class, input.authority ?? { kind: 'system' });
  if (!auth.ok) return { status: 'needs_authority', reason: auth.reason, ...(t.action_class ? { actionClass: t.action_class } : {}) };

  const now = deps.clock.now();
  const seq = s.state_seq + 1;
  const anchors = { ...s.anchors, ...(input.anchors ?? {}) };
  const tr = await tx.insertInto('lifecycle_transitions').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, subject_id: subjectId, seq, from_state: s.state, to_state: t.to, event: input.event,
    action_class: t.action_class ?? null, authority: auth.authority, authority_ref: auth.ref, idempotency_key: input.idempotencyKey, actor: input.actor,
    definition_version: def.version, definition_hash: def.hash, occurred_at: now,
  }).returning('id').executeTakeFirstOrThrow();
  await tx.updateTable('lifecycle_subjects').set({
    state: t.to, state_seq: seq, state_entered_at: now, anchors: JSON.stringify(anchors), definition_version: def.version, definition_hash: def.hash,
  }).where('id', '=', subjectId).execute();
  // Leaving a state cancels its timers; entering one sets its own.
  await tx.updateTable('lifecycle_timers').set({ status: 'cancelled', settled_at: now }).where('subject_id', '=', subjectId).where('status', '=', 'pending').execute();
  await scheduleTimers(tx, def, subjectId, t.to, seq, now.getTime(), anchors);
  for (let i = 0; i < t.effects.length; i++) {
    await enqueue(tx, { kind: EFFECT_JOB, dedupeKey: `effect:${tr.id}:${i}`, payload: { subject_id: subjectId, transition_id: tr.id, lifecycle: def.id, index: i } });
  }
  await appendAudit(tx, {
    type: 'lifecycle.transition', actor: auth.authority === 'human' || auth.authority === 'approval' ? { kind: 'user', ref: input.actor } : { kind: 'system', ref: input.actor },
    subject: `lifecycle:${subjectId}`,
    payload: { lifecycle: def.id, version: def.version, from: s.state, to: t.to, event: input.event, seq, authority: auth.authority, ...(t.action_class ? { action_class: t.action_class } : {}) },
  });
  return { status: 'moved', transitionId: tr.id, from: s.state, to: t.to, seq, effects: t.effects };
}

type AuthCheck = { ok: true; authority: TransitionAuthority; ref: string | null } | { ok: false; reason: 'human' | 'approval' };

async function authorise(tx: TenantTx, subjectId: string, human: boolean, actionClass: string | undefined, a: Authority): Promise<AuthCheck> {
  const humanOk = async (inputId: string) => {
    const i = await tx.selectFrom('human_inputs').innerJoin('human_questions', 'human_questions.id', 'human_inputs.question_id')
      .select(['human_inputs.id', 'human_inputs.status', 'human_questions.subject_ref'])
      .where('human_inputs.id', '=', inputId).executeTakeFirst();
    return Boolean(i && i.status !== 'rejected' && i.subject_ref === `lifecycle:${subjectId}`);
  };
  const approvalOk = async (approvalId: string) => {
    const r = await tx.selectFrom('approvals').select(['id', 'action_class']).where('id', '=', approvalId).where('consumed_at', 'is not', null).executeTakeFirst();
    return Boolean(r && (!actionClass || r.action_class === actionClass));
  };
  if (human) {
    if (a.kind === 'human' && (await humanOk(a.inputId))) return { ok: true, authority: 'human', ref: `input:${a.inputId}` };
    if (a.kind === 'approval' && (await approvalOk(a.approvalId))) return { ok: true, authority: 'approval', ref: `approval:${a.approvalId}` };
    return { ok: false, reason: 'human' };
  }
  if (actionClass) {
    if (!isActionClass(actionClass)) throw new ContractViolation('§7.2', `unknown action class ${actionClass}`);
    const d = await decide(tx, actionClass);
    if (d.mode === 'automatic') return { ok: true, authority: 'automatic', ref: null };
    if (a.kind === 'approval' && (await approvalOk(a.approvalId))) return { ok: true, authority: 'approval', ref: `approval:${a.approvalId}` };
    if (a.kind === 'human' && (await humanOk(a.inputId))) return { ok: true, authority: 'human', ref: `input:${a.inputId}` };
    if (a.kind === 'grant' && d.mode === 'granted' && d.grantId === a.grantId) return { ok: true, authority: 'grant', ref: `grant:${a.grantId}` };
    return { ok: false, reason: 'approval' };
  }
  if (a.kind === 'system') return { ok: true, authority: 'system', ref: null };
  // A step that needs no authority may still record the person or approval that caused it.
  return { ok: true, authority: a.kind, ref: a.kind === 'human' ? `input:${a.inputId}` : a.kind === 'approval' ? `approval:${a.approvalId}` : `grant:${a.grantId}` };
}

async function scheduleTimers(tx: TenantTx, def: LifecycleDefinition, subjectId: string, state: string, seq: number, enteredMs: number, anchors: Anchors): Promise<void> {
  for (const tm of def.states[state]?.timers ?? []) {
    const base = tm.anchor === 'entered' ? enteredMs : toMs(anchors[tm.anchor]);
    if (base === null) throw new ContractViolation('§16', `${def.id}: state "${state}" times "${tm.event}" from "${tm.anchor}", which this subject doesn't have`);
    const firesAt = new Date(base + tm.after_minutes * 60_000);
    const row = await tx.insertInto('lifecycle_timers').values({
      tenant_id: tx.scope.tenantId, region: tx.scope.region, subject_id: subjectId, state_seq: seq, event: tm.event, fires_at: firesAt,
    }).onConflict((oc) => oc.columns(['tenant_id', 'subject_id', 'state_seq', 'event']).doNothing()).returning('id').executeTakeFirst();
    if (row) await enqueue(tx, { kind: TIMER_JOB, dedupeKey: `timer:${row.id}`, runAt: firesAt, payload: { timer_id: row.id } });
  }
}

const toMs = (v: string | number | undefined): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const n = Date.parse(v); return Number.isNaN(n) ? null : n; }
  return null;
};

/**
 * A timer fires its event only if the subject is still exactly where it was when the timer was set
 * (same seq). Otherwise it is stale and does nothing. Idempotent per timer.
 */
export async function fireTimer(deps: EngineDeps, tx: TenantTx, defs: ReadonlyMap<string, LifecycleDefinition>, timerId: string): Promise<string> {
  const tm = await tx.selectFrom('lifecycle_timers').selectAll().where('id', '=', timerId).forUpdate().executeTakeFirst();
  if (!tm) return 'not_found';
  if (tm.status !== 'pending') return tm.status;
  const now = deps.clock.now();
  if (now.getTime() < tm.fires_at.getTime()) throw new Error('timer not due yet');
  const s = await tx.selectFrom('lifecycle_subjects').select(['id', 'lifecycle', 'state_seq']).where('id', '=', tm.subject_id).executeTakeFirstOrThrow();
  const def = defs.get(s.lifecycle);
  if (!def) throw new ContractViolation('§16', `no definition loaded for ${s.lifecycle}`);
  if (s.state_seq !== tm.state_seq) {
    await tx.updateTable('lifecycle_timers').set({ status: 'stale', settled_at: now }).where('id', '=', timerId).execute();
    return 'stale';
  }
  const r = await fire(deps, tx, def, s.id, { event: tm.event, idempotencyKey: `timer:${timerId}`, actor: 'system:timer' });
  // fire() cancels pending timers when it moves; mark this one fired either way.
  await tx.updateTable('lifecycle_timers').set({ status: r.status === 'moved' || r.status === 'replayed' ? 'fired' : 'stale', settled_at: now }).where('id', '=', timerId).execute();
  return r.status;
}

/** Picks the definition for a tenant: Lifecycle V on the house tenant, Lifecycle T everywhere else. */
export async function definitionFor(tx: TenantTx, defs: ReadonlyMap<string, LifecycleDefinition>): Promise<LifecycleDefinition> {
  const t = await tx.selectFrom('tenants').select('is_house').where('id', '=', tx.scope.tenantId).executeTakeFirstOrThrow();
  const want = t.is_house ? 'V' : 'T';
  const d = [...defs.values()].find((x) => x.lifecycle === want);
  if (!d) throw new ContractViolation('§16', `no Lifecycle ${want} definition loaded`);
  return d;
}

/** Where a person's journey is, for the owner's view and for tests. */
export async function journeyOf(tx: TenantTx, contactId: string) {
  return tx.selectFrom('lifecycle_subjects').select(['id', 'lifecycle', 'state', 'state_seq', 'state_entered_at', 'anchors']).where('contact_id', '=', contactId).executeTakeFirst();
}

export const transitionsOf = (tx: TenantTx, subjectId: string) =>
  tx.selectFrom('lifecycle_transitions').select(['seq', 'from_state', 'to_state', 'event', 'action_class', 'authority', 'authority_ref', 'idempotency_key'])
    .where('subject_id', '=', subjectId).orderBy('seq').execute();

