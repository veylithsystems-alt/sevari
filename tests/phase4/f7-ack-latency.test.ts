/**
 * F7 (§10.1, Part J §70): ACK latency p50/p95/p99 under 20 concurrent enquiries while "the model is busy".
 * The model doesn't exist until Phase 5, so CPU-bound worker threads stand in for local inference
 * saturating the box. A second run injects a slow messaging provider. Results go to eval/perf/.
 * CI and dev machines are not the target VPS: the authoritative figures come from `pnpm perf` on the
 * 16GB box (CONTRACT_REVIEW R-16). This test enforces the target as a ceiling everywhere.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { signWebhook, signedWebhookAdapter } from '@sevari/channels';
import { SystemClock } from '@sevari/clock';
import { LocalKeyFileKms, TenantKeyring } from '@sevari/crypto';
import { withTenant, workerQueue, type DbHandle, type WorkerQueue } from '@sevari/db';
import { regionCode, type TenantScope } from '@sevari/domain';
import { ACK_JOB, createEndpoint, receiveInbound, type IntakeDeps } from '@sevari/intake';
import { confirmRecord, proposeRecord } from '@sevari/knowledge';
import { FakeProvider } from '@sevari/outbound';
import { runForever, sendAck } from '@sevari/worker';
import { KNOWLEDGE } from '../../eval/fixtures/knowledge.ts';
import { contractSuite } from '../support/contract.ts';
import { dbInfo } from '../support/db.ts';
import { appDb, newTenant } from '../support/fixtures.ts';

const TARGET_P95_MS = 10_000; // F7 default (§15.2), Dan to confirm
const clock = new SystemClock();
const keyring = new TenantKeyring(LocalKeyFileKms.fromKey(Buffer.alloc(32, 8)));
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!;

contractSuite('F7', () => {
  let h: DbHandle;
  let t: TenantScope;
  let queue: WorkerQueue;
  let ep: { publicId: string; secret: Buffer | null };
  let intake: IntakeDeps;
  const burners: Worker[] = [];
  const results: Record<string, unknown> = {};

  beforeAll(async () => {
    h = appDb();
    t = await newTenant(h, 'uk', 'Latency Drains');
    await withTenant(h.db, t, async (tx) => {
      await keyring.provision(tx);
      const k = KNOWLEDGE['drainage']!;
      for (const f of [k.business!, k.hours!]) {
        const r = await proposeRecord(tx, keyring, { body: f.body, source: 'onboarding_interview', proposedBy: 'user:owner' });
        await confirmRecord(tx, clock, { id: r.id, confirmedBy: 'user:owner' });
      }
    });
    ep = await withTenant(h.db, t, (tx) => createEndpoint(tx, keyring, { channel: 'email', lawfulBasis: 'x', purpose: 'x' }, 'user:owner'));
    intake = { db: h.db, keyring, clock, cellRegion: regionCode('uk'), cellUrls: {}, adapters: { email: signedWebhookAdapter('email') } };
    queue = workerQueue(dbInfo().workerUrl, regionCode('uk'));
    // "Model busy": one CPU-bound thread per core, like local inference saturating the box.
    for (let i = 0; i < Math.max(1, cpus().length); i++) {
      burners.push(new Worker('let x = 0; for (;;) { x = (x * 1103515245 + 12345) % 2147483647; }', { eval: true }));
    }
  });
  afterAll(async () => {
    await Promise.all(burners.map((b) => b.terminate()));
    await queue.close();
    await h.close();
    mkdirSync(resolve(import.meta.dirname, '../../eval/perf'), { recursive: true });
    writeFileSync(resolve(import.meta.dirname, '../../eval/perf/f7-latest.json'), JSON.stringify({ host_cpus: cpus().length, target_p95_ms: TARGET_P95_MS, ...results }, null, 2) + '\n');
  });

  async function burst(provider: FakeProvider, label: string): Promise<number[]> {
    const worker = runForever({
      queue, db: h.db, clock, workerId: `f7-${label}`, pollMs: 250, concurrency: 10,
      handlers: { [ACK_JOB]: { scoped: (scope, p) => sendAck({ db: h.db, keyring, clock, provider }, scope, String(p['message_id'])) } },
    });
    const ids = await Promise.all(Array.from({ length: 20 }, async () => {
      const body = Buffer.from(JSON.stringify({ id: randomUUID(), from: { email: `f7-${randomUUID()}@example.com` }, text: 'My drain is blocked, please help' }));
      const ts = Math.floor(clock.nowMs() / 1000);
      const r = await receiveInbound(intake, { channel: 'email', publicId: ep.publicId, raw: { body, headers: { 'x-sevari-timestamp': String(ts), 'x-sevari-signature': signWebhook(ep.secret!, ts, body) }, url: 'x' } });
      return r.status === 'accepted' ? r.messageId : '';
    }));
    const deadline = Date.now() + 60_000;
    let latencies: number[] = [];
    while (Date.now() < deadline) {
      const rows = await withTenant(h.db, t, (tx) => tx.selectFrom('reply_records').select('latency_ms').where('inbound_message_id', 'in', ids).where('send_result', '=', 'sent').execute());
      latencies = rows.map((r) => (r.latency_ms as Record<string, number>)['received_to_provider_accepted'] ?? Infinity);
      if (latencies.length === ids.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await worker.stop();
    results[label] = { n: latencies.length, p50_ms: pct(latencies, 50), p95_ms: pct(latencies, 95), p99_ms: pct(latencies, 99), max_ms: Math.max(...latencies) };
    return latencies;
  }

  it('20 concurrent enquiries with the CPU saturated: every ACK is sent, p95 within the target', async () => {
    const l = await burst(new FakeProvider(), 'model_busy');
    expect(l).toHaveLength(20);
    expect(pct(l, 95)).toBeLessThanOrEqual(TARGET_P95_MS);
  }, 90_000);

  it('and again with a slow messaging provider (1.5s per send, Part J §70)', async () => {
    const slow = new FakeProvider();
    slow.latencyMs = 1_500;
    const l = await burst(slow, 'model_busy_slow_provider');
    expect(l).toHaveLength(20);
    expect(pct(l, 95)).toBeLessThanOrEqual(TARGET_P95_MS);
  }, 90_000);
});
