/**
 * Test harness for Phases 18 and 6: one tenant in its own test cell (so its job queue is private),
 * drainage knowledge, an owner and an approver, an email endpoint, a fake provider, and helpers to run
 * an enquiry through inbound → ack → respond, answer questions, and drain the queue.
 */
import { randomUUID } from 'node:crypto';
import { FakeSmsProvider, signWebhook, signedWebhookAdapter, smsAdapter, webformAdapter } from '@sevari/channels';
import { FixedClock } from '@sevari/clock';
import { LocalKeyFileKms, TenantKeyring } from '@sevari/crypto';
import { withTenant, workerQueue, type DbHandle, type WorkerQueue } from '@sevari/db';
import { regionCode, type TenantScope } from '@sevari/domain';
import { answer, sweep, type AnswerInput } from '@sevari/hitl';
import { createEndpoint, receiveInbound, type IntakeDeps } from '@sevari/intake';
import { confirmRecord, proposeRecord } from '@sevari/knowledge';
import { FakeProvider } from '@sevari/outbound';
import { processInbound, respond, runOnce, sendAck, workerHandlers, type RunnerDeps } from '@sevari/worker';
import { KNOWLEDGE } from '../../eval/fixtures/knowledge.ts';
import { dbInfo } from './db.ts';
import { appDb, newTenant } from './fixtures.ts';

export interface Harness {
  readonly h: DbHandle;
  readonly t: TenantScope;
  readonly clock: FixedClock;
  readonly keyring: TenantKeyring;
  readonly provider: FakeProvider;
  readonly owner: string;
  readonly approver: string;
  readonly viewer: string;
  readonly queue: WorkerQueue;
  readonly deps: ReturnType<typeof workerHandlers>;
  readonly intake: IntakeDeps;
  send(text: string, from?: string): Promise<{ messageId: string; from: string }>;
  /** inbound.process → ack.send → enquiry.respond, directly (no queue). */
  process(messageId: string): Promise<{ enquiryId: string; route: string }>;
  question(subjectRef: string): Promise<{ id: string; digest: string; kind: string; status: string; assigned: string | null } | undefined>;
  answer(a: Omit<AnswerInput, 'channel'> & { channel?: AnswerInput['channel'] }): ReturnType<typeof answer>;
  /** Runs the tenant's queued jobs (dispatch, reconcile) until none are left. */
  drain(): Promise<number>;
  sweep(): ReturnType<typeof sweep>;
  notices(userId: string): Promise<{ kind: string; ref: string; text: string }[]>;
  close(): Promise<void>;
}

