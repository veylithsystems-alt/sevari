import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consumeApproval, createApproval, payloadDigest } from '@sevari/approvals';
import { ALWAYS_AUTOMATIC, assertConfigCannotUnlock, decide, evidenceFor, grantAutonomy, NEVER_GRANTABLE, RESERVED_DECISIONS } from '@sevari/autonomy';
import { withTenant } from '@sevari/db';
import { FakeProvider, reserve } from '@sevari/outbound';
import { DISPATCH_JOB, sendDraft } from '@sevari/worker';
import { contractSuite } from '../support/contract.ts';
import { draftFor, harness, type Harness } from '../support/hitl-harness.ts';

/** A provider that can neither look a send up nor accept an idempotency key (§66 worst case). */
class BlindProvider extends FakeProvider {
  override readonly supportsLookup = false;
  override readonly supportsIdempotencyKey = false;
  override async lookup(): Promise<null> {
    return null;
  }
}

let x: Harness;
beforeAll(async () => { x = await harness('appr6', 51); });
afterAll(async () => x.close());

const PRICE_Q = 'How much to unblock a drain? CH65 2AB';
async function pending(text = PRICE_Q, h: Harness = x) {
  const m = await h.send(text);
  const r = await h.process(m.messageId);
  const d = await draftFor(h, r.enquiryId);
  if (!d) throw new Error(`no draft (route ${r.route})`);
  const q = await h.question(`draft:${d.id}`);
  return { m, r, d, q: q! };
}
const delivered = (h: Harness, to: string) => [...h.provider.accepted.values()].filter((v) => v.env.to === to);
const replies = (h: Harness, to: string) => delivered(h, to).filter((v) => !/We have received your message|Thank you for waiting/.test(v.env.text));
const approve = async (q: { id: string; digest: string }, h: Harness = x, who?: string) => {
  h.clock.advance(10_000);
  return h.answer({ questionId: q.id, responderId: who ?? h.owner, response: 'approve', digestSeen: q.digest });
};

