import { randomUUID } from 'node:crypto';
/**
 * Job `inbound.process` (§5.2 after persist): normalise → identify → intent → slots → eligibility →
 * price/availability → route. Deterministic; idempotent on (message): a replay finds the stored analysis.
 */
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { enqueue, type TenantTx } from '@sevari/db';
import { analyseEnquiry, ContractViolation } from '@sevari/domain';
import { snapshotAt } from '@sevari/knowledge';
import { packFor } from '@sevari/verticals';

export const CORE_VERSION = 'core-0.3.0';
export const RESPOND_JOB = 'enquiry.respond';

export interface InboundDeps {
  readonly keyring: TenantKeyring;
  readonly clock: Clock;
}

export async function processInbound(deps: InboundDeps, tx: TenantTx, messageId: string): Promise<{ enquiryId: string; route: string; replayed: boolean }> {
  const existing = await tx.selectFrom('enquiries').select(['id', 'route']).where('message_id', '=', messageId).executeTakeFirst();
  if (existing) return { enquiryId: existing.id, route: existing.route, replayed: true };

  const msg = await tx.selectFrom('messages').innerJoin('conversations', 'conversations.id', 'messages.conversation_id')
    .innerJoin('contacts', 'contacts.id', 'conversations.contact_id')
    .select(['messages.id', 'messages.conversation_id', 'messages.body_enc', 'messages.subject_enc', 'messages.kind', 'contacts.id as contact_id', 'contacts.display_name_enc'])
    .where('messages.id', '=', messageId).executeTakeFirst();
  if (!msg) throw new ContractViolation('§5.2', `message ${messageId} not found for this tenant`);

  const open = (table: string, column: string, rowId: string, enc: Buffer) => deps.keyring.openText(tx, { table, column, rowId }, enc);
  const text = await open('messages', 'body_enc', msg.id, msg.body_enc);
  const subject = msg.subject_enc ? await open('messages', 'subject_enc', msg.id, msg.subject_enc) : undefined;
  const fromName = msg.display_name_enc ? await open('contacts', 'display_name_enc', msg.contact_id, msg.display_name_enc) : undefined;

  const nowMs = deps.clock.nowMs();
  const knowledge = await snapshotAt(tx, deps.keyring, nowMs);
  const vertical = knowledge.business?.body.vertical;
  if (!vertical) throw new ContractViolation('I5', 'tenant has no confirmed business record (vertical unknown)');
  const pack = packFor(vertical);
  const timezone = knowledge.hours?.body.timezone ?? 'Europe/London';
  const clarificationsSoFar = (await tx.selectFrom('enquiries').select('id')
    .where('conversation_id', '=', msg.conversation_id).where('route', '=', 'clarify').execute()).length;

  const a = analyseEnquiry({ text, ...(subject ? { subject } : {}), ...(fromName ? { fromName } : {}), nowMs, timezone, pack, knowledge, clarificationsSoFar });
  const enquiryId = randomUUID();
  await tx.insertInto('enquiries').values({
    id: enquiryId, tenant_id: tx.scope.tenantId, region: tx.scope.region, message_id: msg.id, conversation_id: msg.conversation_id,
    pack_id: pack.id, pack_version: pack.version, core_version: CORE_VERSION,
    intent: a.intent.intent, intent_confidence: a.intent.confidence, intent_source: a.intent.source, abstained: a.intent.abstained,
    route: a.route, services: [...a.services], flags: [...a.flags], urgency: a.slots.urgency, eligibility: a.eligibility.overall,
    facts_used: [...a.factsUsed], facts_missing: [...a.factsMissing],
    analysis_enc: await deps.keyring.seal(tx, { table: 'enquiries', column: 'analysis_enc', rowId: enquiryId }, JSON.stringify(a)),
    analysed_at: deps.clock.now(),
  }).execute();
  await enqueue(tx, { kind: RESPOND_JOB, dedupeKey: enquiryId, payload: { enquiry_id: enquiryId } });
  await appendAudit(tx, {
    type: 'enquiry.analysed', actor: { kind: 'system', ref: CORE_VERSION }, subject: `enquiry:${enquiryId}`,
    payload: { message_ref: `message:${msg.id}`, intent: a.intent.intent, confidence: a.intent.confidence, route: a.route, pack: `${pack.id}@${pack.version}`, facts_used: a.factsUsed.length, facts_missing: a.factsMissing.length },
  });
  return { enquiryId, route: a.route, replayed: false };
}
