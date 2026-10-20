import { randomUUID } from 'node:crypto';
/**
 * Job `inbound.process` (§5.2 after persist): normalise → identify → intent → slots → eligibility →
 * price/availability → route. Deterministic; idempotent on (message): a replay finds the stored analysis.
 *
 * Model fallback (Phase 5, §5.3): only when the rules abstain, and only if the cell's registry has an
 * active model that meets the latency budget. The model is called BETWEEN transactions (no connection
 * or lock is held while it thinks), its answer is schema-checked, and any failure leaves the rules'
 * result in place. Lineage (model id, prompt id) is stored on the enquiry.
 */
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { enqueue, withTenant, type Db, type TenantTx } from '@sevari/db';
import { analyseEnquiry, classifyIntent as classifyByRules, ContractViolation, sensitiveFlags, type ModelIntent, type TenantScope, type VerticalPack, type KnowledgeSnapshot } from '@sevari/domain';
import { snapshotAt } from '@sevari/knowledge';
import { classifyIntent as classifyByModel, loadModelRegistry, selectModel, type LlmProvider, type ModelEntry, type ModelTrace } from '@sevari/llm';
import { packFor } from '@sevari/verticals';

export const CORE_VERSION = 'core-0.4.0';
export const RESPOND_JOB = 'enquiry.respond';

export interface InboundDeps {
  readonly keyring: TenantKeyring;
  readonly clock: Clock;
}

export interface InboundOptions {
  readonly modelIntent?: ModelIntent;
  readonly modelTrace?: ModelTrace;
}

interface InboundContext {
  readonly msg: { id: string; conversation_id: string; contact_id: string };
  readonly text: string;
  readonly subject?: string;
  readonly fromName?: string;
  readonly nowMs: number;
  readonly knowledge: KnowledgeSnapshot;
  readonly pack: VerticalPack;
  readonly timezone: string;
  readonly clarificationsSoFar: number;
}

async function loadContext(deps: InboundDeps, tx: TenantTx, messageId: string): Promise<InboundContext> {
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
  return { msg, text, ...(subject ? { subject } : {}), ...(fromName ? { fromName } : {}), nowMs, knowledge, pack, timezone, clarificationsSoFar };
}

export async function processInbound(deps: InboundDeps, tx: TenantTx, messageId: string, opts: InboundOptions = {}): Promise<{ enquiryId: string; route: string; replayed: boolean }> {
  const existing = await tx.selectFrom('enquiries').select(['id', 'route']).where('message_id', '=', messageId).executeTakeFirst();
  if (existing) return { enquiryId: existing.id, route: existing.route, replayed: true };

  const c = await loadContext(deps, tx, messageId);
  const { msg, pack } = c;
  const a = analyseEnquiry({
    text: c.text, ...(c.subject ? { subject: c.subject } : {}), ...(c.fromName ? { fromName: c.fromName } : {}), nowMs: c.nowMs, timezone: c.timezone,
    pack, knowledge: c.knowledge, clarificationsSoFar: c.clarificationsSoFar, ...(opts.modelIntent ? { modelIntent: opts.modelIntent } : {}),
  });
  const enquiryId = randomUUID();
  await tx.insertInto('enquiries').values({
    id: enquiryId, tenant_id: tx.scope.tenantId, region: tx.scope.region, message_id: msg.id, conversation_id: msg.conversation_id,
    pack_id: pack.id, pack_version: pack.version, core_version: CORE_VERSION,
    intent: a.intent.intent, intent_confidence: a.intent.confidence, intent_source: a.intent.source, abstained: a.intent.abstained,
    intent_model_id: a.intent.model?.modelId ?? null, intent_prompt_id: a.intent.model?.promptId ?? null,
    route: a.route, services: [...a.services], flags: [...a.flags], urgency: a.slots.urgency, eligibility: a.eligibility.overall,
    facts_used: [...a.factsUsed], facts_missing: [...a.factsMissing],
    analysis_enc: await deps.keyring.seal(tx, { table: 'enquiries', column: 'analysis_enc', rowId: enquiryId, subject: msg.contact_id }, JSON.stringify(a)),
    analysed_at: deps.clock.now(),
  }).execute();
  await enqueue(tx, { kind: RESPOND_JOB, dedupeKey: enquiryId, payload: { enquiry_id: enquiryId } });
  const t = opts.modelTrace;
  await appendAudit(tx, {
    type: 'enquiry.analysed', actor: { kind: 'system', ref: CORE_VERSION }, subject: `enquiry:${enquiryId}`,
    payload: {
      message_ref: `message:${msg.id}`, intent: a.intent.intent, confidence: a.intent.confidence, intent_source: a.intent.source, route: a.route,
      pack: `${pack.id}@${pack.version}`, facts_used: a.factsUsed.length, facts_missing: a.factsMissing.length,
      ...(t ? { model: t.modelId, prompt: t.promptId, model_outcome: t.outcome, model_tokens: t.tokens, model_latency_ms: t.latencyMs } : {}),
    },
  });
  return { enquiryId, route: a.route, replayed: false };
}

export interface ModelDeps {
  /** Builds a provider for a registry entry (Ollama behind the egress client in production; a fake in tests). */
  readonly providerFor: (entry: ModelEntry) => LlmProvider | null;
  /** Classification must finish inside this, or the rules' result stands. */
  readonly classifyBudgetMs: number;
  readonly language?: string;
}

/**
 * The scoped `inbound.process` handler: read (tx 1) → model, only if the rules abstain (no tx) → analyse
 * and write (tx 2). Without a model, or if it fails, this is exactly the deterministic path.
 */
export function inboundHandler(db: Db, deps: InboundDeps & { readonly model?: ModelDeps }) {
  return {
    scoped: async (scope: TenantScope, payload: Record<string, unknown>) => {
      const messageId = String(payload['message_id']);
      const m = deps.model;
      let opts: InboundOptions = {};
      if (m) {
        const plan = await withTenant(db, scope, async (tx) => {
          const done = await tx.selectFrom('enquiries').select('id').where('message_id', '=', messageId).executeTakeFirst();
          if (done) return null;
          const c = await loadContext(deps, tx, messageId);
          const text = c.subject ? `${c.subject}\n${c.text}` : c.text;
          const rules = classifyByRules(text, c.pack, { flags: sensitiveFlags(text) });
          if (!rules.abstained) return null;
          const pick = selectModel(await loadModelRegistry(tx), { region: scope.region, task: 'classify_intent', language: m.language ?? 'en', latencyBudgetMs: m.classifyBudgetMs });
          return pick.model ? { text, entry: pick.model } : null;
        });
        const provider = plan ? m.providerFor(plan.entry) : null;
        if (plan && provider) {
          const r = await classifyByModel(provider, plan.text, { timeoutMs: m.classifyBudgetMs });
          opts = {
            modelTrace: r.trace,
            ...(r.abstained ? {} : { modelIntent: { intent: r.intent, confidence: r.confidence, modelId: r.trace.modelId, promptId: r.trace.promptId } }),
          };
        }
      }
      return withTenant(db, scope, (tx) => processInbound(deps, tx, messageId, opts));
    },
  };
}
