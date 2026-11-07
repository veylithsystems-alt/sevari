import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type TenantTx } from '@sevari/db';
import { confirmRecord, proposeRecord } from '@sevari/knowledge';
import { complaintClock, disputeEvidencePack } from '@sevari/worker';
import { draftInvoice, issueInvoice } from '@sevari/finance';
import { contractSuite } from '../support/contract.ts';
import { superQuery } from '../support/fixtures.ts';
import { draftFor, harness, type Harness } from '../support/hitl-harness.ts';

let x: Harness;
const db = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenant(x.h.db, x.t, fn);

beforeAll(async () => {
  x = await harness('cmp14', 141);
  await db(async (tx) => {
    const r = await proposeRecord(tx, x.keyring, { body: { kind: 'resolution_policy', response_days: 5, remedies: [
      { type: 'apology', conditions: 'We will always apologise where we have got something wrong.' },
      { type: 'redo', conditions: 'We will return within 7 days to put the work right.' },
      { type: 'refund', max_minor: 5000, conditions: 'Refunds are paid back to the original card within 10 working days.' },
    ] }, source: 'onboarding_interview', proposedBy: 'user:owner' });
    await confirmRecord(tx, x.clock, { id: r.id, confirmedBy: 'user:owner' });
  });
});
afterAll(async () => x?.close());

const caseFor = (enquiryId: string) => db((tx) => tx.selectFrom('complaint_cases').selectAll().where('enquiry_id', '=', enquiryId).executeTakeFirst());
const answerCase = async (caseId: string, response: string, detail?: string) => {
  const q = await x.question(`complaint:${caseId}`);
  x.clock.advance(5_000);
  return x.answer({ questionId: q!.id, responderId: x.owner, response, digestSeen: q!.digest, ...(detail ? { detail } : {}) });
};

contractSuite('T-CMP-1', () => {
  it('a legal threat gets no reply beyond the holding acknowledgement, and goes to the owner as a case', async () => {
    const m = await x.send('This is a disgrace. I am going to take you to court and my solicitor will be in touch.');
    const r = await x.process(m.messageId);
    expect(r.route).toBe('human_only');
    expect(await draftFor(x, r.enquiryId)).toBeUndefined();
    const k = await caseFor(r.enquiryId);
    expect(k).toMatchObject({ category: 'always_human', status: 'open', assigned_user_id: x.owner });
    expect(k!.reasons).toContain('legal_threat');
    const q = await db((tx) => tx.selectFrom('human_questions').select(['options', 'kind']).where('subject_ref', '=', `complaint:${k!.id}`).executeTakeFirstOrThrow());
    expect(q).toEqual({ kind: 'complaint', options: ['reply_myself', 'resolved'] });
    // Only the holding acknowledgement went to the customer.
    const sent = await db((tx) => tx.selectFrom('outbox').select('purpose').where('in_reply_to', '=', m.messageId).execute());
    expect(sent.map((s) => s.purpose)).toEqual(['holding']);
    expect((await answerCase(k!.id, 'remedy:refund', '10')).accepted).toBe(false);
  });
});

