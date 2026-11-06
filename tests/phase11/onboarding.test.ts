import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeSmsProvider, signWebhook, signedWebhookAdapter, smsAdapter, webformAdapter } from '@sevari/channels';
import { FixedClock } from '@sevari/clock';
import { LocalKeyFileKms, TenantKeyring } from '@sevari/crypto';
import { withTenant, type DbHandle, type TenantTx } from '@sevari/db';
import { regionCode, type TenantScope } from '@sevari/domain';
import { answer } from '@sevari/hitl';
import { authenticate, newOperatorToken, platformDecision } from '@sevari/identity';
import { createEndpoint, receiveInbound, type IntakeDeps } from '@sevari/intake';
import { confirmRecord } from '@sevari/knowledge';
import { draftFromAnswers, detectRegulated, goLiveChecklist, importContacts, startChannelCheck, startOnboarding, type CellLive } from '@sevari/onboarding';
import { FakeProvider } from '@sevari/outbound';
import { askPackConfirm, requestGoLive, sendAck, workerHandlers } from '@sevari/worker';
import { buildServer, TokenBucketLimiter } from '@sevari/api';
import { createUserToken } from '@sevari/identity';
import { contractSuite } from '../support/contract.ts';
import { appDb, newTenant, ownerQuery } from '../support/fixtures.ts';

const clock = new FixedClock(Date.parse('2026-11-05T10:00:00Z'));
const CLEARED: CellLive = async () => ({ allowed: true });

/** Bright Windows: a kind of business with no ready-made pack. */
const answers = (over: Record<string, unknown> = {}) => ({
  business: {
    trading_name: 'Bright Windows (example)', phone: '01510000001', privacy_notice_url: 'https://brightwindows.example/privacy', reply_time_statement: 'within 2 working hours',
    description: 'We clean windows, conservatories and fascias for homes and small shops.', vat: 'not_registered',
  },
  services: [
    { name: 'window cleaning', everyday_names: ['windows cleaned', 'window cleaner'], price: { basis: 'from', pounds: 15 } },
    { name: 'conservatory cleaning', everyday_names: ['conservatory roof'], price: { basis: 'on_inspection' } },
  ],
  hours: { weekly: { mon: [{ start: '08:00', end: '17:00' }], tue: [{ start: '08:00', end: '17:00' }], wed: [{ start: '08:00', end: '17:00' }], thu: [{ start: '08:00', end: '17:00' }], fri: [{ start: '08:00', end: '17:00' }] } },
  area: { outward_codes: ['CH65', 'CH66'], description: 'Ellesmere Port' },
  ...over,
});

interface Biz { t: TenantScope; keyring: TenantKeyring; owner: string; deps: ReturnType<typeof workerHandlers>; intake: IntakeDeps; db: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T> }
let h: DbHandle;
beforeAll(() => { h = appDb(); });
afterAll(async () => h.close());

