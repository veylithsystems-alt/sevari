import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Key-encryption-key service for one cell (§6.3). v1 is a local key file; Vault/HSM later behind
 * the same interface. The KEK never leaves this object and never touches the database.
 */
export interface Kms {
  readonly kekId: string;
  wrap(dek: Buffer, context: string): Promise<Buffer>;
  unwrap(wrapped: Buffer, context: string): Promise<Buffer>;
  /** Round-trips a probe value. Used by the boot guard (INV-9: KMS reachable). */
  healthCheck(): Promise<void>;
}

const WRAP_VERSION = 0x01;

export class LocalKeyFileKms implements Kms {
  readonly kekId: string;
  readonly #kek: Buffer;

  private constructor(kek: Buffer, kekId: string) {
    if (kek.length !== 32) throw new Error('KEK must be exactly 32 bytes');
    this.#kek = Buffer.from(kek);
    this.kekId = kekId;
  }

  /** Key file: 32 raw bytes, or 64 hex characters. The id is derived from the key, so rotation is visible. */
  static async fromFile(path: string): Promise<LocalKeyFileKms> {
    const raw = await readFile(path);
    const text = raw.toString('utf8').trim();
    const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : raw;
    return LocalKeyFileKms.fromKey(key);
  }

  static fromKey(kek: Buffer): LocalKeyFileKms {
    const id = 'local:' + createHash('sha256').update('sevari-kek-id').update(kek).digest('hex').slice(0, 16);
    return new LocalKeyFileKms(kek, id);
  }

  async wrap(dek: Buffer, context: string): Promise<Buffer> {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#kek, iv);
    c.setAAD(Buffer.from(`wrap|${this.kekId}|${context}`));
    const ct = Buffer.concat([c.update(dek), c.final()]);
    return Buffer.concat([Buffer.of(WRAP_VERSION), iv, c.getAuthTag(), ct]);
  }

  async unwrap(wrapped: Buffer, context: string): Promise<Buffer> {
    if (wrapped[0] !== WRAP_VERSION) throw new Error('Unknown wrapped-key format');
    const d = createDecipheriv('aes-256-gcm', this.#kek, wrapped.subarray(1, 13));
    d.setAAD(Buffer.from(`wrap|${this.kekId}|${context}`));
    d.setAuthTag(wrapped.subarray(13, 29));
    return Buffer.concat([d.update(wrapped.subarray(29)), d.final()]);
  }

  async healthCheck(): Promise<void> {
    const probe = randomBytes(32);
    const back = await this.unwrap(await this.wrap(probe, 'health'), 'health');
    if (!timingSafeEqual(probe, back)) throw new Error('KMS round-trip mismatch');
  }
}
