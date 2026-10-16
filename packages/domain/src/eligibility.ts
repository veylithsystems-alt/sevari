/**
 * Deterministic eligibility (§5.2): service offered, service area, hours. Eligibility informs the owner;
 * it never refuses anyone automatically (§17.2, Art. 22 caution, §71).
 */
import type { KnowledgeSnapshot } from './knowledge.ts';
import { localParts, type Weekday } from './time.ts';

export type Tri = 'yes' | 'no' | 'unknown';

export interface Eligibility {
  readonly service: Tri;
  readonly area: Tri;
  readonly openNow: Tri;
  readonly emergencyCover: Tri;
  readonly overall: Tri;
  readonly reasons: readonly string[];
  readonly factsUsed: readonly string[];
  readonly missing: readonly string[];
}

export function assessEligibility(k: KnowledgeSnapshot, input: { serviceCodes: readonly string[]; outwardCode?: string; nowMs: number; wantsEmergency: boolean }): Eligibility {
  const reasons: string[] = [];
  const factsUsed: string[] = [];
  const missing: string[] = [];

  let service: Tri = 'unknown';
  if (input.serviceCodes.length === 0) {
    missing.push('service');
  } else {
    const recs = input.serviceCodes.map((c) => k.services.find((s) => s.body.code === c)).filter((x) => x !== undefined);
    if (recs.length === 0) missing.push('knowledge:service');
    for (const r of recs) factsUsed.push(`${r.id}@${r.version}`);
    service = recs.some((r) => r.body.offered) ? 'yes' : recs.length ? 'no' : 'unknown';
    if (service === 'no') reasons.push('service not offered');
  }

  let area: Tri = 'unknown';
  if (!input.outwardCode) {
    missing.push('postcode');
  } else if (k.areas.length === 0) {
    missing.push('knowledge:area');
  } else {
    const oc = input.outwardCode.toUpperCase();
    const pa = /^[A-Z]{1,2}/.exec(oc)?.[0] ?? '';
    const hit = k.areas.find((a) => a.body.outward_codes.includes(oc) || a.body.postcode_areas.includes(pa));
    area = hit ? 'yes' : 'no';
    for (const a of k.areas) factsUsed.push(`${a.id}@${a.version}`);
    if (area === 'no') reasons.push(`postcode district ${oc} outside the recorded service area`);
  }

  let openNow: Tri = 'unknown';
  let emergencyCover: Tri = 'unknown';
  if (!k.hours) {
    missing.push('knowledge:hours');
  } else {
    factsUsed.push(`${k.hours.id}@${k.hours.version}`);
    const lp = localParts(input.nowMs, k.hours.body.timezone);
    const inWindows = (ws: readonly { start: string; end: string }[] | undefined) => (ws ?? []).some((w) => lp.time >= w.start && lp.time < w.end);
    const closedToday = k.hours.body.closed_dates.includes(lp.date);
    openNow = !closedToday && inWindows(k.hours.body.weekly[lp.weekday as Weekday]) ? 'yes' : 'no';
    const e = k.hours.body.emergency;
    emergencyCover = !e.available ? 'no' : e.always || inWindows(e.windows[lp.weekday as Weekday]) ? 'yes' : 'no';
    if (input.wantsEmergency && emergencyCover === 'no') reasons.push('no emergency cover at this time');
  }

  const parts: Tri[] = [service, area];
  const overall: Tri = parts.includes('no') ? 'no' : parts.every((p) => p === 'yes') ? 'yes' : 'unknown';
  return { service, area, openNow, emergencyCover, overall, reasons, factsUsed, missing };
}