export async function harness(region: string, seedByte: number, provider: FakeProvider = new FakeProvider()): Promise<Harness> {
  const clock = new FixedClock(Date.parse('2026-10-14T09:00:00Z'));
  const keyring = new TenantKeyring(LocalKeyFileKms.fromKey(Buffer.alloc(32, seedByte)));
  const h = appDb();
  const t = await newTenant(h, region, 'Port Drains');
  const k = KNOWLEDGE['drainage'];
  if (!k) throw new Error('fixture missing');
  const user = async (role: 'owner' | 'approver' | 'viewer', name: string) => withTenant(h.db, t, async (tx) => {
    const id = randomUUID();
    await tx.insertInto('users').values({ id, tenant_id: t.tenantId, region: t.region, role, display_name_enc: await keyring.seal(tx, { table: 'users', column: 'display_name_enc', rowId: id }, name) }).execute();
    return id;
  });
  await withTenant(h.db, t, async (tx) => {
    await keyring.provision(tx);
    for (const f of [k.business, k.hours, ...k.areas, ...k.services, ...k.prices, ...k.faqs].filter((x) => x !== undefined)) {
      const r = await proposeRecord(tx, keyring, { body: f.body, source: 'onboarding_interview', proposedBy: 'user:owner', ...(f.body.kind === 'faq' ? { key: `faq:${f.id}` } : {}) });
      await confirmRecord(tx, clock, { id: r.id, confirmedBy: 'user:owner' });
    }
  });
  const owner = await user('owner', 'Olive Owner');
  const approver = await user('approver', 'Alex Approver');
  const viewer = await user('viewer', 'Vic Viewer');
  const ep = await withTenant(h.db, t, (tx) => createEndpoint(tx, keyring, { channel: 'email', lawfulBasis: 'legitimate_interests_enquiry_response', purpose: 'enquiries' }, 'user:owner'));
  const intake: IntakeDeps = { db: h.db, keyring, clock, cellRegion: regionCode(region), cellUrls: {}, adapters: { email: signedWebhookAdapter('email'), webform: webformAdapter, sms: smsAdapter(FakeSmsProvider) } };
  const deps = workerHandlers({ db: h.db, keyring, clock, provider });
  const queue = workerQueue(dbInfo().workerUrl, regionCode(region));
  const runner: RunnerDeps = { queue, db: h.db, clock, workerId: `w-${region}`, handlers: deps.handlers, concurrency: 1 };
  const hitl = { keyring, clock, consumers: deps.consumers };

  return {
    h, t, clock, keyring, provider, owner, approver, viewer, queue, deps, intake,
    async send(text, from = `c-${randomUUID()}@example.com`) {
      const body = Buffer.from(JSON.stringify({ id: randomUUID(), from: { email: from, name: 'Casey' }, text }));
      const ts = Math.floor(clock.nowMs() / 1000);
      const r = await receiveInbound(intake, { channel: 'email', publicId: ep.publicId, raw: { body, headers: { 'x-sevari-timestamp': String(ts), 'x-sevari-signature': signWebhook(ep.secret ?? Buffer.alloc(0), ts, body) }, url: 'x' } });
      if (r.status !== 'accepted') throw new Error(JSON.stringify(r));
      return { messageId: r.messageId, from };
    },
    async process(messageId) {
      const a = await withTenant(h.db, t, (tx) => processInbound({ keyring, clock }, tx, messageId));
      await sendAck({ db: h.db, keyring, clock, provider }, t, messageId);
      await withTenant(h.db, t, (tx) => respond(hitl, tx, a.enquiryId));
      return { enquiryId: a.enquiryId, route: a.route };
    },
    async question(subjectRef) {
      const q = await withTenant(h.db, t, (tx) => tx.selectFrom('human_questions').select(['id', 'content_digest', 'kind', 'status', 'assigned_user_id']).where('subject_ref', '=', subjectRef).orderBy('created_at', 'desc').executeTakeFirst());
      return q ? { id: q.id, digest: q.content_digest.toString('hex'), kind: q.kind, status: q.status, assigned: q.assigned_user_id } : undefined;
    },
    answer: (a) => withTenant(h.db, t, (tx) => answer(hitl, tx, { channel: 'app', ...a })),
    async drain() {
      let total = 0;
      for (let i = 0; i < 20; i++) {
        const r = await runOnce(runner, 50);
        total += r.done + r.failed;
        if (r.done + r.failed === 0) break;
      }
      return total;
    },
    sweep: () => withTenant(h.db, t, (tx) => sweep(hitl, tx)),
    async notices(userId) {
      return withTenant(h.db, t, async (tx) => {
        const rows = await tx.selectFrom('human_notifications').select(['id', 'kind', 'ref', 'body_enc']).where('user_id', '=', userId).orderBy('created_at').execute();
        return Promise.all(rows.map(async (r) => ({ kind: r.kind, ref: r.ref, text: await keyring.openText(tx, { table: 'human_notifications', column: 'body_enc', rowId: r.id }, r.body_enc) })));
      });
    },
    async close() {
      await queue.close();
      await h.close();
    },
  };
}

/** The newest draft for an enquiry. */
export async function draftFor(x: Harness, enquiryId: string) {
  return withTenant(x.h.db, x.t, (tx) => tx.selectFrom('drafts').selectAll().where('enquiry_id', '=', enquiryId).orderBy('created_at', 'desc').executeTakeFirst());
}
