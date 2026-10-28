import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cellLiveStatus, runBootChecks, type BootDeps } from '@sevari/boot';
import { FixedClock } from '@sevari/clock';
import { LocalKeyFileKms } from '@sevari/crypto';
import { connect, withTenant, type DbHandle } from '@sevari/db';
import { authenticate, newOperatorToken, platformDecision } from '@sevari/identity';
import { renderOwnerReport, sendWeeklyReport, weekStart, weeklyMetrics } from '@sevari/metrics';
import { APPROVED_SLO_2026_10_21, SloConfigSchema, sloApproved, withServiceLevels } from '@sevari/region';
import { contractSuite } from '../support/contract.ts';
import { isolatedDatabase } from '../support/db.ts';
import { draftFor, harness, type Harness } from '../support/hitl-harness.ts';
import { fixtures } from '../support/fixtures.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

contractSuite('T-SLO', () => {
  let iso: Awaited<ReturnType<typeof isolatedDatabase>>;
  let app: DbHandle;
  let dir: string;
  const clock = new FixedClock(Date.parse('2026-10-14T09:00:00Z'));
  const ops: Record<string, string> = {};
  let deps: BootDeps;
  beforeAll(async () => {
    iso = await isolatedDatabase();
    app = connect(iso.appUrl);
    const f = fixtures(iso);
    for (const role of ['founder', 'counsel'] as const) {
      const t = newOperatorToken();
      await f.ownerQuery('INSERT INTO operators (display_name, prefix, token_hash, role) VALUES ($1, $2, $3, $4)', [`Test ${role}`, t.prefix, t.hash, role]);
      ops[role] = t.full;
    }
    dir = await mkdtemp(join(tmpdir(), 'sevari-slo-'));
    await cp(join(ROOT, 'config'), dir, { recursive: true });
    deps = { db: app.db, kms: LocalKeyFileKms.fromKey(Buffer.alloc(32, 7)), region: 'uk', configDir: dir, egressPolicyPath: join(dir, 'egress.allowlist.yaml'), clock };
  });
  afterAll(async () => {
    await app.close();
    await iso.drop();
  });
  const sloCheck = async () => (await runBootChecks(deps)).checks.find((c) => c.name === 'slo');
  const decide = async (role: string, scope: string) => platformDecision(app.db, (await authenticate(app.db, clock, ops[role]))!, { decision: 'signoff', subjectRef: scope, reason: 'approved', scope, expiresOn: '2027-10-01' });

  it('with no service levels approved, the cell starts but refuses live tenants', async () => {
    expect(await sloCheck()).toMatchObject({ ok: true, detail: expect.stringMatching(/not approved/) });
    const live = await cellLiveStatus(deps);
    expect(live.allowed).toBe(false);
    if (!live.allowed) expect(live.reasons.join(' ')).toMatch(/service levels/);
  });

  it('service levels are approved as a set, and a recovery point shorter than the backup interval is refused', () => {
    const base = { version: 1, ack_target_p95_ms: 10_000 };
    expect(() => SloConfigSchema.parse({ ...base, availability_target_percent: 99.5, rto_minutes: null, rpo_minutes: null, backup_frequency_hours: null, restore_acceptance: null })).toThrow(/as a set/);
    expect(() => SloConfigSchema.parse({ ...base, availability_target_percent: 99.5, rto_minutes: 240, rpo_minutes: 60, backup_frequency_hours: 24, restore_acceptance: 'monthly drill' })).toThrow(/RPO/);
    expect(SloConfigSchema.parse({ ...base, availability_target_percent: 99.5, rto_minutes: 240, rpo_minutes: 1440, backup_frequency_hours: 24, restore_acceptance: 'monthly drill' })).toBeTruthy();
  });

  it('service levels written into the file without Dan\'s approval record stop the cell from starting', async () => {
    const slo = (await readFile(join(dir, 'slo.yaml'), 'utf8'))
      .replace('availability_target_percent: null', 'availability_target_percent: 99.5').replace('rto_minutes: null', 'rto_minutes: 240')
      .replace('rpo_minutes: null', 'rpo_minutes: 1440').replace('backup_frequency_hours: null', 'backup_frequency_hours: 24')
      .replace('restore_acceptance: null', 'restore_acceptance: "monthly restore drill, erasures re-applied"');
    await writeFile(join(dir, 'slo.yaml'), slo);
    expect(await sloCheck()).toMatchObject({ ok: false, detail: expect.stringMatching(/no approval record/) });
    await decide('founder', 'cell:uk:slo');
    expect(await sloCheck()).toMatchObject({ ok: true, detail: expect.stringMatching(/99.5%/) });
  });

  it('live tenants need both: approved service levels and counsel\'s sign-off, each with its records', async () => {
    let live = await cellLiveStatus(deps);
    expect(live.allowed).toBe(false); // counsel has not signed
    const uk = (await readFile(join(dir, 'regions', 'uk.yaml'), 'utf8'))
      .replace('counsel_signoff: null', 'counsel_signoff: { signed_by: "Example Counsel LLP", signed_on: "2026-10-01", scope: [live_tenants], reference: "CS-1" }')
      .replace('signoff_expires_on: null', 'signoff_expires_on: "2027-10-01"');
    await writeFile(join(dir, 'regions', 'uk.yaml'), uk);
    live = await cellLiveStatus(deps);
    expect(live.allowed).toBe(false); // the file claims it; the records don't exist yet
    await decide('counsel', 'region:uk:live_tenants');
    await decide('founder', 'region:uk:live_tenants');
    expect(await cellLiveStatus(deps)).toEqual({ allowed: true });
  });

  it('Dan\'s approved set (21 Oct 2026) is a valid set, and writing it keeps the file\'s comments and ACK target', async () => {
    const text = withServiceLevels(await readFile(join(ROOT, 'config', 'slo.yaml'), 'utf8'), APPROVED_SLO_2026_10_21);
    const slo = SloConfigSchema.parse((await import('yaml')).parse(text));
    expect(sloApproved(slo)).toBe(true);
    expect(slo).toMatchObject({ ...APPROVED_SLO_2026_10_21, ack_target_p95_ms: 10_000 });
    expect(text).toMatch(/# monthly/);
  });

  it('the ACK target is stated with its percentile and conditions, including a slow provider (F7 measures it)', async () => {
    const slo = SloConfigSchema.parse((await import('yaml')).parse(await readFile(join(ROOT, 'config', 'slo.yaml'), 'utf8')));
    expect(slo.ack_target_p95_ms).toBe(10_000);
    const f7 = await readFile(join(ROOT, 'tests', 'phase4', 'f7-ack-latency.test.ts'), 'utf8');
    expect(f7).toMatch(/latencyMs/); // the slow-provider run injects provider latency
  });
});

describe('[Phase 8] metrics and the weekly owner report (§10.3, §8.1)', () => {
  let x: Harness;
  beforeAll(async () => { x = await harness('metr8', 81); });
  afterAll(async () => x.close());

  const run = async (text: string, act?: 'approve' | 'edit' | 'reject') => {
    const m = await x.send(text);
    const r = await x.process(m.messageId);
    if (act) {
      const d = await draftFor(x, r.enquiryId);
      const q = await x.question(`draft:${d!.id}`);
      x.clock.advance(90_000);
      await x.answer({ questionId: q!.id, responderId: x.owner, response: act, digestSeen: q!.digest, ...(act === 'edit' ? { detail: 'Hi, a CCTV drain survey is from £150 including VAT. Port Drains (example)' } : {}) });
      await x.drain();
    }
    return r;
  };

  it('measures a week of real flows; the floors are zero; another business sees none of it', async () => {
    const start = new Date(x.clock.nowMs() - 60_000);
    await run('How much to unblock a drain? CH65 2AB', 'approve');
    await run('Can you do a CCTV drain survey? CH65 2AB', 'edit');
    await run('How much to unblock a toilet? CH66 1QT', 'reject');
    await run('I want to make a formal complaint about your engineer.');
    await run('How much is a drain repair? CH65 2AB'); // priced on inspection
    await run('Do you fit solar panels? CH65 2AB');
    const end = new Date(x.clock.nowMs() + 60_000);
    const m = await withTenant(x.h.db, x.t, (tx) => weeklyMetrics(tx, start, end, x.clock.nowMs()));
    expect(m.enquiries).toBe(6);
    expect(m.acknowledged).toBe(6);
    expect(m.replied).toBe(2);
    expect(m.drafts).toMatchObject({ edited: 1, rejected: 1 });
    expect(m.routes['human_only']).toBe(1);
    expect(m.decisions).toBe(3);
    expect(m.floors).toEqual({ unauthorisedSends: 0, suppressedSends: 0 });
    expect(m.ackP95Ms).not.toBeNull();
    // Row-level security reaches through the views: another business measures nothing of this one.
    const other = await harness('metr8b', 82);
    try {
      const o = await withTenant(other.h.db, other.t, (tx) => weeklyMetrics(tx, start, end, x.clock.nowMs()));
      expect(o.enquiries).toBe(0);
    } finally {
      await other.close();
    }
  });

  it('a floor breach is caught: a message sent with no approval behind it is counted', async () => {
    const y = await harness('metr8c', 83);
    try {
      const m = await y.send('How much to unblock a drain? CH65 2AB');
      const r = await y.process(m.messageId);
      const d = await draftFor(y, r.enquiryId);
      // Forge a "sent" outbound message that bypassed approval (the kind of bug the floor exists to catch).
      await withTenant(y.h.db, y.t, (tx) => tx.insertInto('outbox').values({
        tenant_id: y.t.tenantId, region: y.t.region, conversation_id: d!.conversation_id, contact_id: d!.contact_id, channel: 'email', purpose: 'reply', action_class: 'info_reply',
        dedupe_key: `forged:${randomUUID()}`, recipient_enc: Buffer.alloc(1), recipient_bidx: Buffer.alloc(32), body_enc: Buffer.alloc(1), body_digest: Buffer.alloc(32),
        state: 'sent', reserved_at: y.clock.now(), sent_at: y.clock.now(),
      }).execute());
      const mm = await withTenant(y.h.db, y.t, (tx) => weeklyMetrics(tx, new Date(y.clock.nowMs() - 60_000), new Date(y.clock.nowMs() + 60_000), y.clock.nowMs()));
      expect(mm.floors.unauthorisedSends).toBe(1);
      expect(renderOwnerReport(mm, 'Port Drains (example)')).toMatch(/must never happen/);
    } finally {
      await y.close();
    }
  });

  it('the weekly report is plain English, built only from the numbers, delivered to the owner once per week', async () => {
    const end = weekStart(x.clock.nowMs()).getTime() + 7 * 86_400_000;
    x.clock.set(end + 1_000);
    // The worker may already have sent it (the job is scheduled for the week's end); either way, exactly one.
    await withTenant(x.h.db, x.t, (tx) => sendWeeklyReport(x, tx, end, 'Port Drains (example)'));
    const again = await withTenant(x.h.db, x.t, (tx) => sendWeeklyReport(x, tx, end, 'Port Drains (example)'));
    expect(again).toBeNull();
    const reports = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('owner_reports').select(['id', 'metrics']).where('period_end', '=', new Date(end)).execute());
    expect(reports).toHaveLength(1);
    const note = (await x.notices(x.owner)).find((n) => n.ref === `report:${reports[0]!.id}`);
    expect(note?.text).toMatch(/your week with Sevari/);
    expect(note?.text).toMatch(/Enquiries: 6\. Every one was acknowledged/);
    expect(note?.text).toMatch(/records don't cover yet/);
    expect(note?.text).not.toMatch(/must never happen/);
    // The next week's report is queued.
    const next = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('job_queue').select('dedupe_key').where('kind', '=', 'report.weekly').execute());
    expect(next.map((j) => j.dedupe_key)).toContain(`weekly:${new Date(end + 7 * 86_400_000).toISOString().slice(0, 10)}`);
  });
});
