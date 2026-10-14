import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { judge, parseCases } from '../../eval/adversarial/run.ts';
import { runHoldout } from '../../eval/holdout-run.ts';
import { contractSuite } from '../support/contract.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

function files(dir: string, out: string[] = []): string[] {
  let es: string[] = [];
  try { es = readdirSync(dir); } catch { return out; }
  for (const e of es) {
    if (e === 'node_modules' || e === 'holdout') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out); else if (/\.(ts|js|mjs)$/.test(p)) out.push(p);
  }
  return out;
}

contractSuite('F3H', () => {
  it('the holdout corpus sends zero unsupported claims', () => {
    const r = runHoldout();
    expect(r.n).toBeGreaterThan(0);
    expect(r.leaked).toEqual([]);
  });

  it('nothing but the release runner (and this test) reads the holdout folder: it is never used for tuning', () => {
    const readers = ['packages', 'apps', 'eval', 'tests', 'scripts', 'tools'].flatMap((d) => files(join(ROOT, d)))
      .filter((f) => /holdout['"/]/.test(readFileSync(f, 'utf8')) || /['"]holdout['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f)).sort();
    expect(readers).toEqual(['eval/holdout-run.ts', 'tests/phase4/f3h-holdout.test.ts']);
  });
});

describe('[Part J §68] adversarial development set (used to build grounding; not the holdout)', () => {
  const cases = parseCases(readFileSync(join(ROOT, 'eval/adversarial/dev.jsonl'), 'utf8'));
  for (const c of cases) {
    it(`${c.id} ${c.category}: ${c.expect}`, () => {
      expect(judge(c).got).toBe(c.expect);
    });
  }
});
