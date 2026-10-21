/**
 * Lifecycle definitions (§16): a typed state machine per subject, as DATA. States, transitions, guards,
 * timers, effects and the action class of every transition live in config/lifecycles/*.yaml; this file
 * only says what a valid definition looks like, and refuses anything ambiguous or unreachable.
 *
 * Validation (all must hold, or the cell refuses to start):
 *   - every state named in a transition, timer or `initial` exists;
 *   - every state is reachable from `initial`; non-terminal states have a way out;
 *   - at most one transition per (state, event): the machine is deterministic;
 *   - a guard only reads facts the definition declares; an action class is a real one (§7.2);
 *   - each timer's event has a transition from the state it is set in;
 *   - all twelve stages of §16.1 are covered: by a state, or declared automatic elsewhere, or a human task.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { ACTION_CLASSES, canonicalJson } from '@sevari/domain';

const NAME = z.string().regex(/^[a-z][a-z0-9_]*$/, 'lower_snake_case');

export const STAGES = {
  1: 'Source', 2: 'Contact and qualify', 3: 'Offer', 4: 'Commit', 5: 'Onboard', 6: 'Deliver',
  7: 'Support', 8: 'Bill', 9: 'Reconcile', 10: 'Resolve', 11: 'Retain and grow', 12: 'Offload and exit',
} as const;

const Timer = z.object({
  event: NAME,
  /** Minutes after the anchor time. */
  after_minutes: z.number().int().min(0),
  /** 'entered' (when the state was entered) or a named anchor on the subject (e.g. booking_end). */
  anchor: z.union([z.literal('entered'), NAME]).default('entered'),
}).strict();

const State = z.object({
  stage: z.number().int().min(1).max(12),
  label: z.string().min(1),
  terminal: z.boolean().default(false),
  timers: z.array(Timer).default([]),
}).strict();

const Guard = z.object({ fact: NAME, equals: z.union([z.boolean(), z.string(), z.number()]) }).strict();

const AskOwner = z.object({
  ask_owner: z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    /** Each option fires this event, with the person's answer as the authority. */
    options: z.array(z.object({ event: NAME, label: z.string().min(1) }).strict()).min(1),
    deadline_hours: z.number().int().positive(),
    safe_default_text: z.string().min(1),
  }).strict(),
}).strict();
const NotifyOwner = z.object({ notify_owner: z.object({ text: z.string().min(1) }).strict() }).strict();
const BookingStatus = z.object({ set_booking_status: z.enum(['completed', 'no_show']) }).strict();
export const Effect = z.union([AskOwner, NotifyOwner, BookingStatus]);
export type Effect = z.infer<typeof Effect>;

const Transition = z.object({
  from: z.union([z.literal('*'), z.array(NAME).min(1)]),
  event: NAME,
  to: NAME,
  guard: Guard.optional(),
  /** This transition books, sends or moves money: the autonomy policy decides who may authorise it (§7). */
  action_class: z.enum(ACTION_CLASSES).optional(),
  /** Always a human decision (§8.3: contract activation, termination...). */
  human: z.boolean().default(false),
  effects: z.array(Effect).default([]),
}).strict();

const StageCover = z.union([
  z.object({ automatic: z.string().min(1) }).strict(),
  z.object({ human: z.string().min(1) }).strict(),
]);

export const DefinitionSchema = z.object({
  id: NAME,
  version: z.number().int().positive(),
  /** Which of the two lifecycles of §16 this is. */
  lifecycle: z.enum(['V', 'T']),
  subject_type: NAME,
  description: z.string().min(1),
  initial: NAME,
  facts: z.array(NAME).default([]),
  states: z.record(NAME, State),
  stages: z.record(z.string().regex(/^(1[0-2]|[1-9])$/), StageCover).default({}),
  transitions: z.array(Transition).min(1),
}).strict();

export type LifecycleDefinition = z.infer<typeof DefinitionSchema> & { readonly hash: string };
export type TransitionSpec = LifecycleDefinition['transitions'][number];

export class DefinitionError extends Error {
  readonly id: string;
  readonly problems: readonly string[];
  constructor(id: string, problems: readonly string[]) {
    super(`lifecycle ${id} is invalid: ${problems.join('; ')}`);
    this.id = id;
    this.problems = problems;
  }
}

