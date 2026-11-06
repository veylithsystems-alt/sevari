/**
 * Onboarding decisions in the owner's inbox (§18, §81, §83). Both are typed human decisions with a
 * consumer (INV-12), acknowledged at once and acted on (§74):
 *   pack.confirm    the owner confirms the pack Sevari drafted for their business (refused if its tests fail);
 *   tenant.go_live  the owner's own "go live" tap: Assist mode, or shadow mode first. The checklist is run
 *                   again at the moment of the tap, and a regulated business also needs Veylith's approval.
 * requestGoLive() never asks while the checklist fails: it tells the owner exactly what is missing (T-ONB-5).
 */
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import type { TenantTx } from '@sevari/db';
import { ask, digestOf, notify, ownerOf, type Consumer, type ConsumerRegistry } from '@sevari/hitl';
import { activate, confirmPack, goLiveChecklist, type CellLive } from './golive.ts';

export interface OnboardingWorkerDeps {
  readonly keyring: TenantKeyring;
  readonly clock: Clock;
  /** Whether this cell may run live businesses (counsel sign-off and service levels). Defaults to "no". */
  readonly cellLive?: CellLive;
}

const NOT_CLEARED: CellLive = async () => ({ allowed: false, reasons: ['this cell has not been cleared for live businesses'] });
const live = (deps: OnboardingWorkerDeps) => ({ keyring: deps.keyring, clock: deps.clock, cellLive: deps.cellLive ?? NOT_CLEARED });

export async function requestGoLive(deps: OnboardingWorkerDeps & { readonly consumers: ConsumerRegistry }, tx: TenantTx):
  Promise<{ status: 'asked'; questionId: string } | { status: 'blocked'; missing: string[] } | { status: 'already_live' }> {
  const t = await tx.selectFrom('tenants').select('status').where('id', '=', tx.scope.tenantId).executeTakeFirstOrThrow();
  if (t.status === 'active') return { status: 'already_live' };
  const list = await goLiveChecklist(live(deps), tx);
  const owner = await ownerOf(tx);
  if (!list.ok) {
    const missing = list.items.filter((i) => !i.ok).map((i) => i.text);
    if (owner) await notify(tx, deps.keyring, { userId: owner, kind: 'info', ref: `tenant:${tx.scope.tenantId}`, dedupeKey: `golive-blocked:${digestOf(missing).toString('hex').slice(0, 16)}`, text: `Not ready to go live yet. Still to do:\n- ${missing.join('\n- ')}` });
    return { status: 'blocked', missing };
  }
  const fromShadow = t.status === 'shadow';
  const questionId = await ask({ keyring: deps.keyring, clock: deps.clock, consumers: deps.consumers }, tx, {
    kind: 'go_live', subjectRef: `tenant:${tx.scope.tenantId}`, contentDigest: digestOf(list), requiredRole: 'owner',
    body: {
      title: fromShadow ? 'Ready to leave practice mode?' : 'Ready to go live',
      summary: fromShadow
        ? 'Sevari has been drafting replies without sending them. Going live means customers get the instant acknowledgement, and every other reply still waits for your approval.'
        : 'Everything is in place. Going live means every customer gets an instant acknowledgement, and every other reply waits for your approval (Assist mode). Or start in practice mode: Sevari drafts replies but sends nothing until you say so.',
      facts: list.items.map((i) => `✓ ${i.text}`),
      optionLabels: fromShadow ? { go_live: 'Go live', not_yet: 'Not yet' } : { go_live: 'Go live (Assist mode)', shadow: 'Practice mode first', not_yet: 'Not yet' },
      safeDefaultText: 'Nothing changes until you choose.',
    },
    options: fromShadow ? ['go_live', 'not_yet'] : ['go_live', 'shadow', 'not_yet'], safeDefault: 'hold',
    consumer: { kind: 'tenant.go_live', ref: tx.scope.tenantId }, deadlineMs: 14 * 86_400_000,
  });
  return { status: 'asked', questionId };
}

