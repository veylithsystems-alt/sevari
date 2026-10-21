import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '@sevari/clock';
import { withTenant, type DbHandle } from '@sevari/db';
import type { TenantScope } from '@sevari/domain';
import { defineLifecycle, ensureSubject, fire, fireTimer, journeyOf, loadLifecycles, transitionsOf, type LifecycleDefinition } from '@sevari/lifecycle';
import { defaultLifecycles, journeyEvent } from '@sevari/worker';
import { contractSuite } from '../support/contract.ts';
import { appDb, newTenant, superQuery } from '../support/fixtures.ts';
import { harness, type Harness } from '../support/hitl-harness.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const stages = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), { automatic: 'covered elsewhere' }]));

/** A small valid machine; tests break one thing at a time. */
const base = () => ({
  id: 'test_journey', version: 1, lifecycle: 'T', subject_type: 'customer', description: 'test', initial: 'a', facts: ['vip'],
  states: { a: { stage: 1, label: 'A' }, b: { stage: 2, label: 'B', timers: [{ event: 'tick', after_minutes: 60 }] }, c: { stage: 3, label: 'C', terminal: true } },
  stages,
  transitions: [
    { from: ['a'], event: 'go', to: 'b' },
    { from: ['b'], event: 'tick', to: 'a' },
    { from: ['b'], event: 'book', to: 'c', action_class: 'booking_create' },
    { from: ['a'], event: 'vip_only', to: 'b', guard: { fact: 'vip', equals: true } },
    { from: ['a', 'b'], event: 'sign', to: 'c', human: true },
  ],
});

contractSuite('T-LC-1', () => {
  it('both shipped lifecycles load, validate and are pinned by a hash', async () => {
    const defs = await loadLifecycles(join(ROOT, 'config', 'lifecycles'));
    const v = [...defs.values()].filter((d) => d.lifecycle === 'V');
    const t = [...defs.values()].filter((d) => d.lifecycle === 'T');
    expect(v).toHaveLength(1);
    expect(t).toHaveLength(1);
    for (const d of defs.values()) expect(d.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(defineLifecycle(base()).hash).toBe(defineLifecycle(base()).hash);
  });

  it('refuses unreachable states, ambiguity, undeclared facts, dead ends, uncovered stages and timers that would authorise', () => {
    const broken = (f: (d: ReturnType<typeof base>) => void, msg: RegExp) => {
      const d = base();
      f(d);
      expect(() => defineLifecycle(d)).toThrow(msg);
    };
    broken((d) => { (d.states as Record<string, unknown>)['z'] = { stage: 4, label: 'Z' }; }, /"z" can never be reached/);
    broken((d) => { d.transitions.push({ from: ['a'], event: 'go', to: 'c' }); }, /already has a transition for "go"/);
    broken((d) => { d.transitions.push({ from: ['a'], event: 'x', to: 'b', guard: { fact: 'secret', equals: true } }); }, /undeclared fact "secret"/);
    broken((d) => { d.transitions.push({ from: ['c'], event: 'reopen', to: 'a' }); }, /leaves terminal state "c"/);
    broken((d) => { d.transitions.push({ from: ['a'], event: 'oops', to: 'nowhere' }); }, /unknown state "nowhere"/);
    broken((d) => { delete (d.stages as Record<string, unknown>)['7']; }, /stage 7 \(Support\) is not covered/);
    broken((d) => { d.states.b.timers = [{ event: 'book', after_minutes: 1 }]; }, /needs a person or an approval/);
    broken((d) => { d.states.b.timers = [{ event: 'never', after_minutes: 1 }]; }, /no transition from it/);
    broken((d) => { (d.transitions[0] as Record<string, unknown>)['action_class'] = 'teleport'; }, /Invalid enum value/);
  });

  it('the cell refuses to start with an invalid lifecycle file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sevari-lc-'));
    await cp(join(ROOT, 'config', 'lifecycles'), dir, { recursive: true });
    await writeFile(join(dir, 'broken.yaml'), 'id: broken\nversion: 1\nlifecycle: T\nsubject_type: x\ndescription: x\ninitial: a\nstates: { a: { stage: 1, label: A } }\ntransitions: [{ from: [a], event: e, to: b }]\n');
    await expect(loadLifecycles(dir)).rejects.toThrow(/broken is invalid/);
  });
});