contractSuite('F6', () => {
  /** An approval row for a pending draft, created the way sendDraft creates one. */
  const freshApproval = async (ttlMs?: number) => {
    const { d, q } = await pending();
    const input = await withTenant(x.h.db, x.t, (tx) => tx.insertInto('human_inputs').values({
      tenant_id: x.t.tenantId, region: x.t.region, question_id: q.id, kind: 'approve_draft', response: 'approve', response_digest: d.content_digest,
      responder_id: x.owner, responder_role: 'owner', channel: 'app', received_at: new Date(x.clock.nowMs()), status: 'recorded',
    }).returning('id').executeTakeFirstOrThrow());
    const id = await withTenant(x.h.db, x.t, (tx) => createApproval(tx, { draftId: d.id, actionClass: d.action_class, digest: d.content_digest, approverId: x.owner, inputId: input.id, ...(ttlMs ? { ttlMs } : {}) }));
    return { id, digest: d.content_digest };
  };

  it('single-use: the second consumption fails', async () => {
    const a = await freshApproval();
    expect(await withTenant(x.h.db, x.t, (tx) => consumeApproval(tx, a.id, a.digest))).toBe(true);
    expect(await withTenant(x.h.db, x.t, (tx) => consumeApproval(tx, a.id, a.digest))).toBe(false);
  });

  it('digest mismatch: an approval for one message can\'t send a different one', async () => {
    const a = await freshApproval();
    const other = payloadDigest({ actionClass: 'info_reply', channel: 'email', recipient: 'someone@example.com', body: 'A different message' });
    expect(await withTenant(x.h.db, x.t, (tx) => consumeApproval(tx, a.id, other))).toBe(false);
    expect(await withTenant(x.h.db, x.t, (tx) => consumeApproval(tx, a.id, a.digest))).toBe(true);
  });

  it('expiry is checked inside the consuming statement, by the database clock', async () => {
    const a = await freshApproval(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await withTenant(x.h.db, x.t, (tx) => consumeApproval(tx, a.id, a.digest))).toBe(false);
  });

  it('concurrent consumption: of 12 simultaneous attempts, exactly one wins', async () => {
    const a = await freshApproval();
    const results = await Promise.all(Array.from({ length: 12 }, () => withTenant(x.h.db, x.t, (tx) => consumeApproval(tx, a.id, a.digest))));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('a consumed approval can\'t be reset or re-pointed (database trigger)', async () => {
    const a = await freshApproval();
    await withTenant(x.h.db, x.t, (tx) => consumeApproval(tx, a.id, a.digest));
    await expect(withTenant(x.h.db, x.t, (tx) => tx.updateTable('approvals').set({ consumed_at: null }).where('id', '=', a.id).execute())).rejects.toThrow(/single-use/);
  });

  it('two people approving the same question at the same moment send exactly one message', async () => {
    const { q, m } = await pending();
    await withTenant(x.h.db, x.t, (tx) => tx.insertInto('user_permissions').values({ tenant_id: x.t.tenantId, region: x.t.region, user_id: x.approver, action_class: 'info_reply', granted_by: x.owner }).execute()).catch(() => undefined);
    x.clock.advance(10_000);
    const both = await Promise.all([x.owner, x.approver].map((u) => x.answer({ questionId: q.id, responderId: u, response: 'approve', digestSeen: q.digest })));
    expect(both.filter((r) => r.accepted)).toHaveLength(1);
    expect(both.find((r) => !r.accepted)).toMatchObject({ reason: 'closed' });
    await x.drain();
    expect(replies(x, m.from)).toHaveLength(1);
  });
});

contractSuite('F8', () => {
  it('assist mode: nothing is reserved or sent until a human approves', async () => {
    const { d, q, m } = await pending();
    const before = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('outbox').select('id').where('dedupe_key', '=', `draft:${d.id}`).execute());
    expect(before).toHaveLength(0);
    await x.drain();
    expect(replies(x, m.from)).toHaveLength(0);
    await approve(q);
    await x.drain();
    expect(replies(x, m.from)).toHaveLength(1);
  });

  it('a forged grant or a missing approval is refused before anything is reserved', async () => {
    const { d } = await pending();
    const r = await withTenant(x.h.db, x.t, (tx) => sendDraft({ keyring: x.keyring, clock: x.clock }, tx, d.id, { kind: 'grant', grantId: '00000000-0000-4000-8000-000000000000' }));
    expect(r).toMatchObject({ status: 'refused', reason: 'approval' });
    const rows = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('outbox').select('id').where('dedupe_key', '=', `draft:${d.id}`).execute());
    expect(rows).toHaveLength(0);
  });

  it('ungrounded text can never be reserved for sending (INV-5)', async () => {
    const { d } = await pending();
    await expect(withTenant(x.h.db, x.t, (tx) => reserve(tx, x.keyring, x.clock, {
      draft: { text: 'Free visit!', purpose: 'reply', claims: [], factsUsed: [] } as never, conversationId: d.conversation_id, contactId: d.contact_id,
      channel: 'email', recipient: 'a@example.com', actionClass: 'info_reply', dedupeKey: 'forged',
    }))).rejects.toThrow(/INV-5/);
  });

  it('autonomy mode: a grant sends that class without asking; other classes still ask; a complaint switches every grant off', async () => {
    const y = await harness('auto6', 52);
    try {
      // The grant is inserted directly here to test the send path; how a grant is earned is tested below.
      const grant = await withTenant(y.h.db, y.t, async (tx) => {
        const q = await tx.insertInto('human_questions').values({
          tenant_id: y.t.tenantId, region: y.t.region, kind: 'autonomy_grant', subject_ref: 'class:info_reply', content_digest: Buffer.alloc(32), body_enc: Buffer.alloc(1), options: ['grant'],
          safe_default: 'hold', consumer_kind: 'autonomy.grant', consumer_ref: 'info_reply', required_role: 'owner', deadline_at: new Date(y.clock.nowMs() + 60_000), presented_at: new Date(y.clock.nowMs()), status: 'answered',
        }).returning('id').executeTakeFirstOrThrow();
        const i = await tx.insertInto('human_inputs').values({ tenant_id: y.t.tenantId, region: y.t.region, question_id: q.id, kind: 'autonomy_grant', response: 'grant', response_digest: Buffer.alloc(32), responder_id: y.owner, responder_role: 'owner', channel: 'app', received_at: new Date(y.clock.nowMs()), status: 'recorded' }).returning('id').executeTakeFirstOrThrow();
        return tx.insertInto('autonomy_grants').values({ tenant_id: y.t.tenantId, region: y.t.region, action_class: 'info_reply', input_id: i.id, granted_by: y.owner, evidence: JSON.stringify({ test: true }) }).returning('id').executeTakeFirstOrThrow();
      });
      expect(await withTenant(y.h.db, y.t, (tx) => decide(tx, 'info_reply'))).toEqual({ mode: 'granted', grantId: grant.id });
      const m1 = await y.send(PRICE_Q);
      await y.process(m1.messageId);
      await y.drain();
      expect(replies(y, m1.from)).toHaveLength(1);
      const rec = await withTenant(y.h.db, y.t, (tx) => tx.selectFrom('reply_records').select('autonomy_decision').where('autonomy_decision', '=', `grant:${grant.id}`).execute());
      expect(rec.length).toBeGreaterThanOrEqual(1);
      // A quote is a different class: it still needs a human.
      const m2 = await y.send('Please can I get a quote for a CCTV drain survey? CH65 2AB');
      const r2 = await y.process(m2.messageId);
      const d2 = await draftFor(y, r2.enquiryId);
      expect(d2).toMatchObject({ action_class: 'quote_reply', status: 'pending_approval' });
      // Kill switch: a complaint revokes every grant.
      const m3 = await y.send('I want to make a formal complaint about your engineer.');
      await y.process(m3.messageId);
      expect(await withTenant(y.h.db, y.t, (tx) => decide(tx, 'info_reply'))).toMatchObject({ mode: 'approval' });
      const m4 = await y.send(PRICE_Q);
      const r4 = await y.process(m4.messageId);
      expect((await draftFor(y, r4.enquiryId))?.status).toBe('pending_approval');
      await expect(withTenant(y.h.db, y.t, (tx) => tx.updateTable('autonomy_grants').set({ revoked_at: null }).where('id', '=', grant.id).execute())).rejects.toThrow(/cannot be reinstated/);
    } finally {
      await y.close();
    }
  });

  it('a grant has to be earned: too few drafts in the window means no grant', async () => {
    const ev = await withTenant(x.h.db, x.t, (tx) => evidenceFor(tx, 'info_reply'));
    expect(ev.eligible).toBe(false);
    expect(ev.reasons.some((r) => r.startsWith('needs_50_drafts'))).toBe(true);
    await expect(withTenant(x.h.db, x.t, (tx) => grantAutonomy(tx, { actionClass: 'info_reply', inputId: '00000000-0000-4000-8000-000000000000', grantedBy: x.owner }))).rejects.toThrow(/not eligible/);
  });
});

