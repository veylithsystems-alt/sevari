import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { ContractViolation, RegionCodeSchema, type RegionCode } from '@sevari/domain';

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const CounselSignoff = z.object({
  signed_by: z.string().min(1),
  signed_on: z.string().date(),
  scope: z.array(z.string().min(1)).min(1),
  reference: z.string().min(1),
});

export const RegionConfigSchema = z.object({
  code: RegionCodeSchema,
  name: z.string().min(1),
  jurisdiction: z.string().length(2),
  timezone: z.string().min(1),
  currency: z.string().length(3),
  counsel_signoff: CounselSignoff.nullable(),
  signoff_expires_on: z.string().date().nullable(),
  messaging: z.object({ sending_window: z.object({ start: Hhmm, end: Hhmm }) }),
  outbound_rules: z.object({
    tiers_enabled: z.array(z.enum(['A', 'B', 'C', 'D', 'E', 'F'])),
    treat_as_individual: z.array(z.string()),
    preference_registers: z.array(z.string()),
  }),
  retention_days: z.record(z.string(), z.number().int().positive()),
}).superRefine((r, ctx) => {
  // D3 and §17.1: tier F is disabled in code; it can never be enabled by config.
  if (r.outbound_rules.tiers_enabled.includes('F')) ctx.addIssue({ code: 'custom', message: 'Tier F (purchased lists) is disabled in code (§17.1)' });
  // Tiers C-E need counsel sign-off in this region pack.
  const gated = r.outbound_rules.tiers_enabled.filter((t) => t === 'C' || t === 'D' || t === 'E');
  if (gated.length && !r.counsel_signoff) ctx.addIssue({ code: 'custom', message: `Tiers ${gated.join(',')} need counsel_signoff (§17.1)` });
  if (r.counsel_signoff && !r.signoff_expires_on) ctx.addIssue({ code: 'custom', message: 'A counsel sign-off needs an expiry date (§36.4)' });
});
export type RegionConfig = z.infer<typeof RegionConfigSchema>;

export async function loadRegionConfig(configDir: string, code: string): Promise<RegionConfig> {
  const region = RegionCodeSchema.parse(code);
  const raw = parse(await readFile(join(configDir, 'regions', `${region}.yaml`), 'utf8')) as unknown;
  const cfg = RegionConfigSchema.parse(raw);
  if (cfg.code !== region) throw new Error(`Region file ${region}.yaml declares code ${cfg.code}`);
  return cfg;
}

/** §8.4 and §36.4: live tenants only with a current counsel sign-off. `today` is YYYY-MM-DD from the Clock. */
export function liveTenantStatus(cfg: RegionConfig, today: string): { allowed: true } | { allowed: false; reason: string } {
  if (!cfg.counsel_signoff) return { allowed: false, reason: `region ${cfg.code}: counsel_signoff is null (§8.4)` };
  if (!cfg.signoff_expires_on || cfg.signoff_expires_on <= today) {
    return { allowed: false, reason: `region ${cfg.code}: counsel sign-off expired on ${cfg.signoff_expires_on} (§36.4)` };
  }
  return { allowed: true };
}

export function assertAcceptsLiveTenants(cfg: RegionConfig, today: string): void {
  const s = liveTenantStatus(cfg, today);
  if (!s.allowed) throw new ContractViolation('§8.4', s.reason);
}

/** The cell this process serves. A request for a tenant homed elsewhere gets a redirect, never a proxy (§5.1). */
export interface CellIdentity {
  readonly region: RegionCode;
}

export function routeForTenant(cell: CellIdentity, tenantHome: RegionCode, cellUrls: Readonly<Record<string, string>>):
  { kind: 'local' } | { kind: 'redirect'; location: string } {
  if (tenantHome === cell.region) return { kind: 'local' };
  const location = cellUrls[tenantHome];
  if (!location) throw new ContractViolation('§5.1', `no cell URL configured for region ${tenantHome}`);
  return { kind: 'redirect', location };
}

/** Service levels for a deployment (Part J §70). Null until Dan approves; then all must be set. */
export const SloConfigSchema = z.object({
  version: z.literal(1),
  availability_target_percent: z.number().min(90).max(100).nullable(),
  rto_minutes: z.number().int().positive().nullable(),
  rpo_minutes: z.number().int().nonnegative().nullable(),
  backup_frequency_hours: z.number().int().positive().nullable(),
  restore_acceptance: z.string().min(5).nullable(),
  ack_target_p95_ms: z.number().int().positive(),
}).superRefine((c, ctx) => {
  const vals = [c.availability_target_percent, c.rto_minutes, c.rpo_minutes, c.backup_frequency_hours, c.restore_acceptance];
  if (vals.some((v) => v !== null) && vals.some((v) => v === null)) ctx.addIssue({ code: 'custom', message: 'service levels are approved as a set: fill in all of them, or none' });
  if (c.backup_frequency_hours !== null && c.rpo_minutes !== null && c.backup_frequency_hours * 60 > c.rpo_minutes) {
    ctx.addIssue({ code: 'custom', message: 'the recovery point (RPO) can\'t be shorter than the backup interval without continuous log shipping' });
  }
});
export type SloConfig = z.infer<typeof SloConfigSchema>;

export async function loadSloConfig(configDir: string): Promise<SloConfig> {
  return SloConfigSchema.parse(parse(await readFile(join(configDir, 'slo.yaml'), 'utf8')) as unknown);
}

export const sloApproved = (c: SloConfig): boolean => c.availability_target_percent !== null;

/**
 * The service levels Dan chose on 21 October 2026 (Q-20, "recommended set"). They only take effect when
 * Dan's founder credential records the approval on the cell (scripts/approve-slo.ts): the values and the
 * record are written together, never one without the other.
 */
export const APPROVED_SLO_2026_10_21 = Object.freeze({
  availability_target_percent: 99.5,
  rto_minutes: 240,
  rpo_minutes: 1440,
  backup_frequency_hours: 24,
  restore_acceptance: 'monthly restore drill passes, with erasures re-applied from the shred register',
});

/** Writes approved service levels into slo.yaml, keeping comments and the ACK target. */
export function withServiceLevels(yamlText: string, v: typeof APPROVED_SLO_2026_10_21): string {
  let out = yamlText;
  for (const [k, val] of Object.entries(v)) {
    const re = new RegExp(`^(${k}:\\s*)(?:null|[^#\\n]*?)(\\s*(#.*)?)$`, 'm');
    if (!re.test(out)) throw new Error(`slo.yaml has no ${k} line`);
    out = out.replace(re, (_m, a: string, b: string) => `${a}${typeof val === 'string' ? JSON.stringify(val) : String(val)}${b}`);
  }
  SloConfigSchema.parse(parse(out) as unknown);
  return out;
}
