import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { expect, it } from 'vitest';
import { contractSuite } from '../support/contract.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

async function lint(code: string, file: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: ROOT });
  const [res] = await eslint.lintText(code, { filePath: resolve(ROOT, file) });
  return (res?.messages ?? []).map((m) => m.ruleId ?? m.message);
}

contractSuite('T-LINT', () => {
  it('forbids network modules and fetch outside packages/egress', async () => {
    expect(await lint("import http from 'node:https';\nexport const x = http;\n", 'packages/channels/src/x.ts')).toContain('sevari/no-network-outside-egress');
    expect(await lint("export const f = () => fetch('https://x');\n", 'apps/api/src/x.ts')).toContain('sevari/no-network-outside-egress');
    expect(await lint("import { request } from 'undici';\nexport const r = request;\n", 'packages/llm/src/x.ts')).toContain('sevari/no-network-outside-egress');
    expect(await lint("import https from 'node:https';\nexport const x = https;\n", 'packages/egress/src/x.ts')).not.toContain('sevari/no-network-outside-egress');
  });

  it('forbids I/O imports and process access inside packages/domain', async () => {
    expect(await lint("import { readFile } from 'node:fs';\nexport const r = readFile;\n", 'packages/domain/src/x.ts')).toContain('sevari/no-io-in-domain');
    expect(await lint("import pg from 'pg';\nexport const p = pg;\n", 'packages/domain/src/x.ts')).toContain('sevari/no-io-in-domain');
    expect(await lint("export const e = process.env;\n", 'packages/domain/src/x.ts')).toContain('sevari/no-io-in-domain');
    expect(await lint("export const r = Math.random();\n", 'packages/domain/src/x.ts')).toContain('sevari/no-io-in-domain');
    expect(await lint("import { z } from 'zod';\nexport const s = z.string();\n", 'packages/domain/src/x.ts')).toEqual([]);
  });

  it('forbids Date.now() and new Date() outside the Clock', async () => {
    expect(await lint('export const n = Date.now();\n', 'packages/approvals/src/x.ts')).toContain('sevari/no-raw-date');
    expect(await lint('export const d = new Date();\n', 'apps/worker/src/x.ts')).toContain('sevari/no-raw-date');
    expect(await lint("export const d = new Date('2026-01-01');\n", 'apps/worker/src/x.ts')).not.toContain('sevari/no-raw-date');
    expect(await lint('export const n = Date.now();\n', 'packages/clock/src/system-clock.ts')).not.toContain('sevari/no-raw-date');
  });

  it('forbids raw SQL outside packages/db', async () => {
    expect(await lint("export const q = 'SELECT * FROM contacts WHERE id = 1';\n", 'packages/booking/src/x.ts')).toContain('sevari/no-raw-sql-outside-db');
    expect(await lint('export const q = `DELETE FROM messages`;\n', 'apps/api/src/x.ts')).toContain('sevari/no-raw-sql-outside-db');
    expect(await lint("export const q = 'SELECT * FROM contacts';\n", 'packages/db/src/x.ts')).not.toContain('sevari/no-raw-sql-outside-db');
    expect(await lint("export const s = 'Please select a time from the list';\n", 'packages/booking/src/x.ts')).not.toContain('sevari/no-raw-sql-outside-db');
    expect(await lint("export const s = 'Can you update me on the job, please?';\n", 'packages/booking/src/x.ts')).not.toContain('sevari/no-raw-sql-outside-db');
    expect(await lint("export const q = 'select id from contacts where tenant_id = $1';\n", 'packages/booking/src/x.ts')).toContain('sevari/no-raw-sql-outside-db');
  });

  it('forbids forging a GroundedDraft outside packages/grounding', async () => {
    const code = "type GroundedDraft = { t: string };\nexport const g = { t: 'x' } as GroundedDraft;\n";
    expect(await lint(code, 'packages/llm/src/x.ts')).toContain('sevari/no-grounded-draft-forgery');
    expect(await lint(code, 'packages/grounding/src/x.ts')).not.toContain('sevari/no-grounded-draft-forgery');
  });

  it('the whole repository passes its own lint rules', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const dirs = ['packages', 'apps', 'tests', 'tools', 'scripts'].filter((d) => existsSync(resolve(ROOT, d)));
    const results = await eslint.lintFiles(dirs);
    const errors = results.flatMap((r) => r.messages.filter((m) => m.severity === 2).map((m) => `${r.filePath}:${m.line} ${m.ruleId} ${m.message}`));
    expect(errors).toEqual([]);
  });
});
