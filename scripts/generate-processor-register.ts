/** Regenerates docs/PROCESSOR_REGISTER.md (§69). `--check` fails if the committed file is stale. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { crossCheck, loadEgressPolicy, loadProcessorRegistry, renderRegister } from '@sevari/egress';

const ROOT = resolve(import.meta.dirname, '..');
const policy = await loadEgressPolicy(resolve(ROOT, 'config/egress.allowlist.yaml'));
const registry = await loadProcessorRegistry(resolve(ROOT, 'config/processors.yaml'));
const today = new Date().toISOString().slice(0, 10); // eslint-disable-line sevari/no-raw-date -- build script
const problems = crossCheck(policy, registry, today);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
const out = renderRegister(policy, registry);
const target = resolve(ROOT, 'docs/PROCESSOR_REGISTER.md');
if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8').catch(() => '');
  if (current !== out) {
    console.error('docs/PROCESSOR_REGISTER.md is stale: run pnpm register:generate');
    process.exit(1);
  }
  console.log('processor register up to date');
} else {
  await writeFile(target, out);
  console.log('wrote docs/PROCESSOR_REGISTER.md');
}
