// The CI gate: runs every test, skipping contract tests whose phase is not yet claimed delivered
// (tests/contract/phases.json). A delivered phase with a red test fails the gate.
import { spawnSync } from 'node:child_process';
const r = spawnSync('pnpm', ['exec', 'vitest', 'run', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, SEVARI_GATE: '1' } });
process.exit(r.status ?? 1);
