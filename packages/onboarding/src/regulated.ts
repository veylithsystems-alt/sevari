/**
 * Regulated-activity detection (§83.4). Onboarding answers and service names are checked against the
 * maintained list (config/regulated-activities.yaml). A match marks the business regulated, so going live
 * needs Veylith's approval too (§81.5). Negated mentions ("we don't do gas work") don't count.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { hasAffirmed, normaliseForMatch } from '@sevari/domain';

const ListSchema = z.object({ version: z.literal(1), activities: z.array(z.object({ id: z.string(), why: z.string(), terms: z.array(z.string().min(2)).min(1) })) });
export type RegulatedList = z.infer<typeof ListSchema>;

let cached: RegulatedList | undefined;
export function regulatedList(path = resolve(import.meta.dirname, '..', '..', '..', 'config', 'regulated-activities.yaml')): RegulatedList {
  if (!cached) cached = ListSchema.parse(parse(readFileSync(path, 'utf8')));
  return cached;
}

export interface RegulatedFinding { readonly activity: string; readonly term: string; readonly why: string }

export function detectRegulated(texts: readonly string[], list: RegulatedList = regulatedList()): RegulatedFinding[] {
  const h = normaliseForMatch(texts.join('\n'));
  const out: RegulatedFinding[] = [];
  for (const a of list.activities) {
    const term = a.terms.find((t) => hasAffirmed(h, t));
    if (term) out.push({ activity: a.id, term, why: a.why });
  }
  return out;
}
