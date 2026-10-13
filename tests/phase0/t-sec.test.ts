import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { contractSuite } from '../support/contract.ts';
import { scanText } from '../../scripts/secret-scan.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

contractSuite('T-SEC', () => {
  it('gitleaks is configured and runs in CI on every push', () => {
    expect(existsSync(resolve(ROOT, '.gitleaks.toml'))).toBe(true);
    const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toMatch(/gitleaks/);
  });

  it('the fallback scanner catches planted secrets', () => {
    // Built at runtime so this file does not itself contain secret-shaped literals.
    const dashes = '-'.repeat(5);
    expect(scanText(`${dashes}BEGIN ${'PRIVATE'} KEY${dashes}`)).toContain('private key block');
    expect(scanText(`key = "${'sk_live_'}${'a'.repeat(24)}"`)).toContain('Stripe live secret');
    expect(scanText(`AKIA${'A'.repeat(16)}`)).toContain('AWS access key');
    expect(scanText(['postgres://app', ':', 'hunter2hunter2', '@db/x'].join(''))).toContain('generic password URL');
    expect(scanText('postgres://sevari_app:app_test_only@127.0.0.1/x')).toEqual([]);
  });

  it('the repository is clean', () => {
    const out = execFileSync('node', ['scripts/secret-scan.ts'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toMatch(/clean/);
  });

  it('env files and key material are git-ignored', () => {
    const ignore = readFileSync(resolve(ROOT, '.gitignore'), 'utf8');
    for (const p of ['.env', '*.key', '*.pem']) expect(ignore).toContain(p);
  });
});
