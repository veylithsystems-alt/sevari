import { randomUUID } from 'node:crypto';
/**
 * Typed owner knowledge with versioning (§6.2, I5). Facts are proposed (by the onboarding interview, an
 * owner edit, an import or a register pre-fill), and become facts only when the owner confirms them.
 * Confirming a new version closes the previous one. A snapshot "as at" any moment is reproducible,
 * which is what lets a past reply be replayed exactly (§32 T-REPLAY).
 */
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { sql, type TenantTx } from '@sevari/db';
import { ContractViolation, parseKnowledge, snapshotFrom, type AnyKnowledge, type KnowledgeFact, type KnowledgeSnapshot } from '@sevari/domain';

export type KnowledgeSource = 'onboarding_interview' | 'owner_edit' | 'import' | 'register_prefill' | 'system_default';

const field = (rowId: string) => ({ table: 'knowledge_records', column: 'body_enc', rowId });

/** Stable key: one per business, hours and area; per code for services; per service+basis for prices. */
export function recordKey(body: AnyKnowledge, discriminator?: string): string {
  switch (body.kind) {
    case 'business': return 'business';
    case 'hours': return 'hours';
    case 'area': return `area:${discriminator ?? 'main'}`;
    case 'service': return `service:${body.code}`;
    case 'price': return `price:${body.service_code}:${body.basis}`;
    case 'policy': return `policy:${body.topic}`;
    case 'faq': return `faq:${discriminator ?? 'q'}`;
  }
}

export async function proposeRecord(tx: TenantTx, keyring: TenantKeyring, input: { body: unknown; source: KnowledgeSource; proposedBy: string; key?: string }):
  Promise<{ id: string; key: string; recordVersion: number }> {
  const body = parseKnowledge(input.body);
  const key = input.key ?? recordKey(body);
  const latest = await tx.selectFrom('knowledge_records').select((eb) => eb.fn.max('record_version').as('v')).where('record_key', '=', key).executeTakeFirst();
  const recordVersion = Number(latest?.v ?? 0) + 1;
  const id = randomUUID();
  await tx.insertInto('knowledge_records').values({
    id, tenant_id: tx.scope.tenantId, region: tx.scope.region, record_key: key, kind: body.kind, record_version: recordVersion,
    body_enc: await keyring.seal(tx, field(id), JSON.stringify(body)), source: input.source, proposed_by: input.proposedBy,
  }).execute();
  await appendAudit(tx, { type: 'knowledge.proposed', actor: { kind: 'user', ref: input.proposedBy }, subject: `knowledge:${id}`, payload: { key, record_version: recordVersion, kind: body.kind, source: input.source } });
  return { id, key, recordVersion };
}

/**
 * The owner confirms a proposed record (I5). In Phase 18 this is driven by a typed human input with an
 * effect receipt; the receipt id is passed through here.
 */
export async function confirmRecord(tx: TenantTx, clock: Clock, input: { id: string; confirmedBy: string; receiptRef?: string }): Promise<void> {
  const rec = await tx.selectFrom('knowledge_records').select(['record_key', 'status', 'record_version']).where('id', '=', input.id).executeTakeFirst();
  if (!rec) throw new ContractViolation('I5', 'knowledge record not found');
  if (rec.status !== 'draft') throw new ContractViolation('I5', `only a draft can be confirmed (status is ${rec.status})`);
  const now = clock.now();
  await tx.updateTable('knowledge_records').set({ status: 'retired', effective_to: now })
    .where('record_key', '=', rec.record_key).where('status', '=', 'confirmed').where('effective_to', 'is', null).execute();
  await tx.updateTable('knowledge_records').set({ status: 'confirmed', confirmed_by: input.confirmedBy, confirmed_at: now, effective_from: now })
    .where('id', '=', input.id).execute();
  await appendAudit(tx, {
    type: 'knowledge.confirmed', actor: { kind: 'user', ref: input.confirmedBy }, subject: `knowledge:${input.id}`,
    payload: { key: rec.record_key, record_version: rec.record_version, ...(input.receiptRef ? { receipt_ref: input.receiptRef } : {}) },
  });
}

/** Retire a fact (the owner withdraws it). Its history stays; it stops being a fact from now. */
export async function retireRecord(tx: TenantTx, clock: Clock, input: { key: string; retiredBy: string }): Promise<number> {
  const r = await tx.updateTable('knowledge_records').set({ status: 'retired', effective_to: clock.now() })
    .where('record_key', '=', input.key).where('status', '=', 'confirmed').where('effective_to', 'is', null).executeTakeFirst();
  const n = Number(r.numUpdatedRows);
  if (n) await appendAudit(tx, { type: 'knowledge.retired', actor: { kind: 'user', ref: input.retiredBy }, payload: { key: input.key } });
  return n;
}

/** Confirmed knowledge effective at `atMs`. Facts are cited as `<id>@<record_version>`. */
export async function snapshotAt(tx: TenantTx, keyring: TenantKeyring, atMs: number): Promise<KnowledgeSnapshot> {
  const at = new Date(atMs);
  const rows = await tx.selectFrom('knowledge_records').select(['id', 'record_version', 'body_enc'])
    .where('status', 'in', ['confirmed', 'retired'])
    .where('effective_from', '<=', at)
    .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]))
    .orderBy('record_key').execute();
  const facts: KnowledgeFact[] = [];
  for (const r of rows) {
    const body = parseKnowledge(JSON.parse(await keyring.openText(tx, field(r.id), r.body_enc)));
    facts.push({ id: r.id, version: r.record_version, body });
  }
  return snapshotFrom(facts);
}

/** Records waiting for the owner (the knowledge part of the owner inbox). */
export async function pendingConfirmations(tx: TenantTx): Promise<Array<{ id: string; key: string; recordVersion: number }>> {
  const rows = await tx.selectFrom('knowledge_records').select(['id', 'record_key', 'record_version']).where('status', '=', 'draft').orderBy('created_at').execute();
  return rows.map((r) => ({ id: r.id, key: r.record_key, recordVersion: r.record_version }));
}

export { sql };
