/**
 * Fallback secret scan for environments without gitleaks (CI always runs gitleaks too).
 * Scans tracked files for high-confidence secret shapes. Exit 1 on any finding.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['private key block', /-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Stripe live secret', /\b[sr]k_live_[0-9a-zA-Z]{16,}\b/],
  ['Stripe webhook secret', /\bwhsec_[0-9a-zA-Z]{24,}\b/],
  ['Twilio API key SID', /\bSK[0-9a-f]{32}\b/],
  ['Twilio auth token assignment', /twilio[_-]?auth[_-]?token\s*[:=]\s*['"][0-9a-f]{32}['"]/i],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['generic password URL', /postgres(ql)?:\/\/[^:\s/]+:(?!owner_test_only|app_test_only|worker_test_only|postgres@|ci_only_password@|\$\{)[^@\s]{6,}@/],
];

export function scanText(text: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    .filter((f) => !f.startsWith('docs/reference/raw/') && !f.endsWith('pnpm-lock.yaml'));
  let findings = 0;
  for (const f of files) {
    let text: string;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const hit of scanText(text)) { console.error(`${f}: ${hit}`); findings++; }
  }
  if (findings) { console.error(`${findings} possible secret(s)`); process.exit(1); }
  console.log(`secret scan: ${files.length} files clean`);
}
