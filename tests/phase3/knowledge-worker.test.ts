import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeSmsProvider, signWebhook, signedWebhookAdapter, smsAdapter, webformAdapter } from '@sevari/channels';
import { FixedClock } from '@sevari/clock';
import { LocalKeyFileKms, TenantKeyring } from '@sevari/crypto';
import { sql, withTenant, workerQueue, type DbHandle, type WorkerQueue } from '@sevari/db';
import { regionCode, type TenantScope } from '@sevari/domain';
import { createEndpoint, INBOUND_JOB, receiveInbound, type IntakeDeps } from '@sevari/intake';
import { confirmRecord, proposeRecord, snapshotAt } from '@sevari/knowledge';
import { processInbound, RESPOND_JOB, runOnce, type RunnerDeps } from '@sevari/worker';
import { KNOWLEDGE } from '../../eval/fixtures/knowledge.ts';
import { appDb, newTenant } from '../support/fixtures.ts';
import { dbInfo } from '../support/db.ts';

const clock = new FixedClock(Date.parse('2026-10-14T09:00:00Z'));
const keyring = new TenantKeyring(LocalKeyFileKms.fromKey(Buffer.alloc(32, 5)));

async function seedTrade(h: DbHandle, s: TenantScope, trade: string): Promise<void> {
  const k = KNOWLEDGE[trade]!;
  const all = [k.business, k.hours, ...k.areas, ...k.services, ...k.prices, ...k.policies, ...k.faqs].filter((x) => x !== undefined);
  await withTenant(h.db, s, async (tx) => {
    await keyring.provision(tx);
    for (const [i, f] of all.entries()) {
      const key = f.body.kind === 'faq' ? `faq:${i}` : undefined;
      const r = await proposeRecord(tx, keyring, { body: f.body, source: 'onboarding_interview', proposedBy: 'user:owner', ...(key ? { key } : {}) });
      await confirmRecord(tx, clock, { id: r.id, confirmedBy: 'user:owner' });
    }
  });
}

describe('[Phase 3] knowledge records: owner-confirmed, versioned, replayable (§6.2, I5)', () => {
  let h: DbHandle;
  let t: TenantScope;
  beforeAll(async () => {
    h = appDb();
    t = await newTenant(h, 'uk', 'Knowledge Ltd');
    await withTenant(h.db, t, (tx) => keyring.provision(tx));
  });
  afterAll(async () => h.close());

  const price = (amount: number) => ({ kind: 'price', service_code: 'blocked_drain', basis: 'fixed', amount_minor: amount, vat: 'inclusive' });

  it('a proposed record is not a fact until the owner confirms it', async () => {
    const r = await withTenant(h.db, t, (tx) => proposeRecord(tx, keyring, { body: price(9500), source: 'owner_edit', proposedBy: 'user:owner' }));
    expect((await withTenant(h.db, t, (tx) => snapshotAt(tx, keyring, clock.nowMs()))).prices).toEqual([]);
    await withTenant(h.db, t, (tx) => confirmRecord(tx, clock, { id: r.id, confirmedBy: 'user:owner' }));
    const snap = await withTenant(h.db, t, (tx) => snapshotAt(tx, keyring, clock.nowMs()));
    expect(snap.prices.map((p) => [p.id, p.version, p.body.amount_minor])).toEqual([[r.id, 1, 9500]]);
  });

  it('a new confirmed version replaces the old from that moment; the past stays reproducible (§32 replay)', async () => {
    const before = clock.nowMs();
    clock.advance(60_000);
    const v2 = await withTenant(h.db, t, (tx) => proposeRecord(tx, keyring, { body: price(11000), source: 'owner_edit', proposedBy: 'user:owner' }));
    expect(v2.recordVersion).toBe(2);
    await withTenant(h.db, t, (tx) => confirmRecord(tx, clock, { id: v2.id, confirmedBy: 'user:owner' }));
    clock.advance(60_000);
    const now = await withTenant(h.db, t, (tx) => snapshotAt(tx, keyring, clock.nowMs()));
    const then = await withTenant(h.db, t, (tx) => snapshotAt(tx, keyring, before));
    expect(now.prices.map((p) => p.body.amount_minor)).toEqual([11000]);
    expect(then.prices.map((p) => p.body.amount_minor)).toEqual([9500]);
  });

  it('record bodies are immutable: a change must be a new version', async () => {
    await expect(withTenant(h.db, t, (tx) => sql`UPDATE knowledge_records SET body_enc = '\\x00'`.execute(tx))).rejects.toThrow(/permission denied/);
  });

  it('only a draft can be confirmed, and invalid knowledge is rejected at proposal', async () => {
    const all = await withTenant(h.db, t, (tx) => tx.selectFrom('knowledge_records').select(['id', 'status']).execute());
    const confirmed = all.find((r) => r.status === 'confirmed')!;
    await expect(withTenant(h.db, t, (tx) => confirmRecord(tx, clock, { id: confirmed.id, confirmedBy: 'user:owner' }))).rejects.toThrow(/only a draft/);
    await expect(withTenant(h.db, t, (tx) => proposeRecord(tx, keyring, { body: { kind: 'price', service_code: 'x_job', basis: 'fixed', vat: 'inclusive' }, source: 'owner_edit', proposedBy: 'user:owner' }))).rejects.toThrow();
  });
});

