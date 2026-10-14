import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@sevari/db';
import { ask, answer, digestOf, EFFECT_SLA_MS, MAX_CLARIFICATIONS } from '@sevari/hitl';
import { authenticate, createUserToken, newOperatorToken, platformDecision } from '@sevari/identity';
import { buildServer, TokenBucketLimiter } from '@sevari/api';
import { contractSuite } from '../support/contract.ts';
import { draftFor, harness, type Harness } from '../support/hitl-harness.ts';
import { ownerQuery } from '../support/fixtures.ts';

let x: Harness;
beforeAll(async () => { x = await harness('hitl18', 31); });
afterAll(async () => x.close());

const PRICE_Q = 'How much to unblock a drain? CH65 2AB';
/** An enquiry processed into a draft awaiting approval; returns its question. */
async function pending(text = PRICE_Q) {
  const m = await x.send(text);
  const r = await x.process(m.messageId);
  const d = await draftFor(x, r.enquiryId);
  if (!d) throw new Error(`no draft for "${text}" (route ${r.route})`);
  const q = await x.question(`draft:${d.id}`);
  if (!q) throw new Error('no question');
  return { m, r, d, q };
}
const deliveredTo = (to: string) => [...x.provider.accepted.values()].filter((v) => v.env.to === to);
const approvalsFor = (draftId: string) => withTenant(x.h.db, x.t, (tx) => tx.selectFrom('approvals').select('id').where('draft_id', '=', draftId).execute());
const inputsFor = (questionId: string) => withTenant(x.h.db, x.t, (tx) => tx.selectFrom('human_inputs').selectAll().where('question_id', '=', questionId).orderBy('created_at').execute());
const ackFor = async (userId: string, inputId: string) => (await x.notices(userId)).filter((n) => n.ref === `input:${inputId}`);
const grantPermission = (userId: string, actionClass: string) => withTenant(x.h.db, x.t, (tx) => tx.insertInto('user_permissions').values({ tenant_id: x.t.tenantId, region: x.t.region, user_id: userId, action_class: actionClass, granted_by: x.owner }).returning('id').executeTakeFirstOrThrow());

contractSuite('F22', () => {
  it('a question can\'t be asked without a registered consumer (INV-12)', async () => {
    await expect(withTenant(x.h.db, x.t, (tx) => ask({ keyring: x.keyring, clock: x.clock, consumers: {} }, tx, {
      kind: 'owner_task', subjectRef: 'enquiry:none', contentDigest: digestOf({ a: 1 }), requiredRole: 'owner', options: ['handled'], safeDefault: 'hold',
      consumer: { kind: 'nobody.listens', ref: 'x' }, deadlineMs: 60_000, body: { title: 't', summary: 's', optionLabels: { handled: 'h' }, safeDefaultText: 'nothing' },
    }))).rejects.toThrow(/INV-12/);
  });

  it('a response whose consumer is missing is rejected, recorded and acknowledged', async () => {
    const { q } = await pending();
    const r = await withTenant(x.h.db, x.t, (tx) => answer({ keyring: x.keyring, clock: x.clock, consumers: {} }, tx, { questionId: q.id, responderId: x.owner, response: 'approve', digestSeen: q.digest, channel: 'app' }));
    expect(r).toMatchObject({ accepted: false, reason: 'no_consumer' });
    const [input] = await inputsFor(q.id);
    expect(input).toMatchObject({ status: 'rejected', rejection_reason: 'no_consumer' });
    expect(await ackFor(x.owner, input!.id)).toHaveLength(1);
  });

  it('the database refuses a question with an empty consumer', async () => {
    await expect(withTenant(x.h.db, x.t, (tx) => tx.insertInto('human_questions').values({
      tenant_id: x.t.tenantId, region: x.t.region, kind: 'owner_task', subject_ref: 's', content_digest: Buffer.alloc(32), body_enc: Buffer.alloc(1), options: ['a'],
      safe_default: 'hold', consumer_kind: '', consumer_ref: 'r', required_role: 'owner', deadline_at: new Date(x.clock.nowMs() + 1000), presented_at: new Date(x.clock.nowMs()),
    }).execute())).rejects.toThrow(/check constraint/);
  });
});

