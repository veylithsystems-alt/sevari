/** Reply records (§10.2): one per outbound or blocked draft. Codes and timings only, never content. */
import type { TenantTx } from '@sevari/db';
import type { GroundingFailure } from '@sevari/grounding';

export interface ReplyRecordInput {
  readonly inboundMessageId?: string;
  readonly enquiryId?: string;
  readonly outboxId?: string;
  readonly purpose: string;
  readonly channel: string;
  readonly intent?: string;
  readonly intentConfidence?: number;
  readonly generator: 'template' | 'model' | 'human';
  readonly templateId?: string;
  readonly modelId?: string;
  readonly tokens?: number;
  readonly factsUsed: readonly string[];
  readonly factsMissing: readonly string[];
  readonly groundingOk: boolean;
  readonly groundingFailures?: readonly GroundingFailure[];
  readonly autonomyDecision: string;
  readonly sendResult: string;
  readonly latencyMs: Readonly<Record<string, number>>;
}

export async function recordReply(tx: TenantTx, r: ReplyRecordInput): Promise<string> {
  const row = await tx.insertInto('reply_records').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region,
    inbound_message_id: r.inboundMessageId ?? null, enquiry_id: r.enquiryId ?? null, outbox_id: r.outboxId ?? null,
    purpose: r.purpose, channel: r.channel, intent: r.intent ?? null, intent_confidence: r.intentConfidence ?? null,
    generator: r.generator, template_id: r.templateId ?? null, model_id: r.modelId ?? null, tokens: r.tokens ?? null,
    facts_used: [...r.factsUsed], facts_missing: [...r.factsMissing], grounding_ok: r.groundingOk,
    // Rule codes only: failure details can quote message text, which must not live here.
    grounding_failures: JSON.stringify((r.groundingFailures ?? []).map((f) => f.rule)),
    autonomy_decision: r.autonomyDecision, send_result: r.sendResult, latency_ms: JSON.stringify(r.latencyMs),
  }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

export async function updateReplyResult(tx: TenantTx, id: string, sendResult: string, latencyMs: Readonly<Record<string, number>>): Promise<void> {
  await tx.updateTable('reply_records').set({ send_result: sendResult, latency_ms: JSON.stringify(latencyMs) }).where('id', '=', id).execute();
}