contractSuite('T-CMP-2', () => {
  it('a remedy outside the business\'s resolution policy is refused; one inside it is drafted for approval, never sent unseen', async () => {
    const m = await x.send('I am not happy with the drain clearance, it came back worse than before.');
    const r = await x.process(m.messageId);
    const k = await caseFor(r.enquiryId);
    expect(k?.category).toBe('standard');
    const opts = await db((tx) => tx.selectFrom('human_questions').select('options').where('subject_ref', '=', `complaint:${k!.id}`).executeTakeFirstOrThrow());
    expect(opts.options).toEqual(['remedy:apology', 'remedy:redo', 'remedy:refund', 'reply_myself', 'resolved']);
    const over = await answerCase(k!.id, 'remedy:refund', '80');
    expect(over).toMatchObject({ accepted: true, outcome: expect.stringMatching(/above your policy's limit of £50\.00/) });
    expect((await db((tx) => tx.selectFrom('drafts').select('id').where('conversation_id', '=', k!.conversation_id!).where('template_id', '=', 'complaint_remedy').execute()))).toHaveLength(0);
  });

  it('within the limit: the exact message goes to the owner for approval', async () => {
    const m = await x.send('I am unhappy, the blocked toilet is still not fixed.');
    const r = await x.process(m.messageId);
    const k = await caseFor(r.enquiryId);
    const ok = await answerCase(k!.id, 'remedy:refund', '40');
    expect(ok).toMatchObject({ accepted: true, outcome: expect.stringMatching(/ready for you to approve/) });
    const d = await db((tx) => tx.selectFrom('drafts').select(['id', 'action_class', 'status']).where('conversation_id', '=', k!.conversation_id!).where('template_id', '=', 'complaint_remedy').executeTakeFirstOrThrow());
    expect(d).toMatchObject({ action_class: 'refund', status: 'pending_approval' });
    const q = await x.question(`draft:${d.id}`);
    expect(q?.status).toBe('open');
  });
});

contractSuite('T-CMP-3', () => {
  it('an unresolved complaint past its promised time alerts the owner; a resolved one doesn\'t', async () => {
    const m = await x.send('Really disappointed with the service, nobody turned up.');
    const r = await x.process(m.messageId);
    const k = await caseFor(r.enquiryId);
    expect(k!.respond_by.getTime() - k!.opened_at.getTime()).toBe(5 * 86_400_000); // the policy's 5 days
    await expect(db((tx) => complaintClock({ ...x, consumers: x.deps.consumers }, tx, k!.id))).rejects.toThrow(/not due/);
    const saved = x.clock.nowMs();
    x.clock.set(k!.respond_by.getTime() + 1_000);
    expect(await db((tx) => complaintClock({ ...x, consumers: x.deps.consumers }, tx, k!.id))).toBe('breached');
    expect(await db((tx) => complaintClock({ ...x, consumers: x.deps.consumers }, tx, k!.id))).toBe('already_breached');
    const alert = (await x.notices(x.owner)).find((n) => n.ref === `complaint:${k!.id}` && n.kind === 'alert');
    expect(alert?.text).toMatch(/Overdue/);
    x.clock.set(saved);
    const m2 = await x.send('Not happy at all with how this went.');
    const r2 = await x.process(m2.messageId);
    const k2 = await caseFor(r2.enquiryId);
    await answerCase(k2!.id, 'resolved');
    x.clock.set(k2!.respond_by.getTime() + 1_000);
    expect(await db((tx) => complaintClock({ ...x, consumers: x.deps.consumers }, tx, k2!.id))).toBe('resolved_in_time');
    x.clock.set(saved);
  });

  it('closing records a root cause; the database refuses a closed case without one, or an open case without an owner', async () => {
    const m = await x.send('I want to make a complaint about the engineer.');
    const r = await x.process(m.messageId);
    const k = await caseFor(r.enquiryId);
    await answerCase(k!.id, 'resolved');
    const q = await x.question(`complaint-close:${k!.id}`);
    x.clock.advance(5_000);
    await x.answer({ questionId: q!.id, responderId: x.owner, response: 'communication', digestSeen: q!.digest });
    expect(await caseFor(r.enquiryId)).toMatchObject({ status: 'closed', root_cause: 'communication' });
    await expect(db((tx) => tx.insertInto('complaint_cases').values({ tenant_id: x.t.tenantId, region: x.t.region, category: 'standard', opened_at: x.clock.now(), respond_by: new Date(x.clock.nowMs() + 1000) }).execute())).rejects.toThrow(/check constraint/);
  });
});

contractSuite('T-CMP-4', () => {
  it('a customer flagged as needing extra care is never sent anything automatically, even under an earned grant', async () => {
    const who = `v-${randomUUID()}@example.com`;
    const m1 = await x.send('My elderly mother lives alone and has a blocked drain. How much to unblock a drain? CH65 2AB', who);
    await x.process(m1.messageId);
    const contactId = await db(async (tx) => (await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id').select('conversations.contact_id').where('messages.id', '=', m1.messageId).executeTakeFirstOrThrow()).contact_id);
    expect((await db((tx) => tx.selectFrom('contacts').select('vulnerable_flag').where('id', '=', contactId).executeTakeFirstOrThrow())).vulnerable_flag).toBe(true);
    // An earned grant for this kind of reply exists for the business.
    await superQuery(`DO $$ BEGIN SET LOCAL session_replication_role = replica; INSERT INTO autonomy_grants (tenant_id, region, action_class, input_id, granted_by, evidence) VALUES ('${x.t.tenantId}', '${x.t.region}', 'info_reply', gen_random_uuid(), gen_random_uuid(), '{}'); END $$`);
    try {
      const m2 = await x.send('How much to unblock a drain? CH65 2AB', who);
      const r2 = await x.process(m2.messageId);
      const d = await draftFor(x, r2.enquiryId);
      expect(d?.status).toBe('pending_approval');
      expect((await x.question(`draft:${d!.id}`))?.status).toBe('open');
      // Someone else, not flagged, gets the reply under the grant.
      const m3 = await x.send('How much to unblock a drain? CH65 2AB');
      const r3 = await x.process(m3.messageId);
      expect((await draftFor(x, r3.enquiryId))?.status).toBe('approved');
    } finally {
      await superQuery(`DO $$ BEGIN SET LOCAL session_replication_role = replica; DELETE FROM autonomy_grants WHERE tenant_id = '${x.t.tenantId}'; END $$`);
    }
  });
});

describe('[Phase 14] dispute evidence pack', () => {
  it('assembles the invoice, payments, ledger, audit trail and conversation for the owner to submit', async () => {
    const m = await x.send('Hello, about my invoice', `e-${randomUUID()}@example.com`);
    const contactId = await db(async (tx) => (await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id').select('conversations.contact_id').where('messages.id', '=', m.messageId).executeTakeFirstOrThrow()).contact_id);
    const invId = await db(async (tx) => { const d = await draftInvoice(tx, { contactId, vatTreatment: 'inclusive', lines: [{ description: 'drain', quantity: 1, unitMinor: 9500 }], factsUsed: [] }); await issueInvoice(x, tx, d.id); return d.id; });
    const pack = await db((tx) => disputeEvidencePack(x, tx, invId));
    expect(pack.invoice).toMatchObject({ total_minor: 9500, status: 'issued' });
    expect(pack.ledger.length).toBeGreaterThanOrEqual(3);
    expect(pack.audit_trail.some((a) => a.event_type === 'invoice.issued')).toBe(true);
    expect(pack.conversation[0]?.text).toBe('Hello, about my invoice');
    expect(pack.prepared_for).toMatch(/does not submit/);
  });
});
