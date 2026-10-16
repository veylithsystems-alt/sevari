import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, createHash, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { verifyAuditChain, type TenantTx } from '@sevari/db';
import { canonicalJson } from '@sevari/domain';

export type ActorKind = 'system' | 'user' | 'provider' | 'customer' | 'operator';

export interface AuditEvent {
  /** Dotted lower-case name, e.g. 'message.received', 'approval.consumed'. */
  readonly type: string;
  readonly actor: { readonly kind: ActorKind; readonly ref?: string };
  /** A reference such as 'message:<uuid>'. Never personal data. */
  readonly subject?: string;
  /** Ids, digests, codes and counts only. Never personal data: the audit chain is never erased. */
  readonly payload?: Readonly<Record<string, unknown>>;
}

const FORBIDDEN_PAYLOAD_KEYS = /(^|_)(email|phone|name|body|address|postcode|text|message|content)$/i;

/** Guards the "no personal data in audit" rule at write time (a cheap, structural check). */
export function assertAuditPayloadSafe(payload: Readonly<Record<string, unknown>>, path = ''): void {
  for (const [k, v] of Object.entries(payload)) {
    if (FORBIDDEN_PAYLOAD_KEYS.test(k) && !k.endsWith('_digest') && !k.endsWith('_ref')) {
      throw new Error(`Audit payload key '${path}${k}' looks like personal data; store a digest or a reference instead`);
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) assertAuditPayloadSafe(v as Record<string, unknown>, `${path}${k}.`);
  }
}

/** Appends one event to the tenant's chain. The database assigns seq, prev_hash, hash and time. */
export async function appendAudit(tx: TenantTx, event: AuditEvent): Promise<{ id: string; seq: number }> {
  const payload = event.payload ?? {};
  assertAuditPayloadSafe(payload);
  const row = await tx.insertInto('audit_events').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, event_type: event.type,
    actor_kind: event.actor.kind, actor_ref: event.actor.ref ?? null, subject_ref: event.subject ?? null,
    payload: canonicalJson(payload),
  }).returning(['id', 'seq']).executeTakeFirstOrThrow();
  return { id: row.id, seq: Number(row.seq) };
}

export { verifyAuditChain };

/* ------------------------------------------------------------------------------------------------
 * Signed checkpoints. The signing key lives outside the database (a key file in v1, KMS/HSM later),
 * so a database-level attacker who rewrites the chain cannot re-sign earlier heads.
 * ---------------------------------------------------------------------------------------------- */

export interface CheckpointSigner {
  readonly keyId: string;
  sign(message: Buffer): Buffer;
  verify(message: Buffer, signature: Buffer): boolean;
}

export class Ed25519Signer implements CheckpointSigner {
  readonly keyId: string;
  readonly #priv: KeyObject;
  readonly #pub: KeyObject;
  private constructor(priv: KeyObject) {
    this.#priv = priv;
    this.#pub = createPublicKey(priv);
    const spki = this.#pub.export({ type: 'spki', format: 'der' });
    this.keyId = 'ed25519:' + createHash('sha256').update(spki).digest('hex').slice(0, 16);
  }
  static generate(): Ed25519Signer {
    return new Ed25519Signer(generateKeyPairSync('ed25519').privateKey);
  }
  static async fromPemFile(path: string): Promise<Ed25519Signer> {
    return new Ed25519Signer(createPrivateKey(await readFile(path, 'utf8')));
  }
  publicKeyPem(): string {
    return this.#pub.export({ type: 'spki', format: 'pem' }).toString();
  }
  sign(message: Buffer): Buffer {
    return sign(null, message, this.#priv);
  }
  verify(message: Buffer, signature: Buffer): boolean {
    return verify(null, message, this.#pub, signature);
  }
}

const checkpointMessage = (tenantId: string, region: string, seq: number, head: Buffer): Buffer =>
  Buffer.from(canonicalJson({ kind: 'sevari-audit-checkpoint-v1', tenantId, region, seq, head: head.toString('hex') }));

/** Signs the current chain head. Run on a schedule (SENTINEL) and before exports and offboarding. */
export async function checkpoint(tx: TenantTx, signer: CheckpointSigner): Promise<{ seq: number } | null> {
  const head = await tx.selectFrom('audit_events').select(['seq', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirst();
  if (!head) return null;
  const seq = Number(head.seq);
  const existing = await tx.selectFrom('audit_checkpoints').select('id').where('seq', '=', String(seq)).executeTakeFirst();
  if (existing) return { seq };
  const sig = signer.sign(checkpointMessage(tx.scope.tenantId, tx.scope.region, seq, head.hash));
  await tx.insertInto('audit_checkpoints').values({
    tenant_id: tx.scope.tenantId, region: tx.scope.region, seq: String(seq), head_hash: head.hash, key_id: signer.keyId, signature: sig,
  }).execute();
  return { seq };
}

export interface ChainReport {
  readonly intact: boolean;
  readonly events: number;
  readonly brokenAt?: { seq: number; reason: string };
  readonly checkpointsVerified: number;
  readonly checkpointFailures: number[];
}

/** Full verification: hash chain plus every signed checkpoint against the current rows. */
export async function verifyChainWithCheckpoints(tx: TenantTx, signer: CheckpointSigner): Promise<ChainReport> {
  const broken = await verifyAuditChain(tx);
  const count = await tx.selectFrom('audit_events').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
  const cps = await tx.selectFrom('audit_checkpoints').selectAll().orderBy('seq').execute();
  const failures: number[] = [];
  for (const cp of cps) {
    const seq = Number(cp.seq);
    const row = await tx.selectFrom('audit_events').select('hash').where('seq', '=', String(seq)).executeTakeFirst();
    const okSig = cp.key_id === signer.keyId && signer.verify(checkpointMessage(tx.scope.tenantId, tx.scope.region, seq, cp.head_hash), cp.signature);
    if (!okSig || !row || !row.hash.equals(cp.head_hash)) failures.push(seq);
  }
  return {
    intact: broken === null && failures.length === 0,
    events: Number(count.n),
    ...(broken ? { brokenAt: { seq: broken.brokenSeq, reason: broken.reason } } : {}),
    checkpointsVerified: cps.length - failures.length,
    checkpointFailures: failures,
  };
}