let h: DbHandle;
let t: TenantScope;
let other: TenantScope;
let def: LifecycleDefinition;
const clock = new FixedClock(Date.parse('2026-10-14T09:00:00Z'));
const deps = { clock };
const contact = async (scope: TenantScope) => withTenant(h.db, scope, async (tx) => {
  const id = randomUUID();
  await tx.insertInto('contacts').values({ id, tenant_id: scope.tenantId, region: scope.region, source: 'test', lawful_basis: 'test', captured_at: clock.now(), captured_by: 'test' }).execute();
  return id;
});

beforeAll(async () => {
  h = appDb();
  t = await newTenant(h, 'lc9', 'Lifecycle Test');
  other = await newTenant(h, 'lc9', 'Other Business');
  def = defineLifecycle(base());
});
afterAll(async () => h.close());

contractSuite('T-LC-2', () => {
  it('the same event twice is one transition; every step is recorded and audited', async () => {
    const c = await contact(t);
    const r = await withTenant(h.db, t, async (tx) => {
      const s = await ensureSubject(deps, tx, def, c);
      const first = await fire(deps, tx, def, s.id, { event: 'go', idempotencyKey: 'msg:1', actor: 'test' });
      const again = await fire(deps, tx, def, s.id, { event: 'go', idempotencyKey: 'msg:1', actor: 'test' });
      return { s, first, again, steps: await transitionsOf(tx, s.id), audit: await tx.selectFrom('audit_events').select('event_type').where('subject_ref', '=', `lifecycle:${s.id}`).execute() };
    });
    expect(r.first).toMatchObject({ status: 'moved', from: 'a', to: 'b', seq: 2 });
    expect(r.again).toMatchObject({ status: 'replayed', to: 'b' });
    expect(r.steps.map((x) => `${x.from_state ?? '-'}>${x.to_state}`)).toEqual(['->a', 'a>b']);
    expect(r.audit.map((a) => a.event_type).sort()).toEqual(['lifecycle.started', 'lifecycle.transition']);
  });

  it('two racing events on one subject: exactly one wins each step', async () => {
    const c = await contact(t);
    const s = await withTenant(h.db, t, (tx) => ensureSubject(deps, tx, def, c));
    // Both "go" and "sign" are valid from a; "sign" needs a human so make both plain: race two different keys of "go".
    const results = await Promise.all([1, 2, 3, 4].map((i) => withTenant(h.db, t, (tx) => fire(deps, tx, def, s.id, { event: 'go', idempotencyKey: `race:${i}`, actor: 'test' }))));
    expect(results.filter((r) => r.status === 'moved')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'ignored')).toHaveLength(3); // from b, "go" has no step
    const steps = await withTenant(h.db, t, (tx) => transitionsOf(tx, s.id));
    expect(steps).toHaveLength(2);
  });

  it('another business can neither see nor move this journey', async () => {
    const c = await contact(t);
    const s = await withTenant(h.db, t, (tx) => ensureSubject(deps, tx, def, c));
    const seen = await withTenant(h.db, other, (tx) => tx.selectFrom('lifecycle_subjects').select('id').where('id', '=', s.id).execute());
    expect(seen).toHaveLength(0);
    await expect(withTenant(h.db, other, (tx) => fire(deps, tx, def, s.id, { event: 'go', idempotencyKey: 'x', actor: 'test' }))).rejects.toThrow(/not found for this tenant/);
  });

  it('a guard whose fact is missing does not pass (fail closed)', async () => {
    const c = await contact(t);
    const r = await withTenant(h.db, t, async (tx) => {
      const s = await ensureSubject(deps, tx, def, c);
      return [
        await fire(deps, tx, def, s.id, { event: 'vip_only', idempotencyKey: 'g1', actor: 'test' }),
        await fire(deps, tx, def, s.id, { event: 'vip_only', idempotencyKey: 'g2', actor: 'test', facts: { vip: false } }),
        await fire(deps, tx, def, s.id, { event: 'vip_only', idempotencyKey: 'g3', actor: 'test', facts: { vip: true } }),
      ];
    });
    expect(r.map((x) => x.status === 'ignored' ? x.reason : x.status)).toEqual(['missing_fact', 'guard', 'moved']);
  });
});