describe('[Phase 3] worker: inbound.process end to end', () => {
  let h: DbHandle;
  let t: TenantScope;
  let queue: WorkerQueue;
  let intake: IntakeDeps;
  let email: { publicId: string; secret: Buffer };
  let runner: RunnerDeps;

  beforeAll(async () => {
    h = appDb();
    t = await newTenant(h, 'uk', 'Port Drains');
    await seedTrade(h, t, 'drainage');
    email = await withTenant(h.db, t, async (tx) => {
      const e = await createEndpoint(tx, keyring, { channel: 'email', lawfulBasis: 'legitimate_interests_enquiry_response', purpose: 'enquiries' }, 'user:owner');
      return { publicId: e.publicId, secret: e.secret! };
    });
    intake = { db: h.db, keyring, clock, cellRegion: regionCode('uk'), cellUrls: {}, adapters: { webform: webformAdapter, email: signedWebhookAdapter('email'), sms: smsAdapter(FakeSmsProvider) } };
    queue = workerQueue(dbInfo().workerUrl, regionCode('uk'));
    runner = { queue, db: h.db, clock, workerId: 'w1', handlers: { [INBOUND_JOB]: (tx, p) => processInbound({ keyring, clock }, tx, String(p['message_id'])) } };
  });
  afterAll(async () => {
    await queue.close();
    await h.close();
  });

  const send = (id: string, text: string, from = 'jo@example.com') => {
    const body = Buffer.from(JSON.stringify({ id, from: { email: from, name: 'Jo' }, text }));
    const ts = Math.floor(clock.nowMs() / 1000);
    return receiveInbound(intake, { channel: 'email', publicId: email.publicId, raw: { body, headers: { 'x-sevari-timestamp': String(ts), 'x-sevari-signature': signWebhook(email.secret, ts, body) }, url: 'x' } });
  };
  const until = async <T>(probe: () => Promise<T | undefined>): Promise<T | undefined> => {
    for (let i = 0; i < 100; i++) {
      const v = await probe();
      if (v) return v;
      await runOnce(runner, 50);
    }
    return probe();
  };
  const enquiryFor = (messageId: string) => withTenant(h.db, t, (tx) => tx.selectFrom('enquiries').selectAll().where('message_id', '=', messageId).executeTakeFirst());

  it('analyses a queued message, stores the result with citations, and queues the reply step', async () => {
    const r = await send(`m-${randomUUID()}`, 'Can you come and unblock my drain today? CH65 2AB');
    expect(r.status).toBe('accepted');
    const id = r.status === 'accepted' ? r.messageId : '';
    // Other test files share the cell queue (and some of their jobs fail on purpose), so run the worker
    // until this message's analysis exists, with a deadline, rather than until a batch is empty.
    const e = await until(() => enquiryFor(id));
    expect(e).toMatchObject({ intent: 'booking_request', route: 'answer', services: ['blocked_drain'], eligibility: 'yes', pack_id: 'drainage' });
    expect(e!.facts_used.length).toBeGreaterThan(0);
    const respond = await withTenant(h.db, t, (tx) => tx.selectFrom('job_queue').select('payload').where('kind', '=', RESPOND_JOB).where('dedupe_key', '=', e!.id).executeTakeFirst());
    expect(respond?.payload).toEqual({ enquiry_id: e!.id });
    const audit = await withTenant(h.db, t, (tx) => tx.selectFrom('audit_events').select('payload').where('event_type', '=', 'enquiry.analysed').where('subject_ref', '=', `enquiry:${e!.id}`).executeTakeFirst());
    expect(audit?.payload).toMatchObject({ route: 'answer', intent: 'booking_request' });
  });

  it('is idempotent: re-running the step for the same message changes nothing', async () => {
    const r = await send(`m-${randomUUID()}`, 'How much to unblock a toilet?');
    const id = r.status === 'accepted' ? r.messageId : '';
    const first = await withTenant(h.db, t, (tx) => processInbound({ keyring, clock }, tx, id));
    const again = await withTenant(h.db, t, (tx) => processInbound({ keyring, clock }, tx, id));
    expect(again).toEqual({ ...first, replayed: true });
    const rows = await withTenant(h.db, t, (tx) => tx.selectFrom('enquiries').select('id').where('message_id', '=', id).execute());
    expect(rows).toHaveLength(1);
  });

  it('asks at most twice in a conversation, then escalates instead of guessing (§30.4)', async () => {
    const from = `vague-${randomUUID()}@example.com`;
    const routes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await send(`v-${randomUUID()}`, 'hello?', from);
      const id = r.status === 'accepted' ? r.messageId : '';
      routes.push((await withTenant(h.db, t, (tx) => processInbound({ keyring, clock }, tx, id))).route);
    }
    expect(routes).toEqual(['clarify', 'clarify', 'unknown']);
  });

  it('a crashed worker\'s job is picked up again after its lease and still yields one analysis', async () => {
    const r = await send(`c-${randomUUID()}`, 'Blocked toilet, CH66 1QT, can you come?');
    const id = r.status === 'accepted' ? r.messageId : '';
    // Claim with a tiny lease and "crash" (never complete).
    const claimed = await queue.claim({ workerId: 'crashy', limit: 50, leaseMs: 1, kinds: [INBOUND_JOB] });
    expect(claimed.some((j) => j.payload['message_id'] === id)).toBe(true);
    await new Promise((res) => setTimeout(res, 20));
    expect(await queue.reapExpired()).toBeGreaterThan(0);
    await until(() => enquiryFor(id));
    const rows = await withTenant(h.db, t, (tx) => tx.selectFrom('enquiries').select('id').where('message_id', '=', id).execute());
    expect(rows).toHaveLength(1);
  });

  it('the worker role can see queue rows but no tenant data at all', async () => {
    const c = new pg.Client({ connectionString: dbInfo().workerUrl });
    await c.connect();
    try {
      await c.query("SELECT set_config('app.region', 'uk', false)");
      for (const table of ['messages', 'contacts', 'enquiries', 'knowledge_records']) {
        await expect(c.query(`SELECT count(*) FROM ${table}`)).rejects.toThrow(/permission denied/);
      }
      const { rows } = await c.query('SELECT payload FROM job_queue LIMIT 5');
      for (const r of rows) expect(Object.keys(r.payload).every((k) => k.endsWith('_id'))).toBe(true);
    } finally {
      await c.end();
    }
  });

  it('a tenant with no confirmed business record fails the job loudly rather than guessing a trade', async () => {
    const bare = await newTenant(h, 'uk', 'No Knowledge Ltd');
    const ep = await withTenant(h.db, bare, async (tx) => {
      await keyring.provision(tx);
      return createEndpoint(tx, keyring, { channel: 'email', lawfulBasis: 'x', purpose: 'x' }, 'user:owner');
    });
    const body = Buffer.from(JSON.stringify({ id: 'b1', from: { email: 'a@example.com' }, text: 'blocked drain' }));
    const ts = Math.floor(clock.nowMs() / 1000);
    const r = await receiveInbound(intake, { channel: 'email', publicId: ep.publicId, raw: { body, headers: { 'x-sevari-timestamp': String(ts), 'x-sevari-signature': signWebhook(ep.secret!, ts, body) }, url: 'x' } });
    const id = r.status === 'accepted' ? r.messageId : '';
    await expect(withTenant(h.db, bare, (tx) => processInbound({ keyring, clock }, tx, id))).rejects.toThrow(/no confirmed business record/);
  });
});
