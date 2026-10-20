/**
 * Key lifecycle operations across a cell (§67): re-applying the shred register after a restore, and the
 * key-compromise drill. Both run as an operator task over the cell's tenants (from the routing table).
 */
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { KekRing, TenantKeyring } from '@sevari/crypto';
import { withTenant, type Db } from '@sevari/db';
import { regionCode, tenantId, type TenantScope } from '@sevari/domain';
import type { ShredRegister } from './shred-register.ts';

/** After a restore and before serving traffic: destroy again every key the register says was destroyed. */
export async function reapplyShredRegister(deps: { db: Db; keyring: TenantKeyring; clock: Clock }, register: ShredRegister): Promise<{ subjects: number; tenants: number }> {
  let subjects = 0;
  let tenants = 0;
  for (const e of await register.entries()) {
    const scope = { tenantId: tenantId(e.tenantId), region: regionCode(e.region) };
    await withTenant(deps.db, scope, async (tx) => {
      if (e.kind === 'tenant') {
        if (await deps.keyring.shredAll(tx, deps.clock.now())) tenants++;
      } else if (e.subjectRef) {
        const shredded = await deps.keyring.shredSubject(tx, e.subjectRef, deps.clock.now());
        const back = await tx.deleteFrom('contacts').where('id', '=', e.subjectRef).executeTakeFirst();
        if (shredded || Number(back.numDeletedRows)) subjects++;
      }
      await appendAudit(tx, { type: 'key.shred_reapplied', actor: { kind: 'system' }, subject: e.subjectRef ? `contact:${e.subjectRef}` : `tenant:${e.tenantId}`, payload: { kind: e.kind, reason: e.reason } });
    });
  }
  return { subjects, tenants };
}

export interface DrillReport {
  readonly startedAt: string;
  readonly oldKek: string;
  readonly newKek: string;
  readonly rewrapped: number;
  readonly tenantsVerified: number;
  readonly oldKekRevoked: boolean;
  readonly oldKekStillUnwraps: boolean;
  /** §71: a possible key compromise always opens a breach assessment; a human decides on notification. */
  readonly breachAssessment: 'opened';
  readonly steps: readonly string[];
}

/**
 * Key-compromise drill (T-KEY-4): rotate to a new KEK, re-wrap every key of every tenant, verify every
 * tenant can still read its data with the new KEK alone, revoke the old KEK, prove it no longer unwraps,
 * and open a breach assessment. The same function is the real response, run by an operator.
 */
export async function keyCompromiseDrill(deps: { db: Db; ring: KekRing; keyring: TenantKeyring; clock: Clock }, tenants: readonly TenantScope[], newKek: Buffer,
  verify: (scope: TenantScope) => Promise<boolean>): Promise<DrillReport> {
  const steps: string[] = [];
  const startedAt = deps.clock.now().toISOString();
  const oldKek = deps.ring.kekId;
  const newId = deps.ring.rotateTo(newKek);
  steps.push(`rotated active KEK ${oldKek} -> ${newId}`);
  let rewrapped = 0;
  for (const t of tenants) rewrapped += await withTenant(deps.db, t, (tx) => deps.keyring.rewrapKeys(tx));
  steps.push(`re-wrapped ${rewrapped} keys across ${tenants.length} tenants`);
  deps.ring.revoke(oldKek);
  steps.push(`revoked ${oldKek}`);
  let verified = 0;
  for (const t of tenants) if (await verify(t)) verified++;
  steps.push(`verified ${verified}/${tenants.length} tenants read their data with the new KEK only`);
  let oldKekStillUnwraps = true;
  try {
    await deps.ring.unwrap(Buffer.alloc(45), 'probe', oldKek);
  } catch (err) {
    oldKekStillUnwraps = !/revoked/.test((err as Error).message);
  }
  for (const t of tenants) {
    await withTenant(deps.db, t, (tx) => appendAudit(tx, { type: 'key.compromise_response', actor: { kind: 'operator' }, subject: `kek:${newId}`, payload: { old_kek: oldKek, rewrapped, breach_assessment: 'opened' } }));
  }
  steps.push('breach assessment opened (§71: assess, then a human decides whether to notify)');
  return { startedAt, oldKek, newKek: newId, rewrapped, tenantsVerified: verified, oldKekRevoked: deps.ring.status(oldKek) === 'revoked', oldKekStillUnwraps, breachAssessment: 'opened', steps };
}
