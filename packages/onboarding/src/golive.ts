/**
 * Getting a business live (§18, §81, §83). Everything is automatic except the decisions that must be human:
 *   startOnboarding()  answers → draft knowledge records + a drafted pack + its synthetic test report, and a
 *                      regulated-activity check. Nothing is live or confirmed yet.
 *   confirmPack()      the owner's confirmation of a drafted pack; refused unless its tests pass (T-PACK-1).
 *   goLiveChecklist()  the automatic checklist; each failing item says exactly what's missing (T-ONB-5).
 *   activate()         the go-live itself, only from an owner's recorded answer, only with a passing
 *                      checklist, and for a regulated business only with Veylith's approval as well
 *                      (T-ONB-1, T-ONB-4, T-PACK-2). The database refuses any other way (tenants_status_guard).
 */
import { createHash, randomInt } from 'node:crypto';
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import { sql, type TenantTx } from '@sevari/db';
import { ContractViolation, type AnyKnowledge, type KnowledgeSnapshot, type VerticalPack } from '@sevari/domain';
import { proposeRecord, snapshotAt } from '@sevari/knowledge';
import { packFor } from '@sevari/verticals';
import { draftFromAnswers, InterviewAnswers } from './interview.ts';
import { detectRegulated, type RegulatedFinding } from './regulated.ts';
import { runSyntheticTests, type SyntheticReport } from './synthetic.ts';

export interface OnboardingDeps { readonly keyring: TenantKeyring; readonly clock: Clock }

export async function startOnboarding(deps: OnboardingDeps, tx: TenantTx, answers: unknown, by: string): Promise<{
  recordIds: string[]; packId: string | null; report: SyntheticReport; regulated: RegulatedFinding[];
}> {
  const a = InterviewAnswers.parse(answers);
  const draft = draftFromAnswers(a);
  const tz = a.hours.timezone;
  const report = runSyntheticTests(draft.records, draft.pack, { nowMs: deps.clock.nowMs(), timezone: tz });
  const regulated = detectRegulated([a.business.description, ...a.services.flatMap((s) => [s.name, ...s.everyday_names])]);
  if (regulated.length || draft.pack.regulated) {
    await tx.updateTable('tenants').set({ regulated: true, regulated_reasons: [...new Set([...regulated.map((r) => r.activity), ...(draft.pack.regulated ? ['regulated_trade'] : [])])] })
      .where('id', '=', tx.scope.tenantId).execute();
  }
  const recordIds: string[] = [];
  for (const body of draft.records) {
    const r = await proposeRecord(tx, deps.keyring, { body, source: 'onboarding_interview', proposedBy: by, ...(body.kind === 'faq' ? { key: `faq:${body.question.slice(0, 60)}` } : {}) });
    recordIds.push(r.id);
  }
  let packId: string | null = null;
  if (draft.drafted) {
    const prev = await tx.selectFrom('tenant_packs').select((eb) => eb.fn.max('pack_version').as('v')).executeTakeFirst();
    const row = await tx.insertInto('tenant_packs').values({
      tenant_id: tx.scope.tenantId, region: tx.scope.region, pack_version: Number(prev?.v ?? 0) + 1, body: JSON.stringify(draft.pack), test_report: JSON.stringify(report),
    }).returning('id').executeTakeFirstOrThrow();
    packId = row.id;
  }
  await appendAudit(tx, { type: 'onboarding.drafted', actor: { kind: 'user', ref: by }, subject: `tenant:${tx.scope.tenantId}`, payload: { records: recordIds.length, pack_drafted: draft.drafted, synthetic_passed: report.passed, regulated: regulated.map((r) => r.activity) } });
  return { recordIds, packId, report, regulated };
}

/** The pack Sevari uses for this business: its confirmed drafted pack, or its ready-made trade pack. */
export async function packOf(tx: TenantTx, snap: KnowledgeSnapshot): Promise<VerticalPack | null> {
  const vertical = snap.business?.body.vertical;
  if (!vertical) return null;
  if (vertical !== 'custom') return packFor(vertical);
  const p = await tx.selectFrom('tenant_packs').select('body').where('status', '=', 'confirmed').executeTakeFirst();
  return p ? (p.body as unknown as VerticalPack) : null;
}

