/**
 * Data imports (§18 step 4, T-ONB-2): contacts come in only with a recorded lawful basis and where they
 * came from. No basis, no import. Imported people get a registered source (Tier B), so by the contact rules
 * (§17.2) they can be messaged only with consent, until they contact the business themselves.
 */
import { randomUUID } from 'node:crypto';
import { appendAudit } from '@sevari/audit';
import type { Clock } from '@sevari/clock';
import type { TenantKeyring } from '@sevari/crypto';
import type { TenantTx } from '@sevari/db';
import { ContractViolation, normaliseEmail, normalisePhone } from '@sevari/domain';

export interface ImportRow { readonly name?: string | undefined; readonly email?: string | undefined; readonly phone?: string | undefined }

export async function importContacts(deps: { keyring: TenantKeyring; clock: Clock }, tx: TenantTx, input: {
  rows: readonly ImportRow[]; lawfulBasis: string; acquiredFrom: string; importedBy: string;
}): Promise<{ importId: string; imported: number; rejected: number }> {
  if (!input.lawfulBasis?.trim()) {
    await appendAudit(tx, { type: 'import.refused', actor: { kind: 'user', ref: input.importedBy }, subject: `tenant:${tx.scope.tenantId}`, payload: { reason: 'no_lawful_basis', rows: input.rows.length } });
    throw new ContractViolation('§18', 'an import needs a recorded lawful basis: nothing was imported');
  }
  if (!input.acquiredFrom?.trim()) throw new ContractViolation('§18', 'an import needs to say where the data came from: nothing was imported');
  const importId = randomUUID();
  const key = `import:${importId.slice(0, 8)}`;
  await tx.insertInto('lead_sources').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, key, tier: 'B', type: 'import', lawful_basis: input.lawfulBasis, data_categories: ['name', 'email', 'phone'],
    acquired_from: input.acquiredFrom, retention_days: 2190, enabled: true,
  }).execute();
  let imported = 0;
  for (const r of input.rows) {
    const email = r.email ? normaliseEmail(r.email) : null;
    const phone = r.phone ? normalisePhone(r.phone) : null;
    if (!email && !phone) continue;
    const id = randomUUID();
    const f = (column: string) => ({ table: 'contacts', column, rowId: id, subject: id });
    const emailIdx = email ? await deps.keyring.index(tx, 'email', email) : null;
    const phoneIdx = phone ? await deps.keyring.index(tx, 'phone', phone) : null;
    const dup = await tx.selectFrom('contacts').select('id').where((eb) => eb.or([
      ...(emailIdx ? [eb('email_bidx', '=', emailIdx)] : []), ...(phoneIdx ? [eb('phone_bidx', '=', phoneIdx)] : []),
    ])).executeTakeFirst();
    if (dup) continue; // already known: their existing provenance stands
    await tx.insertInto('contacts').values({
      id, tenant_id: tx.scope.tenantId, region: tx.scope.region,
      display_name_enc: r.name ? await deps.keyring.seal(tx, f('display_name_enc'), r.name) : null,
      email_enc: email ? await deps.keyring.seal(tx, f('email_enc'), email) : null, email_bidx: emailIdx,
      phone_enc: phone ? await deps.keyring.seal(tx, f('phone_enc'), phone) : null, phone_bidx: phoneIdx,
      source: key, lawful_basis: input.lawfulBasis, captured_at: deps.clock.now(), captured_by: `import:${importId}`,
    }).execute();
    imported++;
  }
  const rejected = input.rows.length - imported;
  await tx.insertInto('data_imports').values({
    id: importId, tenant_id: tx.scope.tenantId, region: tx.scope.region, kind: 'contacts', lawful_basis: input.lawfulBasis, acquired_from: input.acquiredFrom,
    imported_by: input.importedBy, rows_in: input.rows.length, rows_imported: imported, rows_rejected: rejected, lead_source_key: key, imported_at: deps.clock.now(),
  }).execute();
  await appendAudit(tx, { type: 'import.completed', actor: { kind: 'user', ref: input.importedBy }, subject: `import:${importId}`, payload: { imported, rejected, basis: input.lawfulBasis } });
  return { importId, imported, rejected };
}
