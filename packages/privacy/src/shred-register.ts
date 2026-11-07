/**
 * The shred register (§67, T-KEY-3, F35): an append-only, hash-chained record of every key destruction,
 * kept OUTSIDE the database. A database backup taken before an erasure knows nothing of that erasure; on
 * restore, re-applying this register destroys the keys again before the database serves anything.
 * v1 is a local file on a different volume from the database and its backups; the production target is
 * the cell's separate key host or object storage with object lock (docs/security/key-management.md).
 */
import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';

export interface ShredEntry {
  readonly at: string;
  readonly tenantId: string;
  readonly region: string;
  /** 'subject': one person's key; 'tenant': every key of a business. */
  readonly kind: 'subject' | 'tenant';
  readonly subjectRef?: string;
  readonly reason: string;
}
type Chained = ShredEntry & { readonly prev: string; readonly hash: string };

export interface ShredRegister {
  append(e: ShredEntry): Promise<void>;
  entries(): Promise<ShredEntry[]>;
}

const hashOf = (prev: string, e: ShredEntry) => createHash('sha256').update(prev).update(JSON.stringify([e.at, e.tenantId, e.region, e.kind, e.subjectRef ?? null, e.reason])).digest('hex');

export class FileShredRegister implements ShredRegister {
  readonly #path: string;
  constructor(path: string) {
    this.#path = path;
  }
  async #read(): Promise<Chained[]> {
    let text = '';
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Chained);
    let prev = 'genesis';
    for (const r of rows) {
      if (r.prev !== prev || r.hash !== hashOf(prev, r)) throw new Error('shred register has been altered (hash chain broken)');
      prev = r.hash;
    }
    return rows;
  }
  async append(e: ShredEntry): Promise<void> {
    const rows = await this.#read();
    const prev = rows.at(-1)?.hash ?? 'genesis';
    await appendFile(this.#path, `${JSON.stringify({ ...e, prev, hash: hashOf(prev, e) })}\n`, { mode: 0o600 });
  }
  async entries(): Promise<ShredEntry[]> {
    return (await this.#read()).map(({ prev: _p, hash: _h, ...e }) => e);
  }
}

/** For tests and single-process tools. */
export class MemoryShredRegister implements ShredRegister {
  readonly rows: ShredEntry[] = [];
  async append(e: ShredEntry): Promise<void> {
    this.rows.push(e);
  }
  async entries(): Promise<ShredEntry[]> {
    return [...this.rows];
  }
}