const recordsOf = (snap: KnowledgeSnapshot): AnyKnowledge[] =>
  [snap.business, snap.hours, ...snap.services, ...snap.prices, ...snap.areas, ...snap.policies, ...snap.faqs].filter((f) => f !== undefined).map((f) => f.body);

/** The owner confirms a drafted pack. Its tests are re-run against the records as confirmed now (T-PACK-1). */
export async function confirmPack(deps: OnboardingDeps, tx: TenantTx, packId: string, by: string): Promise<{ ok: true } | { ok: false; report: SyntheticReport }> {
  const p = await tx.selectFrom('tenant_packs').select(['id', 'status', 'body']).where('id', '=', packId).forUpdate().executeTakeFirst();
  if (!p || p.status !== 'draft') throw new ContractViolation('§83.2', 'only a drafted pack can be confirmed');
  const snap = await snapshotAt(tx, deps.keyring, deps.clock.nowMs());
  const report = runSyntheticTests(recordsOf(snap), p.body as unknown as VerticalPack, { nowMs: deps.clock.nowMs(), timezone: snap.hours?.body.timezone ?? 'Europe/London' });
  await tx.updateTable('tenant_packs').set({ test_report: JSON.stringify(report), test_passed: report.passed }).where('id', '=', packId).execute();
  if (!report.passed) return { ok: false, report };
  await tx.updateTable('tenant_packs').set({ status: 'superseded' }).where('status', '=', 'confirmed').execute();
  await tx.updateTable('tenant_packs').set({ status: 'confirmed', confirmed_by: by, confirmed_at: deps.clock.now() }).where('id', '=', packId).execute();
  await appendAudit(tx, { type: 'pack.confirmed', actor: { kind: 'user', ref: by }, subject: `pack:${packId}`, payload: { tests: report.total } });
  return { ok: true };
}

export interface ChecklistItem { readonly key: string; readonly ok: boolean; readonly text: string }
export interface Checklist { readonly ok: boolean; readonly items: readonly ChecklistItem[] }
export type CellLive = () => Promise<{ allowed: true } | { allowed: false; reasons: string[] }>;

/** The automatic go-live checklist (§81.2). Each item says, in plain English, what is missing. */
export async function goLiveChecklist(deps: OnboardingDeps & { readonly cellLive: CellLive }, tx: TenantTx): Promise<Checklist> {
  const snap = await snapshotAt(tx, deps.keyring, deps.clock.nowMs());
  const items: ChecklistItem[] = [];
  const add = (key: string, ok: boolean, okText: string, missing: string) => items.push({ key, ok, text: ok ? okText : missing });
  const b = snap.business?.body;
  add('business', Boolean(b?.trading_name && b.reply_time_statement && b.privacy_notice_url), 'Business details confirmed',
    'Confirm your business details: your trading name, your reply-time promise and the link to your privacy notice.');
  const offered = snap.services.filter((s) => s.body.offered);
  add('services', offered.length > 0, `${offered.length} service(s) confirmed`, 'Confirm at least one service you offer.');
  const hours = snap.hours?.body;
  add('hours', Boolean(hours && Object.values(hours.weekly).some((w) => w.length > 0)), 'Opening hours confirmed', 'Confirm your opening hours.');
  add('area', snap.areas.some((a) => a.body.outward_codes.length + a.body.postcode_areas.length > 0), 'Area you cover confirmed', 'Confirm the postcodes you cover.');
  const unpriced = offered.filter((s) => !snap.prices.some((p) => p.body.service_code === s.body.code));
  add('prices', unpriced.length === 0, 'Every service has a price, or "price on inspection"',
    `Give a price, or say "price on inspection", for: ${unpriced.map((s) => s.body.name).join(', ')}.`);
  const channels = await tx.selectFrom('channel_endpoints').select('id').where('status', '=', 'active').where('verified_at', 'is not', null).execute();
  add('channel', channels.length > 0, 'A channel is connected and tested', 'Connect at least one way for customers to reach you (email, web form or SMS) and send the test message.');
  const pack = await packOf(tx, snap);
  if (b?.vertical === 'custom' && !pack) {
    add('pack', false, '', 'Check and confirm the list of your services and the questions Sevari will ask customers.');
  } else if (pack) {
    const report = runSyntheticTests(recordsOf(snap), pack, { nowMs: deps.clock.nowMs(), timezone: hours?.timezone ?? 'Europe/London' });
    add('pack', report.passed, `Test enquiries all handled correctly (${report.total})`,
      `Some test enquiries weren't handled correctly, so your records need a look: ${report.failures.slice(0, 3).map((f) => `${f.case}: ${f.why}`).join('; ')}.`);
  } else {
    add('pack', false, '', 'Confirm your business details so Sevari knows what kind of business you are.');
  }
  const t = await tx.selectFrom('tenants').select(['regulated', 'regulated_reasons']).where('id', '=', tx.scope.tenantId).executeTakeFirstOrThrow();
  if (t.regulated) {
    const approval = await platformApproval(tx, deps.clock);
    add('regulated', approval !== null, 'Veylith has approved going live (regulated activity)',
      `Your business includes regulated work (${t.regulated_reasons.join(', ').replace(/_/g, ' ')}), so Veylith must approve going live as well. We've been told.`);
  }
  const cell = await deps.cellLive();
  add('cell', cell.allowed, 'Sevari is cleared to run live businesses here',
    cell.allowed ? '' : 'Sevari isn\'t cleared to run live businesses in your region yet (legal sign-off and service levels). Nothing you need to do.');
  return { ok: items.every((i) => i.ok), items };
}

