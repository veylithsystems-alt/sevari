import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, TokenBucketLimiter } from '@sevari/api';
import { withTenant, type TenantTx } from '@sevari/db';
import { createUserToken } from '@sevari/identity';
import { BRIEF_JOB, buildBrief, nextBrief, renderBrief, sendBrief, zonedInstant } from '@sevari/metrics';
import { contractSuite } from '../support/contract.ts';
import { superQuery } from '../support/fixtures.ts';
import { harness, type Harness } from '../support/hitl-harness.ts';

/** Owner briefs (§78): 07:00 and 19:00 business-local time, built only from the business's own records. */
let x: Harness;
let y: Harness;
const xdb = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(x.h.db, x.t, fn);
const dbNow = async () => Number((await superQuery('SELECT floor(extract(epoch from clock_timestamp()) * 1000) AS ms')).rows[0].ms);

beforeAll(async () => {
  x = await harness('brf18', 181);
  y = await harness('brf18', 182);
  // Audit records are stamped by the database clock; line the test clocks up with it.
  const now = await dbNow();
  x.clock.set(now);
  y.clock.set(now);
});
afterAll(async () => { await x?.close(); await y?.close(); });

describe('[Briefs] timing', () => {
  it('07:00 and 19:00 in the business\'s own time zone, through the clock changes', () => {
    expect(new Date(zonedInstant('2026-01-10', '07:00', 'Europe/London')).toISOString()).toBe('2026-01-10T07:00:00.000Z');
    expect(new Date(zonedInstant('2026-07-10', '07:00', 'Europe/London')).toISOString()).toBe('2026-07-10T06:00:00.000Z');
    expect(new Date(zonedInstant('2026-03-29', '07:00', 'Europe/London')).toISOString()).toBe('2026-03-29T06:00:00.000Z'); // the day the clocks go forward
    expect(nextBrief(Date.parse('2026-01-10T06:59:00Z'), 'Europe/London')).toEqual({ kind: 'morning', at: Date.parse('2026-01-10T07:00:00Z') });
    expect(nextBrief(Date.parse('2026-01-10T07:00:00Z'), 'Europe/London')).toEqual({ kind: 'evening', at: Date.parse('2026-01-10T19:00:00Z') });
    expect(nextBrief(Date.parse('2026-01-10T20:00:00Z'), 'Europe/London')).toEqual({ kind: 'morning', at: Date.parse('2026-01-11T07:00:00Z') });
  });
});

contractSuite('A5', () => {
  it('every brief line links to audit events that exist in this business; nothing from another business appears', async () => {
    const mine = await x.send('How much to unblock a drain? CH65 2AB');
    await x.process(mine.messageId);
    const theirs = await y.send('Zebra-striped gutter emergency at CH65 9ZZ, quote please');
    await y.process(theirs.messageId);
    const at = (await dbNow()) + 1_000;
    const b = await xdb((tx) => buildBrief(x, tx, 'morning', at));
    expect(b.waiting).toBeGreaterThan(0);
    expect(b.lines.find((l) => l.section === 'activity')?.text).toMatch(/1 new message from customers overnight/);
    for (const l of b.lines.filter((l) => l.section !== 'activity' || !/^Quiet/.test(l.text))) {
      expect(l.auditRefs.length, l.text).toBeGreaterThan(0);
      const here = await xdb((tx) => tx.selectFrom('audit_events').select('id').where('id', 'in', [...l.auditRefs]).execute());
      expect(here).toHaveLength(l.auditRefs.length);
      const there = await withTenant(y.h.db, y.t, (tx) => tx.selectFrom('audit_events').select('id').where('id', 'in', [...l.auditRefs]).execute());
      expect(there).toHaveLength(0);
    }
    expect(renderBrief(b, 'Test drainage')).not.toMatch(/Zebra|9ZZ/);
  });
});

describe('[Briefs] delivery', () => {
  it('is stored once per slot, shown to the owner, schedules the next one, and only for a business that is live', async () => {
    const m = await x.send('Can someone look at my blocked toilet? CH65 2AB');
    await x.process(m.messageId);
    const at = (await dbNow()) + 2_000;
    const first = await xdb((tx) => sendBrief(x, tx, 'evening', at, 'Test drainage'));
    expect(first?.brief.lines.length).toBeGreaterThan(0);
    expect(await xdb((tx) => sendBrief(x, tx, 'evening', at, 'Test drainage'))).toBeNull();
    const notes = await x.notices(x.owner);
    expect(notes.some((n) => /Your evening summary for Test drainage/.test(n.text) && /Waiting for you/.test(n.text))).toBe(true);
    const next = await xdb((tx) => tx.selectFrom('job_queue').select(['payload', 'run_at']).where('kind', '=', BRIEF_JOB).where('run_at', '>', new Date(at)).execute());
    expect(next.length).toBeGreaterThan(0);

    // The job never runs early, and a business that isn't live gets none.
    const job = x.deps.handlers[BRIEF_JOB] as { scoped: (s: typeof x.t, p: Record<string, unknown>) => Promise<string> };
    await expect(job.scoped(x.t, { kind: 'morning', at: x.clock.nowMs() + 3_600_000 })).rejects.toThrow(/not due/);
    await superQuery(`DO $$ BEGIN SET LOCAL session_replication_role = replica; UPDATE tenants SET status = 'onboarding' WHERE id = '${y.t.tenantId}'; END $$`);
    const yjob = y.deps.handlers[BRIEF_JOB] as typeof job;
    expect(await yjob.scoped(y.t, { kind: 'morning', at: y.clock.nowMs() - 1 })).toBe('not_live');
  });

  it('is shown at the top of the owner\'s inbox', async () => {
    const app = buildServer({ intake: x.intake, publicBaseUrl: 'https://t.example', limiter: new TokenBucketLimiter(x.clock, { capacity: 100, perMinute: 6000 }), ready: async () => true, owner: { db: x.h.db, keyring: x.keyring, clock: x.clock, consumers: x.deps.consumers } });
    const token = await xdb((tx) => createUserToken(tx, x.clock, x.owner));
    const r = await app.inject({ method: 'GET', url: '/v1/owner/brief', headers: { authorization: `Bearer ${token}` } });
    const b = r.json() as { kind: string; lines: { section: string; text: string }[] };
    expect(b.kind).toBe('evening');
    expect(b.lines.some((l) => l.section === 'waiting')).toBe(true);
    await app.close();
  });
});
