import type { TenantTx } from '@sevari/db';
import { ContractViolation } from '@sevari/domain';
import type { Kms } from './kms.ts';
import { blindIndex, fieldKeyVersion, newDek, openField, sealField, type FieldContext } from './envelope.ts';

type Purpose = 'data' | 'blind_index';
interface Unwrapped { readonly version: number; readonly dek: Buffer }

/**
 * Per-tenant envelope encryption over the tenant_keys table (§6.3).
 * Unwrapped keys are cached per transaction only, so a shred is effective for the very next transaction
 * in every process. There is no cross-request key cache to go stale.
 */
export class TenantKeyring {
  readonly #kms: Kms;
  readonly #cache = new WeakMap<object, Map<string, Unwrapped>>();

  constructor(kms: Kms) {
    this.#kms = kms;
  }

  #context(tx: TenantTx, purpose: Purpose, version: number): string {
    return `${tx.scope.tenantId}|${tx.scope.region}|${purpose}|v${version}`;
  }

  /** Creates version-1 data and blind-index keys for a new tenant. */
  async provision(tx: TenantTx): Promise<void> {
    for (const purpose of ['data', 'blind_index'] as const) {
      const dek = newDek();
      await tx.insertInto('tenant_keys').values({
        tenant_id: tx.scope.tenantId, region: tx.scope.region, key_version: 1, purpose,
        kek_id: this.#kms.kekId, wrapped_dek: await this.#kms.wrap(dek, this.#context(tx, purpose, 1)),
      }).execute();
    }
  }

  async #key(tx: TenantTx, purpose: Purpose, version?: number): Promise<Unwrapped> {
    let perTx = this.#cache.get(tx);
    if (!perTx) this.#cache.set(tx, (perTx = new Map()));
    const cacheKey = `${purpose}:${version ?? 'active'}`;
    const hit = perTx.get(cacheKey);
    if (hit) return hit;
    let q = tx.selectFrom('tenant_keys').select(['key_version', 'wrapped_dek', 'state']).where('purpose', '=', purpose);
    q = version === undefined ? q.where('state', '=', 'active') : q.where('key_version', '=', version);
    const row = await q.executeTakeFirst();
    if (!row) throw new ContractViolation('I12', `no ${version === undefined ? 'active ' : ''}${purpose} key for tenant`);
    if (row.state === 'shredded' || !row.wrapped_dek) throw new ContractViolation('I12', `${purpose} key v${row.key_version} has been crypto-shredded`);
    const unwrapped = { version: row.key_version, dek: await this.#kms.unwrap(row.wrapped_dek, this.#context(tx, purpose, row.key_version)) };
    perTx.set(cacheKey, unwrapped);
    if (version === undefined) perTx.set(`${purpose}:${row.key_version}`, unwrapped);
    return unwrapped;
  }

  async seal(tx: TenantTx, ctx: Omit<FieldContext, 'tenantId' | 'region'>, plaintext: string | Buffer): Promise<Buffer> {
    const k = await this.#key(tx, 'data');
    return sealField(k.dek, k.version, { ...ctx, tenantId: tx.scope.tenantId, region: tx.scope.region }, plaintext);
  }

  async open(tx: TenantTx, ctx: Omit<FieldContext, 'tenantId' | 'region'>, sealed: Buffer): Promise<Buffer> {
    const k = await this.#key(tx, 'data', fieldKeyVersion(sealed));
    return openField(k.dek, { ...ctx, tenantId: tx.scope.tenantId, region: tx.scope.region }, sealed);
  }

  async openText(tx: TenantTx, ctx: Omit<FieldContext, 'tenantId' | 'region'>, sealed: Buffer): Promise<string> {
    return (await this.open(tx, ctx, sealed)).toString('utf8');
  }

  /** Blind index on an already-normalised value (see @sevari/domain normalisers). */
  async index(tx: TenantTx, kind: string, normalisedValue: string): Promise<Buffer> {
    const k = await this.#key(tx, 'blind_index');
    return blindIndex(k.dek, kind, normalisedValue);
  }

  /** Data-key rotation: new writes use v+1; old versions stay readable until the re-encryption job finishes. */
  async rotate(tx: TenantTx): Promise<number> {
    const current = await tx.selectFrom('tenant_keys').select(['id', 'key_version']).where('purpose', '=', 'data')
      .where('state', '=', 'active').executeTakeFirstOrThrow();
    const next = current.key_version + 1;
    await tx.updateTable('tenant_keys').set({ state: 'retired' }).where('id', '=', current.id).execute();
    await tx.insertInto('tenant_keys').values({
      tenant_id: tx.scope.tenantId, region: tx.scope.region, key_version: next, purpose: 'data',
      kek_id: this.#kms.kekId, wrapped_dek: await this.#kms.wrap(newDek(), this.#context(tx, 'data', next)),
    }).execute();
    this.#cache.delete(tx);
    return next;
  }

  /**
   * Crypto-shred every key of the tenant (part of erasure, §6.3/§21.1). Irreversible: a trigger refuses
   * to un-shred. Callers must hold a human approval for the final erase (§8.3); that check lives in privacy.
   */
  async shredAll(tx: TenantTx, at: Date): Promise<number> {
    const res = await tx.updateTable('tenant_keys').set({ state: 'shredded', wrapped_dek: null, shredded_at: at })
      .where('state', '<>', 'shredded').executeTakeFirst();
    this.#cache.delete(tx);
    return Number(res.numUpdatedRows);
  }
}