/** Parses and validates one definition; the hash pins exactly which version a journey ran on. */
export function defineLifecycle(raw: unknown): LifecycleDefinition {
  const d = DefinitionSchema.parse(raw);
  const problems = validate(d);
  if (problems.length) throw new DefinitionError(d.id, problems);
  const hash = createHash('sha256').update(canonicalJson(d)).digest('hex');
  return Object.freeze({ ...d, hash });
}

function validate(d: z.infer<typeof DefinitionSchema>): string[] {
  const p: string[] = [];
  const states = new Set(Object.keys(d.states));
  const has = (s: string, where: string) => { if (!states.has(s)) p.push(`${where}: unknown state "${s}"`); };
  has(d.initial, 'initial');
  const fromOf = (t: TransitionSpec) => (t.from === '*' ? [...states].filter((s) => !d.states[s]?.terminal) : t.from);
  const seen = new Map<string, number>();
  d.transitions.forEach((t, i) => {
    const at = `transition ${i + 1} (${t.event})`;
    if (t.from !== '*') t.from.forEach((s) => has(s, at));
    has(t.to, at);
    if (t.guard && !d.facts.includes(t.guard.fact)) p.push(`${at}: guard reads undeclared fact "${t.guard.fact}"`);
    if (t.from !== '*') for (const s of t.from) if (d.states[s]?.terminal) p.push(`${at}: leaves terminal state "${s}"`);
    for (const e of t.effects) {
      if ('ask_owner' in e) for (const o of e.ask_owner.options) {
        if (!d.transitions.some((x) => x.event === o.event)) p.push(`${at}: ask_owner option "${o.event}" fires an event no transition handles`);
      }
    }
    // Determinism: one (state, event) → one transition. Explicit 'from' lists win over '*', so only
    // explicit duplicates, or two wildcards, are ambiguous.
    for (const s of fromOf(t)) {
      const k = `${s}|${t.event}|${t.from === '*' ? '*' : 'x'}`;
      if (seen.has(k)) p.push(`${at}: state "${s}" already has a transition for "${t.event}"`);
      seen.set(k, i);
    }
  });
  // Reachability.
  const reach = new Set([d.initial]);
  for (let changed = true; changed;) {
    changed = false;
    for (const t of d.transitions) for (const s of fromOf(t)) if (reach.has(s) && !reach.has(t.to)) { reach.add(t.to); changed = true; }
  }
  for (const s of states) if (!reach.has(s)) p.push(`state "${s}" can never be reached from "${d.initial}"`);
  for (const [name, s] of Object.entries(d.states)) {
    if (!s.terminal && !d.transitions.some((t) => fromOf(t).includes(name))) p.push(`state "${name}" is not terminal but has no way out`);
    for (const tm of s.timers) {
      const t = d.transitions.find((x) => x.event === tm.event && fromOf(x).includes(name));
      if (!t) p.push(`state "${name}": timer event "${tm.event}" has no transition from it`);
      // A clock can't authorise anything: a timer may only fire a step that needs no authority.
      else if (t.action_class || t.human) p.push(`state "${name}": timer event "${tm.event}" fires a step that needs a person or an approval`);
    }
  }
  // §16.1: all twelve stages exist, as a state, as automatic work elsewhere, or as a human task.
  const covered = new Set([...Object.values(d.states).map((s) => s.stage), ...Object.keys(d.stages).map(Number)]);
  for (const n of Object.keys(STAGES).map(Number)) if (!covered.has(n)) p.push(`stage ${n} (${STAGES[n as keyof typeof STAGES]}) is not covered`);
  return p;
}

/** The transition for (state, event): an explicit 'from' beats a wildcard. */
export function transitionFor(d: LifecycleDefinition, state: string, event: string): TransitionSpec | undefined {
  return d.transitions.find((t) => t.event === event && t.from !== '*' && t.from.includes(state))
    ?? (d.states[state]?.terminal ? undefined : d.transitions.find((t) => t.event === event && t.from === '*'));
}

/** Loads every definition in a directory (config/lifecycles). Duplicate ids are refused. */
export async function loadLifecycles(dir: string): Promise<ReadonlyMap<string, LifecycleDefinition>> {
  const out = new Map<string, LifecycleDefinition>();
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.yaml')).sort()) {
    const d = defineLifecycle(parse(await readFile(join(dir, f), 'utf8')));
    if (out.has(d.id)) throw new DefinitionError(d.id, [`defined twice (${f})`]);
    out.set(d.id, d);
  }
  return out;
}