contractSuite('T-RES', () => {
  it('reserved classes can never be granted: not by code, not by a direct database write', async () => {
    for (const cls of ['refund', 'payment_request', 'cancel']) {
      await expect(withTenant(x.h.db, x.t, (tx) => grantAutonomy(tx, { actionClass: cls, inputId: '00000000-0000-4000-8000-000000000000', grantedBy: x.owner }))).rejects.toThrow(/INV-11/);
      await expect(withTenant(x.h.db, x.t, (tx) => tx.insertInto('autonomy_grants').values({ tenant_id: x.t.tenantId, region: x.t.region, action_class: cls, input_id: '00000000-0000-4000-8000-000000000000', granted_by: x.owner, evidence: '{}' }).execute())).rejects.toThrow(/check constraint/);
      expect(await withTenant(x.h.db, x.t, (tx) => decide(tx, cls as 'refund'))).toEqual({ mode: 'approval', reason: 'never_grantable' });
    }
  });

  it('no configuration value, environment variable or edit to the lists can unlock them', async () => {
    process.env['SEVARI_UNLOCK_REFUND'] = '1';
    process.env['SEVARI_AUTO_APPROVE'] = 'true';
    try {
      expect(await withTenant(x.h.db, x.t, (tx) => decide(tx, 'refund'))).toEqual({ mode: 'approval', reason: 'never_grantable' });
    } finally {
      delete process.env['SEVARI_UNLOCK_REFUND'];
      delete process.env['SEVARI_AUTO_APPROVE'];
    }
    for (const cfg of [{ autonomy: { refund: 'auto' } }, { unlock: ['activate_customer'] }, { skip_approval: true }, { thresholds: { payment_request: 0 } }, { override_reserved: 'dsar_release' }]) {
      expect(() => assertConfigCannotUnlock(cfg), JSON.stringify(cfg)).toThrow(/INV-11/);
    }
    expect(() => assertConfigCannotUnlock({ thresholds: { windowN: 60, maxEditRate: 0.05 } })).not.toThrow();
    expect(Object.isFrozen(RESERVED_DECISIONS)).toBe(true);
    expect(() => (RESERVED_DECISIONS as unknown as string[]).push('nothing')).toThrow();
    expect(NEVER_GRANTABLE.has('refund') && ALWAYS_AUTOMATIC.has('ack')).toBe(true);
  });
});