contractSuite('F23', () => {
  it('an applied input always has a receipt that names the exact effect', async () => {
    const { q, m } = await pending();
    x.clock.advance(10_000);
    const r = await x.answer({ questionId: q.id, responderId: x.owner, response: 'approve', digestSeen: q.digest });
    expect(r.accepted).toBe(true);
    await x.drain();
    const [input] = await inputsFor(q.id);
    expect(input?.status).toBe('applied');
    const receipt = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('effect_receipts').selectAll().where('id', '=', input!.effect_receipt_id!).executeTakeFirstOrThrow());
    const outbox = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('outbox').select(['id', 'state']).where('id', '=', receipt.effect_ref.replace('outbox:', '')).executeTakeFirstOrThrow());
    expect(receipt).toMatchObject({ effect_kind: 'message.sent', outcome: 'done' });
    expect(outbox.state).toBe('sent');
    expect(deliveredTo(m.from)).toHaveLength(2); // the acknowledgement and the approved reply
  });

  it('the database refuses "applied" without a receipt', async () => {
    const { q } = await pending();
    x.clock.advance(10_000);
    await x.answer({ questionId: q.id, responderId: x.owner, response: 'approve', digestSeen: q.digest });
    const [input] = await inputsFor(q.id);
    await expect(withTenant(x.h.db, x.t, (tx) => tx.updateTable('human_inputs').set({ status: 'applied' }).where('id', '=', input!.id).execute())).rejects.toThrow(/check constraint/);
    await x.drain();
  });

  it('a missing receipt past its deadline raises an alert to the approver and the owner', async () => {
    const { q } = await pending();
    x.clock.advance(10_000);
    await x.answer({ questionId: q.id, responderId: x.approver, response: 'approve', digestSeen: q.digest }); // rejected: no permission yet
    await grantPermission(x.approver, 'info_reply');
    const { q: q2 } = await pending();
    x.clock.advance(10_000);
    const r = await x.answer({ questionId: q2.id, responderId: x.approver, response: 'approve', digestSeen: q2.digest });
    expect(r.accepted).toBe(true);
    // The send job never runs (the worker is down). Time passes beyond the receipt deadline.
    x.clock.advance(EFFECT_SLA_MS + 1_000);
    const report = await x.sweep();
    expect(report.receiptAlerts).toBeGreaterThanOrEqual(1);
    const [, input] = [undefined, (await inputsFor(q2.id))[0]];
    for (const u of [x.approver, x.owner]) expect((await x.notices(u)).some((n) => n.kind === 'alert' && n.ref === `input:${input!.id}`)).toBe(true);
    await x.drain();
    expect((await inputsFor(q2.id))[0]?.status).toBe('applied');
  });
});

