/** Notifications to humans (§74): the owner app inbox, encrypted, de-duplicated by key. */
import { randomUUID } from 'node:crypto';
import type { TenantKeyring } from '@sevari/crypto';
import type { NotificationKind, TenantTx } from '@sevari/db';

export interface Notice {
  readonly userId: string;
  readonly kind: NotificationKind;
  readonly ref: string;
  readonly dedupeKey: string;
  readonly text: string;
  /** The person this notice is about, if any: its text is sealed with their key and goes with their erasure. */
  readonly subjectContactId?: string | null;
}

export async function notify(tx: TenantTx, keyring: TenantKeyring, n: Notice): Promise<string | null> {
  const existing = await tx.selectFrom('human_notifications').select('id').where('dedupe_key', '=', n.dedupeKey).executeTakeFirst();
  if (existing) return null;
  const id = randomUUID();
  await tx.insertInto('human_notifications').values({
    id, tenant_id: tx.scope.tenantId, region: tx.scope.region, user_id: n.userId, kind: n.kind, ref: n.ref, dedupe_key: n.dedupeKey,
    body_enc: await keyring.seal(tx, { table: 'human_notifications', column: 'body_enc', rowId: id, subject: n.subjectContactId ?? null }, n.text),
    subject_contact_id: n.subjectContactId ?? null,
  }).execute();
  return id;
}

export async function ownerOf(tx: TenantTx): Promise<string | null> {
  const o = await tx.selectFrom('users').select('id').where('role', '=', 'owner').where('status', '=', 'active').executeTakeFirst();
  return o?.id ?? null;
}
