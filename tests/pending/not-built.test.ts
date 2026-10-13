/**
 * Phase 0 rule (§11): every contract test exists from day one and fails for the right reason until its
 * phase is built. This file registers a red test for every registry id that has no real test yet.
 * Real tests are found by scanning for `contractSuite('<ID>'` in the test tree.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTRACT_TESTS, RESURRECTION_TESTS_PENDING } from '../contract/registry.ts';
import { notBuilt } from '../support/contract.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCAN = ['tests', 'packages', 'apps'];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.test.ts') && !p.endsWith('not-built.test.ts')) out.push(p);
  }
  return out;
}

const implemented = new Set<string>();
for (const d of SCAN) {
  for (const f of walk(join(ROOT, d))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/contractSuite\('([A-Z0-9-]+)'/g)) implemented.add(m[1]!);
  }
}

for (const t of CONTRACT_TESTS) {
  if (!implemented.has(t.id)) notBuilt(t.id, t.title);
}

describe('[T1-T23] v3.6 resurrection review tests', () => {
  it.fails('are mapped (awaiting the T1-T23 review document; see docs/reference/t-mapping.md)', () => {
    expect(RESURRECTION_TESTS_PENDING).toEqual([]);
  });
});