contractSuite('F24', () => {
  it('timeout: the question closes to its safe default; nothing is approved or sent', async () => {
    const { q, d, m } = await pending();
    x.clock.advance(73 * 3_600_000);
    const report = await x.sweep();
    expect(report.expired).toBeGreaterThanOrEqual(1);
    expect((await x.question(`draft:${d.id}`))?.status).toBe('expired');
    expect((await draftFor(x, d.enquiry_id!))?.status).toBe('expired');
    expect(await approvalsFor(d.id)).toHaveLength(0);
    expect(deliveredTo(m.from).filter((v) => !v.env.text.includes('We have received your message') && !v.env.text.includes('thanks for waiting') && !v.env.text.includes('Thank you for waiting'))).toHaveLength(0);
    // An answer after the deadline is refused, never applied.
    const late = await x.answer({ questionId: q.id, responderId: x.owner, response: 'approve', digestSeen: q.digest });
    expect(late).toMatchObject({ accepted: false });
  });

  it('ambiguity: an answer that isn\'t an option changes nothing; repeated ambiguity escalates', async () => {
    const { q, d } = await pending();
    for (let i = 0; i < MAX_CLARIFICATIONS; i++) {
      const r = await x.answer({ questionId: q.id, responderId: x.owner, response: 'yes but cheaper', digestSeen: q.digest });
      expect(r).toMatchObject({ accepted: false, reason: 'ambiguous' });
    }
    expect(await approvalsFor(d.id)).toHaveLength(0);
    const row = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('human_questions').select(['clarifications', 'next_escalation_at', 'status']).where('id', '=', q.id).executeTakeFirstOrThrow());
    expect(row).toMatchObject({ clarifications: MAX_CLARIFICATIONS, status: 'open' });
    expect(row.next_escalation_at).not.toBeNull();
  });

  it('wrong role and stale content are refused, recorded and acknowledged', async () => {
    const { q, d } = await pending();
    const viewer = await x.answer({ questionId: q.id, responderId: x.viewer, response: 'approve', digestSeen: q.digest });
    expect(viewer).toMatchObject({ accepted: false, reason: 'wrong_role' });
    const stale = await x.answer({ questionId: q.id, responderId: x.owner, response: 'approve', digestSeen: 'a'.repeat(64) });
    expect(stale).toMatchObject({ accepted: false, reason: 'stale' });
    expect(await approvalsFor(d.id)).toHaveLength(0);
    const inputs = await inputsFor(q.id);
    expect(inputs.map((i) => i.rejection_reason)).toEqual(['wrong_role', 'stale']);
  });

  it('stale facts: a price that changed after drafting stops the send even with a valid approval (INV-15)', async () => {
    const { q, d, m } = await pending();
    await withTenant(x.h.db, x.t, async (tx) => {
      const { proposeRecord, confirmRecord } = await import('@sevari/knowledge');
      const r = await proposeRecord(tx, x.keyring, { body: { kind: 'price', service_code: 'blocked_drain', basis: 'fixed', amount_minor: 11_000, vat: 'inclusive' }, source: 'owner_edit', proposedBy: 'user:owner' });
      await confirmRecord(tx, x.clock, { id: r.id, confirmedBy: 'user:owner' });
    });
    x.clock.advance(10_000);
    const r = await x.answer({ questionId: q.id, responderId: x.owner, response: 'approve', digestSeen: q.digest });
    expect(r).toMatchObject({ accepted: true, outcome: expect.stringMatching(/changed after this reply was written/) });
    expect((await draftFor(x, d.enquiry_id!))?.status).toBe('superseded');
    expect(deliveredTo(m.from)).toHaveLength(1); // the acknowledgement only
  });
});

contractSuite('F25', () => {
  it('an edit that changes a fact asks "one-off or update records?" and changes no records', async () => {
    const { q, d, m } = await pending('Can you do a CCTV drain survey? CH65 2AB');
    const pricesBefore = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('knowledge_records').select('id').execute());
    x.clock.advance(10_000);
    const edited = 'Hello,\n\nA CCTV drain survey is £130 for you this week.\n\nPort Drains (example)';
    const r = await x.answer({ questionId: q.id, responderId: x.owner, response: 'edit', digestSeen: q.digest, detail: edited });
    expect(r).toMatchObject({ accepted: true, outcome: expect.stringMatching(/one quick question/) });
    const child = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('drafts').selectAll().where('parent_id', '=', d.id).executeTakeFirstOrThrow());
    expect(child).toMatchObject({ generator: 'human', status: 'pending_approval', draft_version: 2 });
    const clar = await x.question(`draft:${child.id}`);
    expect(clar?.kind).toBe('clarify_edit');
    expect(await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('knowledge_records').select('id').execute())).toHaveLength(pricesBefore.length);
    expect(deliveredTo(m.from)).toHaveLength(1);
    // The answer drives the effect: one-off → the owner's own words are sent.
    x.clock.advance(10_000);
    const r2 = await x.answer({ questionId: clar!.id, responderId: x.owner, response: 'one_off', digestSeen: clar!.digest });
    expect(r2.accepted).toBe(true);
    await x.drain();
    expect(deliveredTo(m.from).map((v) => v.env.text)).toContain(edited);
  });

  it('an edit that only changes wording is sent without a clarification', async () => {
    const { q, d, m } = await pending('Can you do a CCTV drain survey? CH65 2AB');
    x.clock.advance(10_000);
    const edited = 'Hi there, thanks for getting in touch. CCTV drain survey: from £150 including VAT. Port Drains (example)';
    await x.answer({ questionId: q.id, responderId: x.owner, response: 'edit', digestSeen: q.digest, detail: edited });
    await x.drain();
    const child = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('drafts').select(['id', 'status']).where('parent_id', '=', d.id).executeTakeFirstOrThrow());
    expect(child.status).toBe('sent');
    expect(deliveredTo(m.from).map((v) => v.env.text)).toContain(edited);
  });
});