async function business(seed: number, cellLive: CellLive = CLEARED): Promise<Biz> {
  const t = await newTenant(h, 'onb11', `Onboarding ${seed}`, { live: false });
  const keyring = new TenantKeyring(LocalKeyFileKms.fromKey(Buffer.alloc(32, seed)));
  const db = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(h.db, t, fn);
  const owner = await db(async (tx) => {
    await keyring.provision(tx);
    const id = randomUUID();
    await tx.insertInto('users').values({ id, tenant_id: t.tenantId, region: t.region, role: 'owner', display_name_enc: await keyring.seal(tx, { table: 'users', column: 'display_name_enc', rowId: id }, 'Owen Owner') }).execute();
    return id;
  });
  const deps = workerHandlers({ db: h.db, keyring, clock, provider: new FakeProvider(), cellLive });
  const intake: IntakeDeps = { db: h.db, keyring, clock, cellRegion: regionCode('onb11'), cellUrls: {}, adapters: { email: signedWebhookAdapter('email'), webform: webformAdapter, sms: smsAdapter(FakeSmsProvider) } };
  return { t, keyring, owner, deps, intake, db };
}
const hitl = (b: Biz) => ({ keyring: b.keyring, clock, consumers: b.deps.consumers });
const tap = async (b: Biz, questionId: string, response: string) => {
  const q = await b.db((tx) => tx.selectFrom('human_questions').select('content_digest').where('id', '=', questionId).executeTakeFirstOrThrow());
  clock.advance(5_000);
  return b.db((tx) => answer(hitl(b), tx, { questionId, responderId: b.owner, response, digestSeen: q.content_digest.toString('hex'), channel: 'app' }));
};
const confirmAll = (b: Biz, ids: readonly string[]) => b.db(async (tx) => { for (const id of ids) await confirmRecord(tx, clock, { id, confirmedBy: `user:${b.owner}` }); });
const status = (b: Biz) => b.db(async (tx) => (await tx.selectFrom('tenants').select(['status', 'regulated']).where('id', '=', b.t.tenantId).executeTakeFirstOrThrow()));

/** Email endpoint plus the one-time channel check, proved by sending the code in. */
async function connectChannel(b: Biz) {
  const ep = await b.db((tx) => createEndpoint(tx, b.keyring, { channel: 'email', lawfulBasis: 'legitimate_interests_enquiry_response', purpose: 'enquiries' }, 'user:owner'));
  const code = await b.db(async (tx) => {
    const row = await tx.selectFrom('channel_endpoints').select('id').where('public_id', '=', ep.publicId).executeTakeFirstOrThrow();
    return startChannelCheck(tx, row.id);
  });
  const send = async (text: string, from = `c-${randomUUID()}@example.com`) => {
    const body = Buffer.from(JSON.stringify({ id: randomUUID(), from: { email: from, name: 'Casey' }, text }));
    const ts = Math.floor(clock.nowMs() / 1000);
    const r = await receiveInbound(b.intake, { channel: 'email', publicId: ep.publicId, raw: { body, headers: { 'x-sevari-timestamp': String(ts), 'x-sevari-signature': signWebhook(ep.secret ?? Buffer.alloc(0), ts, body) }, url: 'x' } });
    if (r.status !== 'accepted') throw new Error(JSON.stringify(r));
    return r.messageId;
  };
  return { code, send };
}

/** Everything a business needs before the go-live tap: records and pack confirmed, a channel proved. */
async function ready(b: Biz, a = answers()) {
  const o = await b.db((tx) => startOnboarding({ keyring: b.keyring, clock }, tx, a, `user:${b.owner}`));
  await confirmAll(b, o.recordIds);
  if (o.packId) {
    const q = await b.db((tx) => askPackConfirm({ ...hitl(b) }, tx, o.packId!));
    expect((await tap(b, q, 'confirm')).accepted).toBe(true);
  }
  const ch = await connectChannel(b);
  await ch.send(`Testing my Sevari address ${ch.code}`);
  return { ...o, ch };
}

describe('[Phase 11] the onboarding interview drafts records and a pack for any kind of business', () => {
  it('a business with no ready-made pack gets one drafted from its own words', () => {
    const d = draftFromAnswers(answers());
    expect(d.drafted).toBe(true);
    expect(d.pack.services.map((s) => s.code)).toEqual(['window_cleaning', 'conservatory_cleaning']);
    expect(d.pack.services[0]!.keywords).toContain('window cleaner');
    expect(d.records.filter((r) => r.kind === 'price')).toHaveLength(2);
    expect(d.records.find((r) => r.kind === 'business')).toMatchObject({ vertical: 'custom' });
    // One of the five trades uses its ready-made pack instead.
    const t = draftFromAnswers(answers({ business: { ...answers().business, trade: 'drainage' } }));
    expect(t).toMatchObject({ drafted: false, pack: { id: 'drainage' } });
  });
});