export async function askPackConfirm(deps: OnboardingWorkerDeps & { readonly consumers: ConsumerRegistry }, tx: TenantTx, packId: string): Promise<string> {
  const p = await tx.selectFrom('tenant_packs').select(['body', 'test_report']).where('id', '=', packId).executeTakeFirstOrThrow();
  const pack = p.body as { services?: { name: string; keywords: string[] }[]; clarifyingQuestions?: Record<string, string> };
  const report = p.test_report as { total?: number; passed?: boolean; failures?: { case: string; why: string }[] } | null;
  return ask({ keyring: deps.keyring, clock: deps.clock, consumers: deps.consumers }, tx, {
    kind: 'pack_confirm', subjectRef: `pack:${packId}`, contentDigest: digestOf(p.body), requiredRole: 'owner',
    body: {
      title: 'Check how Sevari will understand your customers',
      summary: `These are your services and the words customers use for them. Sevari tested them against ${report?.total ?? 0} practice enquiries${report?.passed ? ', all handled correctly' : `; some need fixing first`}.`,
      facts: [
        ...(pack.services ?? []).map((s) => `${s.name}: ${s.keywords.join(', ')}`),
        ...Object.values(pack.clarifyingQuestions ?? {}).map((q) => `Question to customers: ${q}`),
        ...(report?.failures ?? []).map((f) => `Needs fixing: ${f.case}: ${f.why}`),
      ],
      optionLabels: { confirm: 'Yes, that\'s right', change: 'I need to change something' }, safeDefaultText: 'Nothing goes live until you confirm.',
    },
    options: ['confirm', 'change'], safeDefault: 'hold', consumer: { kind: 'pack.confirm', ref: packId }, deadlineMs: 30 * 86_400_000,
  });
}

export function onboardingConsumers(deps: OnboardingWorkerDeps): Record<string, Consumer> {
  return {
    'pack.confirm': {
      ack: (r) => (r === 'confirm' ? 'Thanks. Checking it one last time now.' : 'No problem. Change your answers and Sevari will draft it again.'),
      async apply(ctx) {
        const packId = ctx.question.consumer_ref;
        if (ctx.response === 'change') return { status: 'done', effectKind: 'pack.change_requested', effectRef: `pack:${packId}`, outcomeText: 'Nothing was confirmed. Update your answers whenever you\'re ready.' };
        const r = await confirmPack(deps, ctx.tx, packId, `user:${ctx.responderId}`);
        return r.ok
          ? { status: 'done', effectKind: 'pack.confirmed', effectRef: `pack:${packId}`, outcomeText: 'Confirmed. Sevari will use this to understand your customers.' }
          : { status: 'failed', effectKind: 'pack.confirmed', effectRef: `pack:${packId}`, outcomeText: `Not confirmed: some practice enquiries weren't handled correctly with your records as they are now (${r.report.failures.slice(0, 3).map((f) => f.why).join('; ')}).` };
      },
    },
    'tenant.go_live': {
      ack: (r) => (r === 'not_yet' ? 'Understood. Nothing changes.' : 'Got it. Running the final checks now.'),
      async apply(ctx) {
        const ref = `tenant:${ctx.tx.scope.tenantId}`;
        if (ctx.response === 'not_yet') return { status: 'done', effectKind: 'tenant.go_live', effectRef: ref, outcomeText: 'Nothing changed. You can go live whenever you\'re ready.' };
        const mode = ctx.response === 'shadow' ? 'shadow' as const : 'active' as const;
        const r = await activate(live(deps), ctx.tx, { mode, inputId: ctx.inputId, userId: ctx.responderId });
        if (!r.ok) return { status: 'failed', effectKind: 'tenant.go_live', effectRef: ref, outcomeText: `Not live yet: something changed since you were asked.\n- ${r.missing.join('\n- ')}` };
        return {
          status: 'done', effectKind: 'tenant.go_live', effectRef: ref,
          outcomeText: mode === 'active'
            ? 'You\'re live. Every customer now gets an instant acknowledgement, and every other reply waits for your approval.'
            : 'Practice mode is on. Sevari drafts replies for you to see, and sends nothing to customers until you go live.',
        };
      },
    },
  };
}
