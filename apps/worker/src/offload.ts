/**
 * Handing a case to someone outside the business (§21.3): always the owner's approval, with who, why, on
 * what basis and exactly which fields. Approving seals the minimum bundle; refusing records it.
 */
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import type { TenantTx } from '@sevari/db';
import { ask, digestOf, type Consumer, type ConsumerRegistry } from '@sevari/hitl';
import { approveOffload } from '@sevari/privacy';

const PURPOSE: Record<string, string> = { subcontract: 'a subcontractor to do the work', specialist: 'a specialist', partner_referral: 'a partner business', insurance: 'an insurer', regulator: 'a regulator', debt_recovery: 'debt recovery' };

export async function askOffload(deps: { keyring: TenantKeyring; clock: Clock; consumers: ConsumerRegistry }, tx: TenantTx, offloadId: string): Promise<string> {
  const o = await tx.selectFrom('offloads').leftJoin('partners', 'partners.id', 'offloads.partner_id')
    .select(['offloads.id', 'offloads.contact_id', 'offloads.purpose', 'offloads.lawful_basis', 'offloads.fields', 'offloads.processor_id', 'offloads.owner_user_id', 'partners.name'])
    .where('offloads.id', '=', offloadId).executeTakeFirstOrThrow();
  return ask(deps, tx, {
    subjectContactId: o.contact_id, kind: 'offload', subjectRef: `offload:${offloadId}`, contentDigest: digestOf({ offload: offloadId, fields: o.fields }), requiredRole: 'owner', assignTo: o.owner_user_id,
    body: {
      title: `Hand this case to ${PURPOSE[o.purpose] ?? o.purpose}?`,
      summary: `Recipient: ${o.name ?? o.processor_id}. Lawful basis: ${o.lawful_basis}. Only these details would be shared: ${o.fields.join(', ').replace(/_/g, ' ')}.`,
      optionLabels: { approve: 'Approve the handover', refuse: 'Don\'t share' }, safeDefaultText: 'Nothing is shared until you approve.',
    },
    options: ['approve', 'refuse'], safeDefault: 'hold', consumer: { kind: 'offload.decide', ref: offloadId }, deadlineMs: 7 * 86_400_000,
  });
}

export function offloadConsumers(deps: { keyring: TenantKeyring }): Record<string, Consumer> {
  return {
    'offload.decide': {
      ack: (r) => (r === 'approve' ? 'Approved. Preparing only the details you agreed to.' : 'Understood. Nothing will be shared.'),
      async apply(ctx) {
        const id = ctx.question.consumer_ref;
        if (ctx.response === 'refuse') {
          await ctx.tx.updateTable('offloads').set({ status: 'refused', input_id: ctx.inputId }).where('id', '=', id).execute();
          return { status: 'done', effectKind: 'offload.refused', effectRef: `offload:${id}`, outcomeText: 'Nothing was shared.' };
        }
        const bundle = await approveOffload(deps, ctx.tx, id, ctx.inputId);
        return { status: 'done', effectKind: 'offload.approved', effectRef: `offload:${id}`, outcomeText: `Ready to hand over: ${Object.keys(bundle).join(', ').replace(/_/g, ' ') || 'no personal details'}.` };
      },
    },
  };
}