contractSuite('T-CHAOS', () => {
  it('the worker dies holding the send job: the lease expires, another worker resumes, one message is sent', async () => {
    const { q, m } = await pending();
    await approve(q);
    const claimed = await x.queue.claim({ workerId: 'doomed', limit: 10, leaseMs: 1, kinds: [DISPATCH_JOB] });
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 20)); // the doomed worker never finishes
    await x.drain();
    expect(replies(x, m.from)).toHaveLength(1);
  });

  it('the worker dies after the provider accepted but before recording it: reconciled, never re-sent', async () => {
    const { q, m, d } = await pending();
    x.provider.script.push('timeout_after_accept');
    await approve(q);
    await x.drain();
    expect(replies(x, m.from)).toHaveLength(1);
    expect((await draftFor(x, d.enquiry_id!))?.status).toBe('sent');
    // A duplicate of the send job (e.g. a second worker) changes nothing.
    const outboxId = (await draftFor(x, d.enquiry_id!))!.outbox_id!;
    await withTenant(x.h.db, x.t, (tx) => tx.insertInto('job_queue').values({ tenant_id: x.t.tenantId, region: x.t.region, kind: DISPATCH_JOB, dedupe_key: `dup:${outboxId}`, payload: JSON.stringify({ draft_id: d.id, outbox_id: outboxId, input_id: null, grant_id: null }) }).execute());
    await x.drain();
    expect(replies(x, m.from)).toHaveLength(1);
  });
});