contractSuite('F26', () => {
  it('an owner-only question can\'t be answered by an approver, even one with permissions', async () => {
    const m = await x.send('I want to make a formal complaint about the engineer who visited.');
    const r = await x.process(m.messageId);
    const q = await x.question(`enquiry:${r.enquiryId}`);
    expect(q?.kind).toBe('owner_task');
    const a = await x.answer({ questionId: q!.id, responderId: x.approver, response: 'handled', digestSeen: q!.digest });
    expect(a).toMatchObject({ accepted: false, reason: 'wrong_role' });
    x.clock.advance(10_000);
    expect((await x.answer({ questionId: q!.id, responderId: x.owner, response: 'handled', digestSeen: q!.digest })).accepted).toBe(true);
  });
});

contractSuite('F27', () => {
  it('instant approvals are flagged, and a pattern of them warns the owner', async () => {
    let flagged = 0;
    for (let i = 0; i < 5; i++) {
      const { q } = await pending();
      const r = await x.answer({ questionId: q.id, responderId: x.owner, response: 'approve', digestSeen: q.digest }); // no time passes: 0 ms
      expect(r.accepted).toBe(true);
      if ((await inputsFor(q.id))[0]?.rubber_stamp) flagged++;
    }
    expect(flagged).toBe(5);
    await x.drain();
    const report = await x.sweep();
    expect(report.rubberStampWarnings + (await x.notices(x.owner)).filter((n) => n.kind === 'warning' && n.text.includes('under 2 seconds')).length).toBeGreaterThanOrEqual(1);
    // A considered approval is not flagged.
    const { q } = await pending();
    x.clock.advance(8_000);
    await x.answer({ questionId: q.id, responderId: x.owner, response: 'approve', digestSeen: q.digest });
    expect((await inputsFor(q.id))[0]?.rubber_stamp).toBe(false);
    await x.drain();
  });
});

contractSuite('F51', () => {
  it('every input, accepted or not, is acknowledged at once on its channel', async () => {
    const { q } = await pending();
    const bad = await x.answer({ questionId: q.id, responderId: x.owner, response: 'maybe', digestSeen: q.digest });
    x.clock.advance(5_000);
    const good = await x.answer({ questionId: q.id, responderId: x.owner, response: 'reject', digestSeen: q.digest });
    for (const r of [bad, good]) {
      expect(r.ack.length).toBeGreaterThan(10);
      expect(r.inputId).toBeTruthy();
      const acks = await ackFor(x.owner, r.inputId!);
      expect(acks.filter((n) => n.kind === 'ack').map((n) => n.text)).toEqual([r.ack]);
    }
  });
});

contractSuite('F52', () => {
  it('an applied input gets an outcome confirmation; a failed effect gets a failure notice', async () => {
    const { q } = await pending();
    x.clock.advance(10_000);
    const ok = await x.answer({ questionId: q.id, responderId: x.owner, response: 'approve', digestSeen: q.digest });
    await x.drain();
    expect((await ackFor(x.owner, ok.inputId!)).map((n) => n.kind)).toEqual(['ack', 'outcome']);
    const { q: q2 } = await pending();
    x.provider.script.push('reject');
    x.clock.advance(10_000);
    const bad = await x.answer({ questionId: q2.id, responderId: x.owner, response: 'approve', digestSeen: q2.digest });
    await x.drain();
    const notes = await ackFor(x.owner, bad.inputId!);
    expect(notes.map((n) => n.kind)).toEqual(['ack', 'failure']);
    expect(notes[1]?.text).toMatch(/could not be delivered/);
  });
});

contractSuite('F53', () => {
  it('a pending approval past the promised reply time produces exactly one holding update and no other send', async () => {
    const { m, d } = await pending();
    expect(deliveredTo(m.from)).toHaveLength(1); // the acknowledgement
    x.clock.advance(121 * 60_000); // reply_due_minutes defaults to 120
    await x.sweep();
    await x.drain();
    x.clock.advance(60 * 60_000);
    await x.sweep();
    await x.drain();
    const sent = deliveredTo(m.from).map((v) => v.env.text);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/Thank you for waiting/);
    expect(sent[1]).not.toMatch(/£|\d{2}:\d{2}/);
    expect((await draftFor(x, d.enquiry_id!))?.status).toBe('pending_approval');
  });
});

