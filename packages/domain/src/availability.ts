/**
 * Deterministic availability (§5.2): candidate appointment windows from the owner's hours, minus
 * existing bookings, from a lead time onward. A proposal is never a booking (booking needs §7).
 */
import type { KnowledgeSnapshot } from './knowledge.ts';
import { addDays, localParts, localToEpoch, weekdayOf } from './time.ts';

export interface Busy { readonly startMs: number; readonly endMs: number }
export interface Window { readonly startMs: number; readonly endMs: number; readonly date: string; readonly start: string; readonly end: string }

export function proposeWindows(k: KnowledgeSnapshot, opts: {
  nowMs: number; busy: readonly Busy[]; durationMinutes?: number; leadMinutes?: number; count?: number; horizonDays?: number;
  preferredDate?: string; partOfDay?: 'morning' | 'afternoon' | 'evening' | 'any';
}): { windows: Window[]; factsUsed: string[]; missing: string[] } {
  if (!k.hours) return { windows: [], factsUsed: [], missing: ['knowledge:hours'] };
  const tz = k.hours.body.timezone;
  const dur = opts.durationMinutes ?? 120;
  const earliest = opts.nowMs + (opts.leadMinutes ?? 120) * 60_000;
  const want = opts.count ?? 3;
  const out: Window[] = [];
  const today = localParts(opts.nowMs, tz).date;
  const inPart = (start: string) => {
    const p = opts.partOfDay;
    if (!p || p === 'any') return true;
    return p === 'morning' ? start < '12:00' : p === 'afternoon' ? start >= '12:00' && start < '17:00' : start >= '17:00';
  };
  const dates = opts.preferredDate ? [opts.preferredDate, ...range(today, opts.horizonDays ?? 14)] : range(today, opts.horizonDays ?? 14);
  const seen = new Set<string>();
  for (const date of dates) {
    if (out.length >= want || seen.has(date)) continue;
    seen.add(date);
    if (k.hours.body.closed_dates.includes(date)) continue;
    for (const w of k.hours.body.weekly[weekdayOf(date)] ?? []) {
      for (let t = toMin(w.start); t + dur <= toMin(w.end); t += dur) {
        const start = fromMin(t);
        const end = fromMin(t + dur);
        if (!inPart(start)) continue;
        const startMs = localToEpoch(date, start, tz);
        const endMs = localToEpoch(date, end, tz);
        if (startMs < earliest) continue;
        if (opts.busy.some((b) => b.startMs < endMs && startMs < b.endMs)) continue;
        out.push({ startMs, endMs, date, start, end });
        if (out.length >= want) break;
      }
      if (out.length >= want) break;
    }
  }
  return { windows: out, factsUsed: [`${k.hours.id}@${k.hours.version}`], missing: out.length ? [] : ['availability'] };
}

const range = (from: string, days: number) => Array.from({ length: days }, (_, i) => addDays(from, i));
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
