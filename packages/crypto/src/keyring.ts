import type { TenantTx } from '@sevari/db';
import { ContractViolation } from '@sevari/domain';
import type { Kms } from './kms.ts';
import { randomUUID } from 'node:crypto';
import { blindIndex, fieldKeyVersion, fieldSubjectKeyId, newDek, openField, openSubjectField, sealField, sealSubjectField, type FieldContext } from './envelope.ts';

type Purpose = 'data' | 'blind_index';
/** Where a field lives, and optionally whose it is. Data about a person is sealed with that person's key. */
export type SealContext = Omit<FieldContext, 'tenantId' | 'region'> & { readonly subject?: string | null };
interface Unwrapped { readonly version: number; readonly dek: Buffer }

/**
 * Per-tenant envelope encryption over the tenant_keys table (§6.3).
 * Unwrapped keys are cached per transaction only, so a shred is effective for the very next transaction
 * in every process. There is no cross-request key cache to go stale.
 */
export class TenantKeyring {
  readonly #kms: Kms;
  readonly #cache = new WeakMap<object, Map<string, Unwrapped>>();
  /** Per-transaction cache of unwrapped person keys, by subject and by key id. */
  readonly #people = new WeakMap<object, Map<string, { id: string; dek: Buffer }>>();

  #peopleOf(tx: TenantTx): Map<string, { id: string; dek: Buffer }> {
    let m = this.#people.get(tx);
    if (!m) this.#people.set(tx, (m = new Map()));
    return m;
  }

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
    let q = tx.selectFrom('tenant_keys').select(['key_version', 'wrapped_dek', 'state', 'kek_id']).where('purpose', '=', purpose);
    q = version === undefined ? q.where('state', '=', 'active') : q.where('key_version', '=', version);
    const row = await q.executeTakeFirst();
    if (!row) throw new ContractViolation('I12', `no ${version === undefined ? 'active ' : ''}${purpose} key for tenant`);
    if (row.state === 'shredded' || !row.wrapped_dek) throw new ContractViolation('I12', `${purpose} key v${row.key_version} has been crypto-shredded`);
    const unwrapped = { version: row.key_version, dek: await this.#kms.unwrap(row.wrapped_dek, this.#context(tx, purpose, row.key_version), row.kek_id) };
    perTx.set(cacheKey, unwrapped);
    if (version === undefined) perTx.set(`${purpose}:${row.key_version}`, unwrapped);
    return unwrapped;
  }

  #subjectContext(tx: TenantTx, keyId: string): string {
    return `${tx.scope.tenantId}|${tx.scope.region}|subject|${keyId}`;
  }

  /** The person's active key, created on first use. */
  async #subjectKey(tx: TenantTx, subject: string): Promise<{ id: string; dek: Buffer }> {
    const perTx = this.#peopleOf(tx);
    const hit = perTx.get(`subject:${subject}`);
    if (hit) return hit;
    const find = () => tx.selectFrom('subject_keys').select(['id', 'wrapped_dek', 'kek_id']).where('subject_ref', '=', subject).where('state', '=', 'active').executeTakeFirst();
    let row = await find();
    if (!row) {
      const id = randomUUID();
      await tx.insertInto('subject_keys').values({
        id, tenant_id: tx.scope.tenantId, region: tx.scope.region, subject_ref: subject, kek_id: this.#kms.kekId,
        wrapped_dek: await this.#kms.wrap(newDek(), this.#subjectContext(tx, id)),
      }).onConflict((oc) => oc.columns(['tenant_id', 'subject_ref']).where('state', '=', 'active').doNothing()).execute();
      row = await find();
    }
    if (!row?.wrapped_dek) throw new ContractViolation('I12', 'no usable key for this person');
    const k = { id: row.id, dek: await this.#kms.unwrap(row.wrapped_dek, this.#subjectContext(tx, row.id), row.kek_id) };
    perTx.set(`subject:${subject}`, k);
    perTx.set(`subject-key:${row.id}`, k);
    return k;
  }

  async #subjectKeyById(tx: TenantTx, keyId: string): Promise<Buffer> {
    const perTx = this.#peopleOf(tx);
    const hit = perTx.get(`subject-key:${keyId}`);
    if (hit) return hit.dek;
    const row = await tx.selectFrom('subject_keys').select(['state', 'wrapped_dek', 'kek_id']).where('id', '=', keyId).executeTakeFirst();
    if (!row) throw new ContractViolation('I12', 'unknown person key');
    if (row.state === 'shredded' || !row.wrapped_dek) throw new ContractViolation('I12', 'this person\'s data has been erased (key shredded)');
    const dek = await this.#kms.unwrap(row.wrapped_dek, this.#subjectContext(tx, keyId), row.kek_id);
    perTx.set(`subject-key:${keyId}`, { id: keyId, dek });
    return dek;
  }

  async seal(tx: TenantTx, ctx: SealContext, plaintext: string | Buffer): Promise<Buffer> {
    const { subject, ...where } = ctx;
    const field = { ...where, tenantId: tx.scope.tenantId, region: tx.scope.region };
    if (subject) {
      const k = await this.#subjectKey(tx, subject);
      return sealSubjectField(k.dek, k.id, field, plaintext);
    }
    const k = await this.#key(tx, 'data');
    return sealField(k.dek, k.version, field, plaintext);
  }

  async open(tx: TenantTx, ctx: SealContext, sealed: Buffer): Promise<Buffer> {
    const { subject: _subject, ...where } = ctx;
    const field = { ...where, tenantId: tx.scope.tenantId, region: tx.scope.region };
    const subjectKeyId = fieldSubjectKeyId(sealed);
    if (subjectKeyId) return openSubjectField(await this.#subjectKeyById(tx, subjectKeyId), field, sealed);
    const k = await this.#key(tx, 'data', fieldKeyVersion(sealed));
    return openField(k.dek, field, sealed);
  }

  async openText(tx: TenantTx, ctx: SealContext, sealed: Buffer): Promise<string> {
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
    const people = await tx.updateTable('subject_keys').set({ state: 'shredded', wrapped_dek: null, shredded_at: at })
      .where('state', '<>', 'shredded').executeTakeFirst();
    this.#cache.delete(tx);
    this.#people.delete(tx);
    return Number(res.numUpdatedRows) + Number(people.numUpdatedRows);
  }

  /**
   * KEK rotation (§67, T-KEY-1): re-wraps every live key of this tenant (business and person keys) with
   * the KMS's active KEK. The data keys themselves don't change, so no data is re-encrypted or lost.
   * Shredded keys stay shredded. Returns the number of keys re-wrapped.
   */
  async rewrapKeys(tx: TenantTx): Promise<number> {
    const target = this.#kms.kekId;
    let n = 0;
    const tk = await tx.selectFrom('tenant_keys').select(['id', 'purpose', 'key_version', 'wrapped_dek', 'kek_id']).where('state', '<>', 'shredded').where('kek_id', '<>', target).forUpdate().execute();
    for (const r of tk) {
      if (!r.wrapped_dek) continue;
      const ctx = this.#context(tx, r.purpose, r.key_version);
      const dek = await this.#kms.unwrap(r.wrapped_dek, ctx, r.kek_id);
      await tx.updateTable('tenant_keys').set({ wrapped_dek: await this.#kms.wrap(dek, ctx), kek_id: target }).where('id', '=', r.id).execute();
      n++;
    }
    const sk = await tx.selectFrom('subject_keys').select(['id', 'wrapped_dek', 'kek_id']).where('state', '=', 'active').where('kek_id', '<>', target).forUpdate().execute();
    for (const r of sk) {
      if (!r.wrapped_dek) continue;
      const ctx = this.#subjectContext(tx, r.id);
      const dek = await this.#kms.unwrap(r.wrapped_dek, ctx, r.kek_id);
      await tx.updateTable('subject_keys').set({ wrapped_dek: await this.#kms.wrap(dek, ctx), kek_id: target }).where('id', '=', r.id).execute();
      n++;
    }
    this.#cache.delete(tx);
    this.#people.delete(tx);
    return n;
  }

  /** Crypto-shred one person's key (erasure, §21.2). Everything sealed with it becomes unreadable everywhere. */
  async shredSubject(tx: TenantTx, subject: string, at: Date): Promise<number> {
    const res = await tx.updateTable('subject_keys').set({ state: 'shredded', wrapped_dek: null, shredded_at: at })
      .where('subject_ref', '=', subject).where('state', '<>', 'shredded').executeTakeFirst();
    this.#people.delete(tx);
    return Number(res.numUpdatedRows);
  }
}