contractSuite('F54', () => {
  it('silence and timeouts never approve: after escalation and the deadline, there is no approval and no send', async () => {
    const { m, d } = await pending();
    for (let i = 0; i < 10; i++) {
      x.clock.advance(8 * 3_600_000);
      await x.sweep();
      await x.drain();
    }
    expect(await approvalsFor(d.id)).toHaveLength(0);
    expect(['expired', 'pending_approval']).toContain((await draftFor(x, d.enquiry_id!))?.status);
    expect(deliveredTo(m.from).every((v) => !v.env.text.includes('£95'))).toBe(true);
  });

  it('the schema has no "approve" safe default', async () => {
    await expect(withTenant(x.h.db, x.t, (tx) => tx.insertInto('human_questions').values({
      tenant_id: x.t.tenantId, region: x.t.region, kind: 'approve_draft', subject_ref: 's2', content_digest: Buffer.alloc(32), body_enc: Buffer.alloc(1), options: ['approve'],
      safe_default: 'approve' as 'hold', consumer_kind: 'draft.send', consumer_ref: 'r', required_role: 'owner', deadline_at: new Date(x.clock.nowMs() + 1000), presented_at: new Date(x.clock.nowMs()),
    }).execute())).rejects.toThrow(/check constraint/);
  });
});

contractSuite('F55', () => {
  it('an approver can approve only the classes the owner granted them, and only while granted', async () => {
    const u = await withTenant(x.h.db, x.t, async (tx) => {
      const { randomUUID } = await import('node:crypto');
      const id = randomUUID();
      await tx.insertInto('users').values({ id, tenant_id: x.t.tenantId, region: x.t.region, role: 'approver', display_name_enc: await x.keyring.seal(tx, { table: 'users', column: 'display_name_enc', rowId: id }, 'Pat') }).execute();
      return id;
    });
    const { q: q1 } = await pending();
    expect(await x.answer({ questionId: q1.id, responderId: u, response: 'approve', digestSeen: q1.digest })).toMatchObject({ accepted: false, reason: 'not_permitted' });
    expect((await x.notices(x.owner)).some((n) => n.kind === 'warning' && n.text.includes('permission'))).toBe(true);
    // Permission for a different class doesn't help.
    await grantPermission(u, 'quote_reply');
    expect(await x.answer({ questionId: q1.id, responderId: u, response: 'approve', digestSeen: q1.digest })).toMatchObject({ accepted: false, reason: 'not_permitted' });
    const perm = await grantPermission(u, 'info_reply');
    x.clock.advance(10_000);
    expect((await x.answer({ questionId: q1.id, responderId: u, response: 'approve', digestSeen: q1.digest })).accepted).toBe(true);
    await x.drain();
    // Revoked: refused again.
    await withTenant(x.h.db, x.t, (tx) => tx.updateTable('user_permissions').set({ revoked_at: new Date(x.clock.nowMs()) }).where('id', '=', perm.id).execute());
    const { q: q2 } = await pending();
    expect(await x.answer({ questionId: q2.id, responderId: u, response: 'approve', digestSeen: q2.digest })).toMatchObject({ accepted: false, reason: 'not_permitted' });
  });
});

