import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type DbHandle } from '@sevari/db';
import type { TenantScope } from '@sevari/domain';
import { LocalKeyFileKms, TenantKeyring, sealField, openField, newDek, blindIndex } from '@sevari/crypto';
import { appDb, newTenant } from '../../../tests/support/fixtures.ts';

const ctx = { tenantId: 't1', region: 'uk', table: 'contacts', column: 'email_enc', rowId: 'r1' };

describe('[I12] envelope encryption primitives', () => {
  it('round-trips and binds ciphertext to its context', () => {
    const dek = newDek();
    const sealed = sealField(dek, 1, ctx, 'jo@example.com');
    expect(openField(dek, ctx, sealed).toString()).toBe('jo@example.com');
    expect(() => openField(dek, { ...ctx, rowId: 'r2' }, sealed)).toThrow();
    expect(() => openField(dek, { ...ctx, tenantId: 't2' }, sealed)).toThrow();
    expect(() => openField(dek, { ...ctx, column: 'phone_enc' }, sealed)).toThrow();
  });

  it('detects any bit flip', () => {
    const dek = newDek();
    const sealed = sealField(dek, 1, ctx, 'secret');
    for (const i of [0, 5, 20, sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[i] = bad[i]! ^ 0x01;
      expect(() => openField(dek, ctx, bad)).toThrow();
    }
  });

  it('never produces the same ciphertext twice for the same plaintext', () => {
    const dek = newDek();
    expect(sealField(dek, 1, ctx, 'x').equals(sealField(dek, 1, ctx, 'x'))).toBe(false);
  });

  it('blind indexes are deterministic per key and kind, and differ across tenants', () => {
    const k1 = newDek();
    const k2 = newDek();
    expect(blindIndex(k1, 'email', 'a@b.c').equals(blindIndex(k1, 'email', 'a@b.c'))).toBe(true);
    expect(blindIndex(k1, 'email', 'a@b.c').equals(blindIndex(k1, 'phone', 'a@b.c'))).toBe(false);
    expect(blindIndex(k1, 'email', 'a@b.c').equals(blindIndex(k2, 'email', 'a@b.c'))).toBe(false);
  });

  it('KMS wrap is bound to context and KEK', async () => {
    const kms = LocalKeyFileKms.fromKey(Buffer.alloc(32, 1));
    const other = LocalKeyFileKms.fromKey(Buffer.alloc(32, 2));
    const dek = newDek();
    const w = await kms.wrap(dek, 'a');
    expect((await kms.unwrap(w, 'a')).equals(dek)).toBe(true);
    await expect(kms.unwrap(w, 'b')).rejects.toThrow();
    await expect(other.unwrap(w, 'a')).rejects.toThrow();
    expect(kms.kekId).not.toBe(other.kekId);
  });
});

describe('[I12] tenant keyring: rotation and crypto-shred', () => {
  let h: DbHandle;
  let t: TenantScope;
  const kms = LocalKeyFileKms.fromKey(Buffer.alloc(32, 9));
  const ring = new TenantKeyring(kms);
  const field = { table: 'contacts', column: 'email_enc', rowId: '00000000-0000-0000-0000-000000000001' };

  beforeAll(async () => {
    h = appDb();
    t = await newTenant(h);
    await withTenant(h.db, t, (tx) => ring.provision(tx));
  });
  afterAll(async () => h.close());

  it('seals and opens through the database-held wrapped key', async () => {
    const sealed = await withTenant(h.db, t, (tx) => ring.seal(tx, field, 'pat@example.com'));
    expect(await withTenant(h.db, t, (tx) => ring.openText(tx, field, sealed))).toBe('pat@example.com');
  });

  it('rotation keeps old ciphertext readable and new writes use the new version', async () => {
    const old = await withTenant(h.db, t, (tx) => ring.seal(tx, field, 'before'));
    const v = await withTenant(h.db, t, (tx) => ring.rotate(tx));
    expect(v).toBe(2);
    const fresh = await withTenant(h.db, t, (tx) => ring.seal(tx, field, 'after'));
    expect(fresh.readUInt32BE(1)).toBe(2);
    expect(await withTenant(h.db, t, (tx) => ring.openText(tx, field, old))).toBe('before');
    expect(await withTenant(h.db, t, (tx) => ring.openText(tx, field, fresh))).toBe('after');
  });

  it('crypto-shred makes every ciphertext and blind index permanently unusable', async () => {
    const sealed = await withTenant(h.db, t, (tx) => ring.seal(tx, field, 'gone soon'));
    const shredded = await withTenant(h.db, t, (tx) => ring.shredAll(tx, new Date('2026-10-13T10:00:00Z')));
    expect(shredded).toBe(3); // data v1, data v2, blind_index v1
    await expect(withTenant(h.db, t, (tx) => ring.openText(tx, field, sealed))).rejects.toThrow(/crypto-shredded|no active/);
    await expect(withTenant(h.db, t, (tx) => ring.index(tx, 'email', 'x'))).rejects.toThrow();
    await expect(withTenant(h.db, t, (tx) => tx.updateTable('tenant_keys').set({ state: 'active' }).execute())).rejects.toThrow(/shredded|permission/);
  });
});
