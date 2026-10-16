import { currentRoleFacts, lintSchema, migrationState, piiColumns, tableSecurity, type Db } from '@sevari/db';
import type { Kms } from '@sevari/crypto';
import { crossCheck, hostsForCell, loadEgressPolicy, loadProcessorRegistry } from '@sevari/egress';
import { join } from 'node:path';
import type { Clock } from '@sevari/clock';
import { registryGaps } from '@sevari/privacy';
import { verifySignoff } from '@sevari/identity';
import { loadRegionConfig } from '@sevari/region';

export interface BootCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface BootReport {
  readonly ok: boolean;
  readonly checks: readonly BootCheck[];
}

export interface BootDeps {
  /** Connected as the application role, the same one the service will use. */
  readonly db: Db;
  readonly kms: Kms;
  readonly region: string;
  readonly configDir: string;
  readonly egressPolicyPath: string;
  readonly migrationsDir?: string;
  readonly clock: Clock;
}

async function check(name: string, fn: () => Promise<string>): Promise<BootCheck> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message };
  }
}

/** INV-9: every check runs, none short-circuits, so the report lists every reason to refuse. */
export async function runBootChecks(deps: BootDeps): Promise<BootReport> {
  const tables = await tableSecurity(deps.db).catch(() => null);
  const checks = await Promise.all([
    check('db.role', async () => {
      const r = await currentRoleFacts(deps.db);
      const problems = [
        r.superuser && 'role is superuser',
        r.bypassRls && 'role has BYPASSRLS',
        r.ownsTables > 0 && `role owns ${r.ownsTables} table(s)`,
      ].filter(Boolean);
      if (problems.length) throw new Error(`${r.user}: ${problems.join(', ')}`);
      return `${r.user}: NOSUPERUSER, NOBYPASSRLS, owns no tables`;
    }),
    check('db.rls', async () => {
      if (!tables) throw new Error('cannot read schema');
      const problems = lintSchema(tables);
      if (problems.length) throw new Error(problems.join('; '));
      return `${tables.length} tables: RLS enabled and forced, tenancy columns present`;
    }),
    check('db.migrations', async () => {
      const s = await migrationState(deps.db, deps.migrationsDir);
      if (!s.current) throw new Error(`pending=${s.pending.join(',') || '-'} tampered=${s.tampered.join(',') || '-'} unknown=${s.unknown.join(',') || '-'}`);
      return 'all migrations applied, checksums match';
    }),
    check('kms', async () => {
      await deps.kms.healthCheck();
      return `KMS ${deps.kms.kekId} round-trip ok`;
    }),
    check('egress.policy', async () => {
      const policy = await loadEgressPolicy(deps.egressPolicyPath);
      const hosts = hostsForCell(policy, deps.region);
      const registry = await loadProcessorRegistry(join(deps.configDir, 'processors.yaml'));
      const problems = crossCheck(policy, registry, deps.clock.now().toISOString().slice(0, 10));
      if (problems.length) throw new Error(problems.join('; '));
      return `default deny; ${hosts.length} allowlisted host(s) for ${deps.region}, all mapped to approved processors`;
    }),
    check('region.config', async () => {
      const cfg = await loadRegionConfig(deps.configDir, deps.region);
      return `${cfg.code}: counsel_signoff ${cfg.counsel_signoff ? 'recorded' : 'NULL (no live tenants)'}`;
    }),
    check('signoffs', async () => {
      // §71: a sign-off in configuration must be backed by approval records (counsel and founder, unexpired).
      const cfg = await loadRegionConfig(deps.configDir, deps.region);
      if (!cfg.counsel_signoff) return `${cfg.code}: no sign-off claimed`;
      const today = deps.clock.now().toISOString().slice(0, 10);
      const problems: string[] = [];
      for (const scope of cfg.counsel_signoff.scope) {
        const v = await verifySignoff(deps.db, `region:${cfg.code}:${scope}`, today);
        if (!v.ok) problems.push(v.reason);
      }
      if (problems.length) throw new Error(`configuration claims a sign-off that the records don't support: ${problems.join('; ')}`);
      return `${cfg.code}: ${cfg.counsel_signoff.scope.length} sign-off scope(s) backed by approval records`;
    }),
    check('registry.erasure', async () => {
      if (!tables) throw new Error('cannot read schema');
      const gaps = registryGaps(piiColumns(tables), tables.map((t) => t.table));
      if (gaps.length) throw new Error(gaps.join('; '));
      return 'every table and @pii column is in the erasure registry';
    }),
  ]);
  return { ok: checks.every((c) => c.ok), checks };
}

export class BootRefused extends Error {
  readonly report: BootReport;
  constructor(report: BootReport) {
    super('Refusing to start (INV-9): ' + report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(' | '));
    this.name = 'BootRefused';
    this.report = report;
  }
}

export async function assertBoot(deps: BootDeps): Promise<BootReport> {
  const report = await runBootChecks(deps);
  if (!report.ok) throw new BootRefused(report);
  return report;
}
