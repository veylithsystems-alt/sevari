import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

const Hostname = z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/, 'lower-case hostname');

export const EgressHostSchema = z.object({
  host: Hostname,
  port: z.number().int().min(1).max(65535).default(443),
  /** Id of an approved entry in config/processors.yaml (§69). */
  processor: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  purpose: z.string().min(1),
  /** True only for in-cell infrastructure on a private network (processor role 'self'). */
  private_network: z.boolean().default(false),
});
export type EgressHost = z.infer<typeof EgressHostSchema>;

export const EgressPolicySchema = z.object({
  version: z.literal(1),
  default: z.literal('deny'),
  cells: z.record(z.string(), z.object({ hosts: z.array(EgressHostSchema) })),
}).superRefine((p, ctx) => {
  for (const [cell, { hosts }] of Object.entries(p.cells)) {
    const seen = new Set<string>();
    for (const h of hosts) {
      const key = `${h.host}:${h.port}`;
      if (seen.has(key)) ctx.addIssue({ code: 'custom', message: `cell ${cell}: duplicate host ${key}` });
      seen.add(key);
    }
  }
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