describe('external delivery is never assumed exactly-once (Part J §66)', () => {
  contractSuite('F46', () => {
    it('crash before the provider accepted: after recovery, exactly one send', async () => {
      const { q, m } = await pending();
      x.provider.script.push('timeout_before_accept');
      await approve(q);
      await x.drain();
      expect(replies(x, m.from)).toHaveLength(1);
    });
  });

  contractSuite('F47', () => {
    it('crash after acceptance, before the result was saved: reconciled to sent; no second delivery', async () => {
      const { q, m } = await pending();
      x.provider.script.push('timeout_after_accept');
      const before = x.provider.deliveries;
      await approve(q);
      await x.drain();
      expect(x.provider.deliveries - before).toBe(1);
      expect(replies(x, m.from)).toHaveLength(1);
    });
  });

  contractSuite('F48', () => {
    it('ambiguous timeout with a provider that can\'t be asked: escalated to a person, never blindly retried', async () => {
      const blind = new BlindProvider();
      const y = await harness('blind6', 53, blind);
      try {
        const { q, m } = await pending(PRICE_Q, y);
        blind.script.push('timeout_after_accept');
        const ans = await approve(q, y);
        await y.drain();
        expect(delivered(y, m.from).filter((v) => !/We have received your message/.test(v.env.text))).toHaveLength(1);
        const outbox = await withTenant(y.h.db, y.t, (tx) => tx.selectFrom('outbox').select('state').where('action_class', '=', 'info_reply').execute());
        expect(outbox.map((o) => o.state)).toEqual(['ambiguous']);
        const notes = (await y.notices(y.owner)).filter((n) => n.ref === `input:${ans.inputId}`);
        expect(notes.map((n) => n.kind)).toEqual(['ack', 'failure']);
        expect(notes[1]?.text).toMatch(/could not confirm/);
      } finally {
        await y.close();
      }
    });
  });

  contractSuite('F49', () => {
    it('duplicate webhooks and provider retries have one effect', async () => {
      // The same inbound webhook twice: one message, one enquiry, one draft, one question.
      const body = Buffer.from(JSON.stringify({ id: 'dup-provider-msg-1', from: { email: 'dupe@example.com' }, text: PRICE_Q }));
      const { signWebhook } = await import('@sevari/channels');
      const { receiveInbound } = await import('@sevari/intake');
      const ep = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('channel_endpoints').select(['public_id']).where('channel', '=', 'email').executeTakeFirstOrThrow());
      const secret = await withTenant(x.h.db, x.t, async (tx) => {
        const row = await tx.selectFrom('channel_endpoints').select(['id', 'secret_enc']).where('channel', '=', 'email').executeTakeFirstOrThrow();
        return x.keyring.open(tx, { table: 'channel_endpoints', column: 'secret_enc', rowId: row.id }, row.secret_enc!);
      });
      const ts = Math.floor(x.clock.nowMs() / 1000);
      const raw = { body, headers: { 'x-sevari-timestamp': String(ts), 'x-sevari-signature': signWebhook(secret, ts, body) }, url: 'x' };
      const a = await receiveInbound(x.intake, { channel: 'email', publicId: ep.public_id, raw });
      const b = await receiveInbound(x.intake, { channel: 'email', publicId: ep.public_id, raw });
      expect(a.status === 'accepted' && b.status === 'accepted' && a.messageId === b.messageId && b.duplicate).toBe(true);
      const id = a.status === 'accepted' ? a.messageId : '';
      const r1 = await x.process(id);
      const r2 = await x.process(id);
      expect(r2.enquiryId).toBe(r1.enquiryId);
      const drafts = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('drafts').select('id').where('enquiry_id', '=', r1.enquiryId).execute());
      expect(drafts).toHaveLength(1);
      // Provider-side retry of the same send: the reference is the idempotency key, one delivery.
      const q = await x.question(`draft:${drafts[0]!.id}`);
      await approve(q!);
      await x.drain();
      const d = await draftFor(x, r1.enquiryId);
      const before = x.provider.deliveries;
      const again = await x.provider.send({ reference: d!.outbox_id!, channel: 'email', to: 'dupe@example.com', text: 'retry' });
      expect(again.status).toBe('accepted');
      expect(x.provider.deliveries).toBe(before);
      expect(replies(x, 'dupe@example.com')).toHaveLength(1);
    });
  });

  contractSuite('F50', () => {
    it('a consequential class (a quote) never auto-retries an ambiguous send, even when retry looks safe', async () => {
      const { q, m, d } = await pending('Please can I get a quote for a CCTV drain survey? CH65 2AB');
      expect(d.action_class).toBe('quote_reply');
      x.provider.script.push('timeout_before_accept'); // the provider never got it; a retry would be "safe"
      const ans = await approve(q);
      await x.drain();
      expect(replies(x, m.from)).toHaveLength(0);
      const notes = (await x.notices(x.owner)).filter((n) => n.ref === `input:${ans.inputId}`);
      expect(notes.map((n) => n.kind)).toEqual(['ack', 'failure']);
    });
  });
});
