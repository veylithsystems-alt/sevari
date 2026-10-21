/**
 * Journeys in the worker (§16): which lifecycle a tenant runs, the events the rest of Sevari feeds it,
 * the human steps it asks for, and its timers and effects.
 *
 *   journeyEvent()     ensure the person's journey exists, then fire one event (idempotent by key).
 *   lifecycle.step     the consumer for a journey's questions: the person's answer IS the event, and
 *                      their recorded answer is its authority (§8.3 steps need exactly that).
 *   lifecycle.timer    a timer fires only if the journey is still where it was when it was set.
 *   lifecycle.effect   ask the owner, notify the owner, or close the booking: each once.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import type { TenantTx } from '@sevari/db';
import { ContractViolation, slotPhrase } from '@sevari/domain';
import { ask, digestOf, notify, ownerOf, type Consumer, type ConsumerRegistry } from '@sevari/hitl';
import { snapshotAt } from '@sevari/knowledge';
import { defineLifecycle, definitionFor, ensureSubject, fire, fireTimer, type FireInput, type FireResult, type LifecycleDefinition } from '@sevari/lifecycle';
import { localSlot } from './bookings.ts';

export type Lifecycles = ReadonlyMap<string, LifecycleDefinition>;

export interface JourneyDeps {
  readonly keyring: TenantKeyring;
  readonly clock: Clock;
  /** The cell's lifecycle definitions (config/lifecycles). Defaults to the repository's own. */
  readonly lifecycles?: Lifecycles;
}

const DEFAULT_DIR = resolve(import.meta.dirname, '..', '..', '..', 'config', 'lifecycles');
let cached: Lifecycles | undefined;
/** The definitions shipped with this build, validated once (the boot check validates them too). */
export function defaultLifecycles(): Lifecycles {
  if (!cached) {
    const m = new Map<string, LifecycleDefinition>();
    for (const f of readdirSync(DEFAULT_DIR).filter((x) => x.endsWith('.yaml')).sort()) {
      const d = defineLifecycle(parse(readFileSync(join(DEFAULT_DIR, f), 'utf8')));
      m.set(d.id, d);
    }
    cached = m;
  }
  return cached;
}
export const lifecyclesOf = (deps: { readonly lifecycles?: Lifecycles }): Lifecycles => deps.lifecycles ?? defaultLifecycles();

export const STEP_CONSUMER = 'lifecycle.step';

/** Fires one event on a person's journey (creating the journey on first contact). */
export async function journeyEvent(deps: JourneyDeps, tx: TenantTx, contactId: string, input: FireInput): Promise<FireResult> {
  const defs = lifecyclesOf(deps);
  const def = await definitionFor(tx, defs);
  const s = await ensureSubject(deps, tx, def, contactId);
  const r = await fire(deps, tx, def, s.id, input);
  if (r.status === 'moved') await supersedeSteps(tx, s.id);
  return r;
}

/** A journey that moved on makes its open questions moot: they close, so nobody answers a stale one. */
async function supersedeSteps(tx: TenantTx, subjectId: string): Promise<void> {
  await tx.updateTable('human_questions').set({ status: 'superseded', closed_reason: 'journey_moved_on', next_escalation_at: null, reply_due_at: null })
    .where('kind', '=', 'lifecycle_step').where('subject_ref', '=', `lifecycle:${subjectId}`).where('status', '=', 'open').execute();
}

const labelOf = (def: LifecycleDefinition, state: string) => def.states[state]?.label ?? state.replace(/_/g, ' ');

export function journeyConsumers(deps: JourneyDeps): Record<string, Consumer> {
  return {
    [STEP_CONSUMER]: {
      ack: () => 'Got it. Recording that now.',
      async apply(ctx) {
        const subjectId = ctx.question.consumer_ref;
        const s = await ctx.tx.selectFrom('lifecycle_subjects').select(['id', 'lifecycle']).where('id', '=', subjectId).executeTakeFirst();
        const def = s ? lifecyclesOf(deps).get(s.lifecycle) : undefined;
        if (!s || !def) return { status: 'failed', effectKind: 'lifecycle.transition', effectRef: `lifecycle:${subjectId}`, outcomeText: 'That record no longer exists, so nothing changed.' };
        const r = await fire(deps, ctx.tx, def, s.id, {
          event: ctx.response, idempotencyKey: `input:${ctx.inputId}`, actor: `user:${ctx.responderId}`, authority: { kind: 'human', inputId: ctx.inputId },
        });
        if (r.status === 'moved' || r.status === 'replayed') {
          if (r.status === 'moved') await supersedeSteps(ctx.tx, s.id);
          return { status: 'done', effectKind: 'lifecycle.transition', effectRef: `lifecycle:${s.id}`, outcomeText: `Recorded. Now: ${labelOf(def, r.to).toLowerCase()}.` };
        }
        const now = await ctx.tx.selectFrom('lifecycle_subjects').select('state').where('id', '=', s.id).executeTakeFirstOrThrow();
        return { status: 'failed', effectKind: 'lifecycle.transition', effectRef: `lifecycle:${s.id}`, outcomeText: `That no longer applies, so nothing changed: things have moved on (now: ${labelOf(def, now.state).toLowerCase()}).` };
      },
    },
  };
}