describe('operator and platform credentials', () => {
  let opToken: string;
  let opId: string;
  let ownerToken: string;
  beforeAll(async () => {
    const t = newOperatorToken();
    opToken = t.full;
    opId = (await ownerQuery('INSERT INTO operators (display_name, prefix, token_hash) VALUES ($1, $2, $3) RETURNING id', ['Test Operator', t.prefix, t.hash])).rows[0].id;
    ownerToken = await withTenant(x.h.db, x.t, (tx) => createUserToken(tx, x.clock, x.owner));
  });
  const server = () => buildServer({ intake: x.intake, publicBaseUrl: 'https://test.example', limiter: new TokenBucketLimiter(x.clock, { capacity: 100, perMinute: 6000 }), ready: async () => true, owner: { db: x.h.db, keyring: x.keyring, clock: x.clock, consumers: x.deps.consumers } });

  contractSuite('F56', () => {
    it('a platform decision with a tenant credential (any role) is refused and audited; an operator\'s is recorded', async () => {
      const cred = await authenticate(x.h.db, x.clock, ownerToken);
      expect(cred?.kind).toBe('user');
      await expect(platformDecision(x.h.db, cred!, { decision: 'activate_regulated_tenant', subjectRef: `tenant:${x.t.tenantId}`, reason: 'test' })).rejects.toThrow(/§82/);
      const audit = await withTenant(x.h.db, x.t, (tx) => tx.selectFrom('audit_events').select('event_type').where('event_type', '=', 'security.platform_decision_refused').execute());
      expect(audit.length).toBeGreaterThanOrEqual(1);
      const app = server();
      const viaApi = await app.inject({ method: 'POST', url: '/v1/platform/decisions', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }, payload: JSON.stringify({ decision: 'activate_regulated_tenant', subject_ref: 'tenant:x', reason: 'test' }) });
      expect(viaApi.statusCode).toBe(403);
      const ok = await app.inject({ method: 'POST', url: '/v1/platform/decisions', headers: { authorization: `Bearer ${opToken}`, 'content-type': 'application/json' }, payload: JSON.stringify({ decision: 'activate_regulated_tenant', subject_ref: 'tenant:x', reason: 'counsel signed off' }) });
      expect(ok.statusCode).toBe(201);
      await app.close();
    });
  });

  contractSuite('F57', () => {
    it('an unanswered approval moves down the owner\'s list, the owner is told, and nothing is approved by the timeout', async () => {
      await withTenant(x.h.db, x.t, (tx) => tx.insertInto('approval_routes').values({ tenant_id: x.t.tenantId, region: x.t.region, position: 1, user_id: x.approver, after_minutes: 30 }).execute());
      await grantPermission(x.approver, 'info_reply').catch(() => undefined);
      const { q, d } = await pending();
      expect(q.assigned).toBe(x.owner);
      x.clock.advance(31 * 60_000);
      const rep = await x.sweep();
      expect(rep.escalated).toBeGreaterThanOrEqual(1);
      const after = await x.question(`draft:${d.id}`);
      expect(after).toMatchObject({ status: 'open', assigned: x.approver });
      expect(await approvalsFor(d.id)).toHaveLength(0);
      expect((await x.notices(x.owner)).some((n) => n.kind === 'escalation' && n.ref === `question:${q.id}`)).toBe(true);
      expect((await x.notices(x.approver)).some((n) => n.kind === 'question' && n.ref === `question:${q.id}`)).toBe(true);
      // The next person actively approves: that is what sends it.
      const r = await x.answer({ questionId: q.id, responderId: x.approver, response: 'approve', digestSeen: q.digest });
      expect(r.accepted).toBe(true);
      await x.drain();
      expect((await draftFor(x, d.enquiry_id!))?.status).toBe('sent');
      await withTenant(x.h.db, x.t, (tx) => tx.deleteFrom('approval_routes').execute());
    });
  });

  contractSuite('F58', () => {
    it('an operator credential can\'t read or answer a tenant\'s questions, and an operator is never a tenant user', async () => {
      const { q, d } = await pending();
      const app = server();
      const inbox = await app.inject({ method: 'GET', url: '/v1/owner/inbox', headers: { authorization: `Bearer ${opToken}` } });
      expect(inbox.statusCode).toBe(403);
      const ans = await app.inject({ method: 'POST', url: `/v1/owner/questions/${q.id}/answer`, headers: { authorization: `Bearer ${opToken}`, 'content-type': 'application/json' }, payload: JSON.stringify({ response: 'approve', digest: q.digest }) });
      expect(ans.statusCode).toBe(403);
      const direct = await x.answer({ questionId: q.id, responderId: opId, response: 'approve', digestSeen: q.digest });
      expect(direct).toMatchObject({ accepted: false, reason: 'unknown_user' });
      expect(await approvalsFor(d.id)).toHaveLength(0);
      // The owner, through the same API, can.
      x.clock.advance(10_000);
      const own = await app.inject({ method: 'POST', url: `/v1/owner/questions/${q.id}/answer`, headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }, payload: JSON.stringify({ response: 'approve', digest: q.digest }) });
      expect(own.statusCode).toBe(200);
      expect(own.json()).toMatchObject({ accepted: true, ack: expect.stringMatching(/Approved/) });
      const inboxOwner = await app.inject({ method: 'GET', url: '/v1/owner/inbox', headers: { authorization: `Bearer ${ownerToken}` } });
      expect(inboxOwner.statusCode).toBe(200);
      expect(inboxOwner.json().notifications.length).toBeGreaterThan(0);
      await app.close();
      await x.drain();
    });
  });
});
