/** Row locks that serialise opt-outs against sends for one recipient (§17.2: opt-out always wins, F9). */
import { sql } from 'kysely';
import type { TenantTx } from './session.ts';

export async function lockRecipient(tx: TenantTx, recipientBidx: Buffer): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'recipient:' + tx.scope.tenantId + ':'} || encode(${recipientBidx}, 'hex'), 0))`.execute(tx);
}

/** Locks one outbox row for a state transition. */
export async function lockOutbox(tx: TenantTx, outboxId: string): Promise<void> {
  await sql`SELECT 1 FROM outbox WHERE id = ${outboxId} FOR UPDATE`.execute(tx);
}
