import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Field ciphertext format v1:
 *   0x01 | key_version u32be | iv(12) | tag(16) | ciphertext
 * The AAD binds the ciphertext to tenant, region, table, column and row id, so a ciphertext copied
 * into another row, column or tenant fails to decrypt (no "swap" attacks).
 */
const FORMAT_V1 = 0x01;

export interface FieldContext {
  readonly tenantId: string;
  readonly region: string;
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
}

const aad = (ctx: FieldContext): Buffer =>
  Buffer.from(JSON.stringify(['sevari-field-v1', ctx.tenantId, ctx.region, ctx.table, ctx.column, ctx.rowId]));

export function sealField(dek: Buffer, keyVersion: number, ctx: FieldContext, plaintext: string | Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek, iv);
  c.setAAD(aad(ctx));
  const ct = Buffer.concat([c.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext), c.final()]);
  const header = Buffer.alloc(5);
  header[0] = FORMAT_V1;
  header.writeUInt32BE(keyVersion, 1);
  return Buffer.concat([header, iv, c.getAuthTag(), ct]);
}

export function fieldKeyVersion(sealed: Buffer): number {
  if (sealed[0] !== FORMAT_V1) throw new Error('Unknown field ciphertext format');
  return sealed.readUInt32BE(1);
}

export function openField(dek: Buffer, ctx: FieldContext, sealed: Buffer): Buffer {
  fieldKeyVersion(sealed);
  const d = createDecipheriv('aes-256-gcm', dek, sealed.subarray(5, 17));
  d.setAAD(aad(ctx));
  d.setAuthTag(sealed.subarray(17, 33));
  return Buffer.concat([d.update(sealed.subarray(33)), d.final()]);
}

/** A per-tenant, per-kind lookup key derived from the tenant's blind-index key. */
export function blindIndexKey(indexKey: Buffer, kind: string): Buffer {
  return Buffer.from(hkdfSync('sha256', indexKey, Buffer.alloc(0), `sevari-blind-index:${kind}`, 32));
}

/** Deterministic keyed digest for equality lookups on encrypted columns (§6.3). */
export function blindIndex(indexKey: Buffer, kind: string, normalisedValue: string): Buffer {
  return createHmac('sha256', blindIndexKey(indexKey, kind)).update(normalisedValue, 'utf8').digest();
}

export const newDek = (): Buffer => randomBytes(32);
