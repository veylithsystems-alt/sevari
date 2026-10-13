import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

const Hostname = z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/, 'lower-case hostname');

export const EgressHostSchema = z.object({
  host: Hostname,
  port: z.number().int().min(1).max(65535).default(443),
  processor: z.string().min(1),
  /** 'self' for in-cell infrastructure Veylith runs itself (e.g. the inference box). */
  role: z.enum(['processor', 'sub_processor', 'self']),
  purpose: z.string().min(1),
  data_categories: z.array(z.string()).min(1),
  data_location: z.string().min(1),
  transfer_mechanism: z.string().min(1),
  adr: z.string().regex(/^docs\/adr\//),
  approved_by: z.string().min(1),
  approved_on: z.string().date(),
});
export type EgressHost = z.infer<typeof EgressHostSchema>;

export const EgressPolicySchema = z.object({
  version: z.literal(1),
  default: z.literal('deny'),
  cells: z.record(z.string(), z.object({ hosts: z.array(EgressHostSchema) })),
});
export type EgressPolicy = z.infer<typeof EgressPolicySchema>;

export async function loadEgressPolicy(path: string): Promise<EgressPolicy> {
  return EgressPolicySchema.parse(parse(await readFile(path, 'utf8')));
}

export function hostsForCell(policy: EgressPolicy, region: string): readonly EgressHost[] {
  const cell = policy.cells[region];
  if (!cell) throw new Error(`Egress policy has no entry for cell ${region}`);
  return cell.hosts;
}

/** Exact host match only. No wildcards: a wildcard would let a provider add hosts without an ADR. */
export function isAllowed(policy: EgressPolicy, region: string, host: string, port = 443): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return hostsForCell(policy, region).some((e) => e.host === h && e.port === port);
}
