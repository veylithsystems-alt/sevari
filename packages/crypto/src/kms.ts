import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Key-encryption-key service for one cell (§6.3). v1 is a local key file; Vault/HSM later behind
 * the same interface. The KEK never leaves this object and never touches the database.
 */
export interface Kms {
  /** The KEK new keys are wrapped with. */
  readonly kekId: string;
  wrap(dek: Buffer, context: string): Promise<Buffer>;
  /** `kekId` names the KEK the key was wrapped with (stored beside it); omitted means the active one. */
  unwrap(wrapped: Buffer, context: string, kekId?: string): Promise<Buffer>;
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

  async unwrap(wrapped: Buffer, context: string, kekId?: string): Promise<Buffer> {
    if (kekId && kekId !== this.kekId) throw new KekUnavailable(kekId, 'not held by this KMS');
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

export class KekUnavailable extends Error {
  readonly kekId: string;
  constructor(kekId: string, why: string) {
    super(`KEK ${kekId} cannot unwrap: ${why}`);
    this.name = 'KekUnavailable';
    this.kekId = kekId;
  }
}

export type KekStatus = 'active' | 'retired' | 'revoked';

/**
 * Several KEKs at once (§67): exactly one active (new keys are wrapped with it), retired ones still
 * unwrap until every key is re-wrapped, revoked ones never unwrap again. Rotation: add a new active KEK,
 * retire the old one, run rewrapKeys(), then revoke the old one.
 */
export class KekRing implements Kms {
  readonly #keks = new Map<string, { kms: LocalKeyFileKms; status: KekStatus }>();
  #active: string;
  /** Every unwrap is logged by KEK id (§67: unwrap requests are logged). Never the key or context. */
  readonly onUnwrap?: (kekId: string) => void;

  constructor(entries: ReadonlyArray<{ readonly key: Buffer; readonly status: KekStatus }>, onUnwrap?: (kekId: string) => void) {
    const active = entries.filter((e) => e.status === 'active');
    if (active.length !== 1) throw new Error('a KEK ring needs exactly one active KEK');
    for (const e of entries) {
      const kms = LocalKeyFileKms.fromKey(e.key);
      this.#keks.set(kms.kekId, { kms, status: e.status });
    }
    this.#active = LocalKeyFileKms.fromKey(active[0]?.key ?? Buffer.alloc(0)).kekId;
    if (onUnwrap) this.onUnwrap = onUnwrap;
  }

  get kekId(): string {
    return this.#active;
  }

  status(kekId: string): KekStatus | 'unknown' {
    return this.#keks.get(kekId)?.status ?? 'unknown';
  }

  /** Makes `key` the active KEK; the previous active one becomes retired. Returns the new KEK id. */
  rotateTo(key: Buffer): string {
    const kms = LocalKeyFileKms.fromKey(key);
    const prev = this.#keks.get(this.#active);
    if (prev) prev.status = 'retired';
    this.#keks.set(kms.kekId, { kms, status: 'active' });
    this.#active = kms.kekId;
    return kms.kekId;
  }

  /** A revoked KEK can never unwrap again (T-KEY-2). The active KEK can't be revoked; rotate first. */
  revoke(kekId: string): void {
    const k = this.#keks.get(kekId);
    if (!k) throw new KekUnavailable(kekId, 'unknown');
    if (kekId === this.#active) throw new Error('rotate to a new KEK before revoking the active one');
    k.status = 'revoked';
  }

  async wrap(dek: Buffer, context: string): Promise<Buffer> {
    const k = this.#keks.get(this.#active);
    if (!k) throw new KekUnavailable(this.#active, 'missing');
    return k.kms.wrap(dek, context);
  }

  async unwrap(wrapped: Buffer, context: string, kekId?: string): Promise<Buffer> {
    const id = kekId ?? this.#active;
    const k = this.#keks.get(id);
    if (!k) throw new KekUnavailable(id, 'unknown to this cell');
    if (k.status === 'revoked') throw new KekUnavailable(id, 'revoked');
    this.onUnwrap?.(id);
    return k.kms.unwrap(wrapped, context);
  }

  async healthCheck(): Promise<void> {
    const probe = randomBytes(32);
    const back = await this.unwrap(await this.wrap(probe, 'health'), 'health');
    if (!timingSafeEqual(probe, back)) throw new Error('KMS round-trip mismatch');
  }
}
