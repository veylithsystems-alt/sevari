/**
 * Tenant-local time without I/O: Intl provides the zone rules. Correct across UK clock changes,
 * where 01:00–02:00 is skipped in March and repeated in October (CONTRACT_REVIEW R-17).
 */
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
const WEEKDAYS: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface LocalParts {
  readonly date: string; // YYYY-MM-DD
  readonly time: string; // HH:MM
  readonly weekday: Weekday;
  readonly minutes: number; // minutes since local midnight
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localParts(epochMs: number, tz: string): LocalParts {
  const p = Object.fromEntries(fmt(tz).formatToParts(epochMs).map((x) => [x.type, x.value]));
  const weekday = (p['weekday'] ?? '').slice(0, 3).toLowerCase() as Weekday;
  const time = `${p['hour']}:${p['minute']}`;
  return { date: `${p['year']}-${p['month']}-${p['day']}`, time, weekday, minutes: Number(p['hour']) * 60 + Number(p['minute']) };
}

/** Offset (minutes east of UTC) of `tz` at `epochMs`. */
export function tzOffsetMinutes(epochMs: number, tz: string): number {
  const l = localParts(epochMs, tz);
  const asUtc = Date.UTC(Number(l.date.slice(0, 4)), Number(l.date.slice(5, 7)) - 1, Number(l.date.slice(8, 10)), Math.floor(l.minutes / 60), l.minutes % 60);
  return Math.round((asUtc - Math.floor(epochMs / 60_000) * 60_000) / 60_000);
}

/**
 * Epoch ms for a local wall-clock time. A time skipped by a clock change resolves to the first valid
 * instant after it; a repeated time resolves to its first occurrence. Both are deterministic.
 */
export function localToEpoch(date: string, hhmm: string, tz: string): number {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const candidates = [tzOffsetMinutes(naive - 12 * 3_600_000, tz), tzOffsetMinutes(naive + 12 * 3_600_000, tz)];
  const valid = candidates.map((off) => naive - off * 60_000).filter((t) => localParts(t, tz).date === date && localParts(t, tz).time === hhmm);
  if (valid.length) return Math.min(...valid);
  // Skipped time (spring forward): read it with the pre-change offset, which lands just after the gap
  // (01:30 GMT on the March change becomes 02:30 BST).
  return naive - Math.min(...candidates) * 60_000;
}

export function addDays(date: string, n: number): string {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? 'mon';
}