contractSuite('T-LC-3', () => {
  it('a booking step needs an approval of that class (or a grant); a human step needs a person\'s recorded answer', async () => {
    const c = await contact(t);
    const r = await withTenant(h.db, t, async (tx) => {
      const s = await ensureSubject(deps, tx, def, c);
      await fire(deps, tx, def, s.id, { event: 'go', idempotencyKey: 'k1', actor: 'test' });
      return {
        book: await fire(deps, tx, def, s.id, { event: 'book', idempotencyKey: 'k2', actor: 'test' }),
        forged: await fire(deps, tx, def, s.id, { event: 'book', idempotencyKey: 'k3', actor: 'test', authority: { kind: 'approval', approvalId: randomUUID() } }),
        grant: await fire(deps, tx, def, s.id, { event: 'book', idempotencyKey: 'k4', actor: 'test', authority: { kind: 'grant', grantId: randomUUID() } }),
        sign: await fire(deps, tx, def, s.id, { event: 'sign', idempotencyKey: 'k5', actor: 'test' }),
        signForged: await fire(deps, tx, def, s.id, { event: 'sign', idempotencyKey: 'k6', actor: 'test', authority: { kind: 'human', inputId: randomUUID() } }),
        state: (await journeyOf(tx, c))?.state,
      };
    });
    expect(r.book).toEqual({ status: 'needs_authority', reason: 'approval', actionClass: 'booking_create' });
    expect(r.forged).toMatchObject({ status: 'needs_authority' });
    expect(r.grant).toMatchObject({ status: 'needs_authority' });
    expect(r.sign).toEqual({ status: 'needs_authority', reason: 'human' });
    expect(r.signForged).toMatchObject({ status: 'needs_authority' });
    expect(r.state).toBe('b');
  });

  it('the database itself refuses a recorded booking step with no authority behind it', async () => {
    const c = await contact(t);
    const s = await withTenant(h.db, t, (tx) => ensureSubject(deps, tx, def, c));
    await expect(withTenant(h.db, t, (tx) => tx.insertInto('lifecycle_transitions').values({
      tenant_id: t.tenantId, region: t.region, subject_id: s.id, seq: 2, from_state: 'a', to_state: 'c', event: 'book', action_class: 'booking_create',
      authority: 'system', idempotency_key: 'forged', actor: 'x', definition_version: 1, definition_hash: def.hash, occurred_at: clock.now(),
    }).execute())).rejects.toThrow(/check constraint/);
    await expect(withTenant(h.db, t, (tx) => tx.updateTable('lifecycle_transitions').set({ to_state: 'c' }).where('subject_id', '=', s.id).execute())).rejects.toThrow(/permission denied/);
  });
});