contractSuite('T-ONB-5', () => {
  it('a failing checklist blocks the go-live tap and says exactly what is missing', async () => {
    const b = await business(111, async () => ({ allowed: false, reasons: ['no counsel sign-off'] }));
    const o = await b.db((tx) => startOnboarding({ keyring: b.keyring, clock }, tx, answers(), `user:${b.owner}`));
    const r = await b.db((tx) => requestGoLive({ ...hitl(b), cellLive: async () => ({ allowed: false, reasons: ['no counsel sign-off'] }) }, tx));
    expect(r.status).toBe('blocked');
    if (r.status !== 'blocked') throw new Error('unreachable');
    const all = r.missing.join('\n');
    expect(all).toMatch(/Confirm your business details/);
    expect(all).toMatch(/Connect at least one way for customers to reach you/);
    expect(all).toMatch(/isn't cleared to run live businesses in your region/);
    // Confirming the records clears those items, and only those.
    await confirmAll(b, o.recordIds);
    const again = await b.db((tx) => goLiveChecklist({ keyring: b.keyring, clock, cellLive: async () => ({ allowed: false, reasons: [] }) }, tx));
    expect(again.items.filter((i) => !i.ok).map((i) => i.key)).toEqual(['channel', 'pack', 'cell']);
    expect(again.items.find((i) => i.key === 'pack')?.text).toMatch(/Check and confirm the list of your services/);
    const note = await b.db((tx) => tx.selectFrom('human_notifications').select('id').where('user_id', '=', b.owner).execute());
    expect(note.length).toBeGreaterThan(0);
    expect(await status(b)).toMatchObject({ status: 'onboarding' });
  });
});

contractSuite('T-PACK-1', () => {
  it('a drafted pack can\'t be confirmed while its practice enquiries fail, and can\'t go live unconfirmed', async () => {
    const b = await business(112);
    // No postcodes given: practice enquiries can't be answered, so the tests fail.
    const o = await b.db((tx) => startOnboarding({ keyring: b.keyring, clock }, tx, answers({ area: { outward_codes: [], description: 'around town' } }), `user:${b.owner}`));
    expect(o.report.passed).toBe(false);
    await confirmAll(b, o.recordIds);
    const q = await b.db((tx) => askPackConfirm({ ...hitl(b) }, tx, o.packId!));
    const r = await tap(b, q, 'confirm');
    expect(r.accepted).toBe(true);
    const pack = await b.db((tx) => tx.selectFrom('tenant_packs').select(['status', 'test_passed']).where('id', '=', o.packId!).executeTakeFirstOrThrow());
    expect(pack).toEqual({ status: 'draft', test_passed: false });
    const list = await b.db((tx) => goLiveChecklist({ keyring: b.keyring, clock, cellLive: CLEARED }, tx));
    expect(list.items.find((i) => i.key === 'pack')).toMatchObject({ ok: false });
    // The database refuses a confirmed pack whose tests didn't pass.
    await expect(b.db((tx) => tx.updateTable('tenant_packs').set({ status: 'confirmed', confirmed_by: 'x', confirmed_at: clock.now() }).where('id', '=', o.packId!).execute())).rejects.toThrow(/check constraint/);
  });
});

contractSuite('T-ONB-1', () => {
  it('no activation without the checklist plus the owner\'s own recorded decision; the database refuses any shortcut', async () => {
    const b = await business(113);
    const { ch } = await ready(b);
    // Not live yet: a customer's message is received, but nothing is sent to them.
    const m = await ch.send('How much to clean my windows? CH65 2AB');
    expect(await sendAck({ db: h.db, keyring: b.keyring, clock, provider: new FakeProvider() }, b.t, m)).toBe('blocked');
    // The app can't just flip the switch.
    await expect(b.db((tx) => tx.updateTable('tenants').set({ status: 'active' }).where('id', '=', b.t.tenantId).execute())).rejects.toThrow(/recorded go-live decision/);
    const r = await b.db((tx) => requestGoLive({ ...hitl(b), cellLive: CLEARED }, tx));
    expect(r.status === 'blocked' ? r.missing : []).toEqual([]);
    if (r.status !== 'asked') throw new Error('unreachable');
    expect((await tap(b, r.questionId, 'go_live')).accepted).toBe(true);
    expect(await status(b)).toMatchObject({ status: 'active' });
    const act = await b.db((tx) => tx.selectFrom('tenant_activations').select(['mode', 'input_id', 'decided_by', 'checklist_ok']).executeTakeFirstOrThrow());
    expect(act).toMatchObject({ mode: 'active', decided_by: b.owner, checklist_ok: true });
    // Live: the next customer gets the instant acknowledgement.
    const m2 = await ch.send('How much to clean my windows? CH65 2AB');
    expect(await sendAck({ db: h.db, keyring: b.keyring, clock, provider: new FakeProvider() }, b.t, m2)).toBe('sent');
  });
});

contractSuite('T-ONB-3', () => {
  it('practice (shadow) mode sends nothing and is only ever left by the owner\'s decision', async () => {
    const b = await business(114);
    const { ch } = await ready(b);
    const r = await b.db((tx) => requestGoLive({ ...hitl(b), cellLive: CLEARED }, tx));
    if (r.status !== 'asked') throw new Error(r.status);
    await tap(b, r.questionId, 'shadow');
    expect(await status(b)).toMatchObject({ status: 'shadow' });
    const m = await ch.send('Can you clean my conservatory roof? CH66 1QT');
    expect(await sendAck({ db: h.db, keyring: b.keyring, clock, provider: new FakeProvider() }, b.t, m)).toBe('blocked');
    // Time passing, sweeps and the queue never take it out of practice mode.
    clock.advance(30 * 86_400_000);
    await b.db((tx) => b.deps.handlers['hitl.sweep'] && typeof b.deps.handlers['hitl.sweep'] === 'function' ? (b.deps.handlers['hitl.sweep'] as (tx: TenantTx, p: Record<string, unknown>) => Promise<unknown>)(tx, {}) : Promise.resolve());
    expect(await status(b)).toMatchObject({ status: 'shadow' });
    await expect(b.db((tx) => tx.updateTable('tenants').set({ status: 'active' }).where('id', '=', b.t.tenantId).execute())).rejects.toThrow(/recorded go-live decision/);
    const again = await b.db((tx) => requestGoLive({ ...hitl(b), cellLive: CLEARED }, tx));
    if (again.status !== 'asked') throw new Error(again.status);
    expect((await b.db((tx) => tx.selectFrom('human_questions').select('options').where('id', '=', again.questionId).executeTakeFirstOrThrow())).options).toEqual(['go_live', 'not_yet']);
    await tap(b, again.questionId, 'go_live');
    expect(await status(b)).toMatchObject({ status: 'active' });
  });
});

contractSuite('T-ONB-4', () => {
  it('a regulated business can\'t be activated by its owner alone; Veylith\'s approval is also needed', async () => {
    const b = await business(115);
    await ready(b, answers({ business: { ...answers().business, description: 'Window cleaning, and we also do gas boiler servicing.' } }));
    expect(await status(b)).toMatchObject({ regulated: true });
    const blocked = await b.db((tx) => requestGoLive({ ...hitl(b), cellLive: CLEARED }, tx));
    expect(blocked).toMatchObject({ status: 'blocked', missing: [expect.stringMatching(/regulated work \(gas\).*Veylith must approve/)] });
    // The owner can't clear the finding.
    await expect(b.db((tx) => tx.updateTable('tenants').set({ regulated: false }).where('id', '=', b.t.tenantId).execute())).rejects.toThrow(/only be cleared by Veylith/);
    // Veylith's founder approves this business; then the owner's tap works.
    const tok = newOperatorToken();
    await ownerQuery('INSERT INTO operators (display_name, prefix, token_hash, role) VALUES ($1, $2, $3, $4)', ['Dan (test)', tok.prefix, tok.hash, 'founder']);
    await platformDecision(h.db, (await authenticate(h.db, clock, tok.full))!, { decision: 'signoff', subjectRef: `tenant:${b.t.tenantId}`, scope: `tenant:${b.t.tenantId}:activation`, reason: 'gas work checked: Gas Safe number verified', expiresOn: '2027-11-05' });
    const r = await b.db((tx) => requestGoLive({ ...hitl(b), cellLive: CLEARED }, tx));
    if (r.status !== 'asked') throw new Error(JSON.stringify(r));
    await tap(b, r.questionId, 'go_live');
    expect(await status(b)).toMatchObject({ status: 'active' });
    const act = await b.db((tx) => tx.selectFrom('tenant_activations').select(['regulated', 'platform_decision_id']).executeTakeFirstOrThrow());
    expect(act.regulated).toBe(true);
    expect(act.platform_decision_id).not.toBeNull();
  });
});

contractSuite('T-PACK-2', () => {
  it('regulated activities are detected from the owner\'s own words, and negated mentions don\'t count', () => {
    expect(detectRegulated(['We are Gas Safe registered and fit boilers']).map((r) => r.activity)).toEqual(['gas']);
    expect(detectRegulated(['Childminding in my home for under fives']).map((r) => r.activity)).toEqual(['childcare']);
    expect(detectRegulated(['Rewiring and consumer unit upgrades']).map((r) => r.activity)).toEqual(['electrical']);
    expect(detectRegulated(['We don\'t do gas work, only windows'])).toEqual([]);
    expect(detectRegulated(['Window cleaning and gutter clearing'])).toEqual([]);
  });
});

contractSuite('T-ONB-2', () => {
  it('an import without a lawful basis is blocked; imported people need consent before marketing or unsolicited replies', async () => {
    const b = await business(116);
    const before = await b.db((tx) => tx.selectFrom('contacts').select('id').execute());
    await expect(b.db((tx) => importContacts({ keyring: b.keyring, clock }, tx, { rows: [{ email: 'old@example.com' }], lawfulBasis: '  ', acquiredFrom: 'old spreadsheet', importedBy: `user:${b.owner}` })))
      .rejects.toThrow(/lawful basis/);
    expect(await b.db((tx) => tx.selectFrom('contacts').select('id').execute())).toHaveLength(before.length);
    const r = await b.db((tx) => importContacts({ keyring: b.keyring, clock }, tx, {
      rows: [{ email: 'past1@example.com', name: 'Pat' }, { phone: '07700900200' }, { name: 'no contact details' }],
      lawfulBasis: 'legitimate interests: past customers (existing relationship)', acquiredFrom: 'owner\'s previous job book', importedBy: `user:${b.owner}`,
    }));
    expect(r).toMatchObject({ imported: 2, rejected: 1 });
    const c = await b.db((tx) => tx.selectFrom('contacts').select(['source', 'lawful_basis', 'captured_by']).where('source', 'like', 'import:%').execute());
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ lawful_basis: 'legitimate interests: past customers (existing relationship)', captured_by: `import:${r.importId}` });
    const rec = await b.db((tx) => tx.selectFrom('data_imports').selectAll().executeTakeFirstOrThrow());
    expect(rec).toMatchObject({ rows_in: 3, rows_imported: 2, rows_rejected: 1, acquired_from: 'owner\'s previous job book' });
  });
});