/** Runs one queued effect of one transition. Idempotent: each effect is queued once per transition. */
export async function runEffect(deps: JourneyDeps & { readonly consumers: ConsumerRegistry }, tx: TenantTx, p: Record<string, unknown>): Promise<string> {
  const subjectId = String(p['subject_id']);
  const transitionId = String(p['transition_id']);
  const index = Number(p['index']);
  const def = lifecyclesOf(deps).get(String(p['lifecycle']));
  const s = await tx.selectFrom('lifecycle_subjects').selectAll().where('id', '=', subjectId).executeTakeFirst();
  const tr = await tx.selectFrom('lifecycle_transitions').select(['id', 'seq', 'event', 'from_state', 'to_state']).where('id', '=', transitionId).executeTakeFirst();
  if (!s || !tr) return 'gone';
  if (!def) throw new ContractViolation('§16', `no definition loaded for ${String(p['lifecycle'])}`);
  // The spec of the transition as it ran (same definition version, by hash, or the effect is skipped).
  if (s.definition_hash !== def.hash && s.state_seq === tr.seq) throw new ContractViolation('§16', 'definition changed under a pending effect');
  const spec = def.transitions.find((t) => t.event === tr.event && t.to === tr.to_state && (t.from === '*' || t.from.includes(tr.from_state ?? '')));
  const effect = spec?.effects[index];
  if (!effect) return 'no_effect';
  // An effect of a step the journey has already left is moot (e.g. a question about a job that was rebooked).
  if (s.state_seq !== tr.seq) return 'moot';

  const bookingId = typeof s.anchors['booking_id'] === 'string' ? s.anchors['booking_id'] : null;
  if ('set_booking_status' in effect) {
    if (!bookingId) return 'no_booking';
    await tx.updateTable('bookings').set({ status: effect.set_booking_status, closed_at: deps.clock.now() }).where('id', '=', bookingId).where('status', '=', 'confirmed').execute();
    return `booking_${effect.set_booking_status}`;
  }
  const owner = await ownerOf(tx);
  if (!owner) throw new ContractViolation('§82', 'tenant has no active owner');
  if ('notify_owner' in effect) {
    await notify(tx, deps.keyring, { userId: owner, kind: 'info', ref: `lifecycle:${s.id}`, dedupeKey: `effect:${transitionId}:${index}`, text: effect.notify_owner.text, subjectContactId: s.contact_id });
    return 'notified';
  }
  const a = effect.ask_owner;
  const facts = [`Now: ${labelOf(def, s.state).toLowerCase()}.`];
  if (bookingId) {
    const b = await tx.selectFrom('bookings').select(['starts_at', 'ends_at']).where('id', '=', bookingId).executeTakeFirst();
    const tz = await timezoneOf(deps, tx);
    if (b) facts.push(`Booking: ${slotPhrase(localSlot(b.starts_at.getTime(), b.ends_at.getTime(), tz))}.`);
  }
  await ask({ keyring: deps.keyring, clock: deps.clock, consumers: deps.consumers }, tx, {
    subjectContactId: s.contact_id, kind: 'lifecycle_step', subjectRef: `lifecycle:${s.id}`, contentDigest: digestOf({ subject: s.id, seq: s.state_seq, effect: index }),
    requiredRole: 'owner',
    body: { title: a.title, summary: a.summary, facts, optionLabels: Object.fromEntries(a.options.map((o) => [o.event, o.label])), safeDefaultText: a.safe_default_text },
    options: a.options.map((o) => o.event), safeDefault: 'hold', consumer: { kind: STEP_CONSUMER, ref: s.id }, deadlineMs: a.deadline_hours * 3_600_000,
  });
  return 'asked';
}

async function timezoneOf(deps: JourneyDeps, tx: TenantTx): Promise<string> {
  return (await snapshotAt(tx, deps.keyring, deps.clock.nowMs())).hours?.body.timezone ?? 'Europe/London';
}

export const runTimer = (deps: JourneyDeps, tx: TenantTx, timerId: string) => fireTimer(deps, tx, lifecyclesOf(deps), timerId);