/** Veylith's founder approval for this business to go live (§81.5): a platform decision, unexpired. */
export async function platformApproval(tx: TenantTx, clock: Clock): Promise<string | null> {
  const today = clock.now().toISOString().slice(0, 10);
  const d = await tx.selectFrom('platform_decisions').select(['id', sql<string>`expires_on::text`.as('expires')]).where('scope', '=', `tenant:${tx.scope.tenantId}:activation`)
    .where('decision', '=', 'signoff').where('approver_role', '=', 'founder').orderBy('created_at', 'desc').executeTakeFirst();
  return d && d.expires >= today ? d.id : null;
}

/**
 * Activation: the owner's recorded answer, a passing checklist (re-run now), and for a regulated business
 * Veylith's approval, all in one transaction with the status change the database guards.
 */
export async function activate(deps: OnboardingDeps & { readonly cellLive: CellLive }, tx: TenantTx, input: { mode: 'active' | 'shadow'; inputId: string; userId: string }):
  Promise<{ ok: true } | { ok: false; missing: string[] }> {
  const t = await tx.selectFrom('tenants').select(['status', 'regulated']).where('id', '=', tx.scope.tenantId).forUpdate().executeTakeFirstOrThrow();
  if (t.status === input.mode) return { ok: true };
  const list = await goLiveChecklist(deps, tx);
  if (!list.ok) return { ok: false, missing: list.items.filter((i) => !i.ok).map((i) => i.text) };
  const platformDecisionId = t.regulated ? await platformApproval(tx, deps.clock) : null;
  if (t.regulated && !platformDecisionId) return { ok: false, missing: ['Veylith must approve going live for a regulated business.'] };
  await tx.insertInto('tenant_activations').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, mode: input.mode, checklist: JSON.stringify(list), checklist_ok: true,
    input_id: input.inputId, decided_by: input.userId, regulated: t.regulated, platform_decision_id: platformDecisionId,
  }).execute();
  await tx.updateTable('tenants').set({ status: input.mode, ...(input.mode === 'active' ? { activated_at: deps.clock.now() } : {}) }).where('id', '=', tx.scope.tenantId).execute();
  await appendAudit(tx, { type: 'tenant.activated', actor: { kind: 'user', ref: input.userId }, subject: `tenant:${tx.scope.tenantId}`, payload: { mode: input.mode, from: t.status, regulated: t.regulated } });
  return { ok: true };
}

/** A one-time code the owner sends through a channel to prove it works (§81.2, "verified with a test message"). */
export async function startChannelCheck(tx: TenantTx, endpointId: string): Promise<string> {
  const code = `SV-${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
  await tx.updateTable('channel_endpoints').set({ check_code_hash: createHash('sha256').update(code).digest(), verified_at: null }).where('id', '=', endpointId).execute();
  return code;
}