describe('[Phase 11] the owner does all of it from the app', () => {
  it('answers → confirm → pack → channel check → go-live, owner credential only', async () => {
    const b = await business(117);
    const team = await b.db(async (tx) => {
      const id = randomUUID();
      await tx.insertInto('users').values({ id, tenant_id: b.t.tenantId, region: b.t.region, role: 'approver', display_name_enc: await b.keyring.seal(tx, { table: 'users', column: 'display_name_enc', rowId: id }, 'Ann Approver') }).execute();
      return id;
    });
    const ownerTok = await b.db((tx) => createUserToken(tx, clock, b.owner));
    const teamTok = await b.db((tx) => createUserToken(tx, clock, team));
    const app = buildServer({ intake: b.intake, publicBaseUrl: 'https://t.example', limiter: new TokenBucketLimiter(clock, { capacity: 100, perMinute: 6000 }), ready: async () => true,
      owner: { db: h.db, keyring: b.keyring, clock, consumers: b.deps.consumers, cellLive: CLEARED } });
    const call = (method: 'GET' | 'POST', url: string, token: string, body?: unknown) => app.inject({ method, url, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { payload: JSON.stringify(body) } : {}) });
    expect((await call('POST', '/v1/owner/onboarding/answers', teamTok, answers())).statusCode).toBe(403);
    expect((await call('POST', '/v1/owner/onboarding/answers', ownerTok, { business: {} })).statusCode).toBe(400);
    const a = await call('POST', '/v1/owner/onboarding/answers', ownerTok, answers());
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ pack_drafted: true, practice_enquiries: { passed: true }, regulated: [] });
    expect((await call('POST', '/v1/owner/onboarding/confirm', ownerTok)).json()).toMatchObject({ confirmed: a.json().records_to_confirm });
    const inbox = (await call('GET', '/v1/owner/inbox', ownerTok)).json() as { questions: { id: string; kind: string; digest: string }[] };
    const pq = inbox.questions.find((q) => q.kind === 'pack_confirm')!;
    expect((await call('POST', `/v1/owner/questions/${pq.id}/answer`, ownerTok, { response: 'confirm', digest: pq.digest })).statusCode).toBe(200);
    const blocked = await call('POST', '/v1/owner/onboarding/go-live', ownerTok);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().missing.join(' ')).toMatch(/Connect at least one way/);
    const ep = await b.db((tx) => createEndpoint(tx, b.keyring, { channel: 'email', lawfulBasis: 'legitimate_interests_enquiry_response', purpose: 'enquiries' }, 'user:owner'));
    const chk = await call('POST', '/v1/owner/onboarding/channel-check', ownerTok, { endpoint_public_id: ep.publicId });
    const code = chk.json().code as string;
    const body = Buffer.from(JSON.stringify({ id: randomUUID(), from: { email: 'owner@brightwindows.example' }, text: `test ${code}` }));
    const ts = Math.floor(clock.nowMs() / 1000);
    await receiveInbound(b.intake, { channel: 'email', publicId: ep.publicId, raw: { body, headers: { 'x-sevari-timestamp': String(ts), 'x-sevari-signature': signWebhook(ep.secret ?? Buffer.alloc(0), ts, body) }, url: 'x' } });
    const list = (await call('GET', '/v1/owner/onboarding/checklist', ownerTok)).json() as { ok: boolean };
    expect(list.ok).toBe(true);
    const go = await call('POST', '/v1/owner/onboarding/go-live', ownerTok);
    expect(go.json()).toMatchObject({ status: 'asked' });
    const q = ((await call('GET', '/v1/owner/inbox', ownerTok)).json() as { questions: { id: string; kind: string; digest: string }[] }).questions.find((x) => x.kind === 'go_live')!;
    clock.advance(5_000);
    const tapped = await call('POST', `/v1/owner/questions/${q.id}/answer`, ownerTok, { response: 'go_live', digest: q.digest });
    expect(tapped.json()).toMatchObject({ accepted: true, outcome: expect.stringMatching(/You're live/) });
    expect(await status(b)).toMatchObject({ status: 'active' });
    expect((await call('POST', '/v1/owner/onboarding/import', ownerTok, { rows: [{ email: 'x@example.com' }], lawful_basis: '', acquired_from: 'old book' })).statusCode).toBe(422);
    await app.close();
  });
});
