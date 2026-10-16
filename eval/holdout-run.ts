/**
 * Release-time holdout run (Part J §68, F3H). The ONLY reader of eval/holdout/. Exits non-zero if any
 * case that must be blocked would be sent. Prints aggregate results only (no case contents).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { judge, parseCases } from './adversarial/run.ts';

export function runHoldout(dir = resolve(import.meta.dirname, 'holdout')) {
  const cases = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => parseCases(readFileSync(join(dir, f), 'utf8')));
  const results = cases.map(judge);
  const leaked = results.filter((r) => r.expect === 'block' && r.got === 'pass');
  const overBlocked = results.filter((r) => r.expect === 'pass' && r.got === 'block');
  return { n: results.length, leaked: leaked.map((r) => r.id), over_blocked: overBlocked.map((r) => r.id) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = runHoldout();
  console.log(JSON.stringify(r));
  if (r.leaked.length) process.exit(1);
}
