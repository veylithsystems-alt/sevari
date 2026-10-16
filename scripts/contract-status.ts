/** Prints the contract test table: id, phase, delivered?, implemented? (§13 reporting). */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONTRACT_TESTS } from '../tests/contract/registry.ts';
import phases from '../tests/contract/phases.json' with { type: 'json' };

const ROOT = resolve(import.meta.dirname, '..');
const walk = (d: string, out: string[] = []): string[] => {
  let es: string[] = [];
  try { es = readdirSync(d); } catch { return out; }
  for (const e of es) {
    if (e === 'node_modules') continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.test.ts')) out.push(p);
  }
  return out;
};
const implemented = new Set<string>();
for (const d of ['tests', 'packages', 'apps']) for (const f of walk(join(ROOT, d))) {
  for (const m of readFileSync(f, 'utf8').matchAll(/contractSuite\('([A-Z0-9-]+)'/g)) implemented.add(m[1]!);
}
const delivered = new Set(phases.delivered);
console.log('| Test | Phase | Implemented | Phase delivered | Title |\n|---|---|---|---|---|');
for (const t of CONTRACT_TESTS) {
  console.log(`| ${t.id} | ${t.phase} | ${implemented.has(t.id) ? 'yes' : 'no (red)'} | ${delivered.has(t.phase) ? 'yes' : 'no'} | ${t.title} |`);
}
const done = CONTRACT_TESTS.filter((t) => implemented.has(t.id)).length;
console.log(`\n${done}/${CONTRACT_TESTS.length} contract tests implemented; delivered phases: ${[...delivered].join(', ')}`);