contractSuite('T-LC-4', () => {
  it('a timer fires only if the journey is still where it was; otherwise it is stale', async () => {
    const c1 = await contact(t);
    const c2 = await contact(t);
    const run = async (cId: string, moveFirst: boolean) => withTenant(h.db, t, async (tx) => {
      const s = await ensureSubject(deps, tx, def, cId);
      await fire(deps, tx, def, s.id, { event: 'go', idempotencyKey: `go:${cId}`, actor: 'test' });
      const timer = await tx.selectFrom('lifecycle_timers').select(['id', 'fires_at']).where('subject_id', '=', s.id).where('status', '=', 'pending').executeTakeFirstOrThrow();
      expect(timer.fires_at.getTime()).toBe(clock.nowMs() + 60 * 60_000);
      await expect(fireTimer(deps, tx, new Map([[def.id, def]]), timer.id)).rejects.toThrow(/not due/);
      if (moveFirst) await fire(deps, tx, def, s.id, { event: 'go', idempotencyKey: `x:${cId}`, actor: 'test' }); // no step: still b
      return { s, timer };
    });
    const a = await run(c1, false);
    const b = await run(c2, true);
    clock.advance(61 * 60_000);
    const fired = await withTenant(h.db, t, (tx) => fireTimer(deps, tx, new Map([[def.id, def]]), a.timer.id));
    expect(fired).toBe('moved');
    expect((await withTenant(h.db, t, (tx) => journeyOf(tx, c1)))?.state).toBe('a');
    // Journey 2 moved on (to c via a human step is impossible here, so move it via tick key replay) → its old timer is stale.
    await withTenant(h.db, t, (tx) => fire(deps, tx, def, b.s.id, { event: 'tick', idempotencyKey: 'manual', actor: 'test' }));
    expect(await withTenant(h.db, t, (tx) => fireTimer(deps, tx, new Map([[def.id, def]]), b.timer.id))).toBe('cancelled');
    expect(await withTenant(h.db, t, (tx) => fireTimer(deps, tx, new Map([[def.id, def]]), a.timer.id))).toBe('fired');
  });

  let x: Harness;
  beforeAll(async () => {
    x = await harness('lc9house', 91);
    await superQuery('UPDATE tenants SET is_house = true WHERE id = $1', [x.t.tenantId]);
  });
  afterAll(async () => x?.close());

  it('Lifecycle V runs on the house tenant with the same engine: enquiry → qualify (asked) → proposal → contract (human only) → onboarding → live', async () => {
    const from = `owner-${randomUUID()}@business.example`;
    const m = await x.send('Hi, I run a drainage company and I am interested in Sevari for my enquiries. CH65 2AB', from);
    await x.process(m.messageId);
    await x.drain();
    const contactId = await withTenant(x.h.db, x.t, async (tx) => (await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id').select('conversations.contact_id').where('messages.id', '=', m.messageId).executeTakeFirstOrThrow()).contact_id);
    const j = await withTenant(x.h.db, x.t, (tx) => journeyOf(tx, contactId));
    expect(j).toMatchObject({ lifecycle: 'business_journey', state: 'qualifying' });
    const step = async (event: string) => {
      const q = await x.question(`lifecycle:${j!.id}`);
      expect(q?.status).toBe('open');
      x.clock.advance(5_000);
      const r = await x.answer({ questionId: q!.id, responderId: x.owner, response: event, digestSeen: q!.digest });
      expect(r.accepted).toBe(true);
      await x.drain();
      return (await withTenant(x.h.db, x.t, (tx) => journeyOf(tx, contactId)))?.state;
    };
    expect(await step('proposal_sent')).toBe('proposed');
    // The week-later follow-up is a timer: it may only ask, never sign.
    const timer = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('lifecycle_timers').select(['id', 'fires_at', 'event']).where('subject_id', '=', j!.id).where('status', '=', 'pending').executeTakeFirstOrThrow());
    expect(timer.event).toBe('proposal_follow_up');
    x.clock.set(timer.fires_at.getTime() + 1_000);
    await withTenant(x.h.db, x.t, (tx) => fireTimer(x, tx, defaultLifecycles(), timer.id));
    await x.drain();
    expect(await step('contract_signed')).toBe('contracted');
    expect(await step('onboarding_started')).toBe('onboarding');
    expect(await step('go_live')).toBe('live');
    const steps = await withTenant(x.h.db, x.t, (tx) => transitionsOf(tx, j!.id));
    const signed = steps.find((s) => s.event === 'contract_signed');
    expect(signed).toMatchObject({ authority: 'human', authority_ref: expect.stringMatching(/^input:/) });
    // Lifecycle T for a normal business runs on the very same engine (exercised in T-BOOK-2/3).
    expect([...defaultLifecycles().values()].map((d) => d.lifecycle).sort()).toEqual(['T', 'V']);
  });

  it('journeyEvent on a normal tenant picks Lifecycle T', async () => {
    const c = await contact(t);
    const r = await withTenant(h.db, t, (tx) => journeyEvent({ keyring: undefined as never, clock }, tx, c, { event: 'enquiry_received', idempotencyKey: 'e1', actor: 'test' }));
    expect(r).toMatchObject({ status: 'moved', from: 'new', to: 'engaged' });
    expect((await withTenant(h.db, t, (tx) => journeyOf(tx, c)))?.lifecycle).toBe('customer_journey');
  });
});
