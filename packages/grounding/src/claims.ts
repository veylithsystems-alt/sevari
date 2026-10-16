/**
 * Claim extraction (§5.3, F3). The same extractor runs on the draft, on the authorised facts and on the
 * customer's own message, so every comparison happens in one normalised form:
 *   money -> minor units, dates -> ISO, times -> HH:MM, phones -> E.164, emails/hosts -> lower case.
 */
import { addDays, localParts, normaliseEmail, normalisePhone, normalisePostcode, type Weekday } from '@sevari/domain';

export type ClaimKind = 'money' | 'percent' | 'date' | 'time' | 'phone' | 'email' | 'host' | 'postcode' | 'number';

export interface Claim {
  readonly kind: ClaimKind;
  /** Normalised value used for comparison. */
  readonly value: string;
  /** Exact text in the source. */
  readonly raw: string;
}

export interface ExtractContext {
  readonly nowMs: number;
  readonly timezone: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS: Record<string, Weekday> = { monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri', saturday: 'sat', sunday: 'sun' };
const ORDER: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const pad = (n: number) => String(n).padStart(2, '0');

/** Every claim in `text`. Overlapping spans are claimed once (most specific first). */
export function extractClaims(text: string, ctx: ExtractContext): Claim[] {
  const out: Claim[] = [];
  const taken: Array<[number, number]> = [];
  const free = (s: number, e: number) => !taken.some(([a, b]) => s < b && a < e);
  const take = (re: RegExp, fn: (m: RegExpExecArray) => Claim | Claim[] | null) => {
    for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
      const s = m.index ?? 0;
      const e = s + m[0].length;
      if (!free(s, e)) continue;
      const c = fn(m as RegExpExecArray);
      if (!c) continue;
      taken.push([s, e]);
      out.push(...(Array.isArray(c) ? c : [c]));
    }
  };
  const today = localParts(ctx.nowMs, ctx.timezone);

  take(/https?:\/\/[^\s)>\]]+/i, (m) => {
    try {
      return { kind: 'host', value: new URL(m[0]).hostname.toLowerCase(), raw: m[0] };
    } catch {
      return { kind: 'host', value: m[0].toLowerCase(), raw: m[0] };
    }
  });
  take(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, (m) => ({ kind: 'email', value: normaliseEmail(m[0]), raw: m[0] }));
  take(/\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:co\.uk|org\.uk|uk|com|net|org|io)\b/i, (m) => ({ kind: 'host', value: m[0].toLowerCase().replace(/^www\./, ''), raw: m[0] }));
  take(/(?:\+44\s?\(?0?\)?\s?|\b0)(?:\d[\s-]?){9,10}\b/, (m) => {
    const p = normalisePhone(m[0]);
    return p ? { kind: 'phone', value: p, raw: m[0] } : null;
  });
  take(/\b([A-Z]{1,2}\d[A-Z\d]?)\s?(\d[A-Z]{2})\b/i, (m) => {
    const pc = normalisePostcode(`${m[1]}${m[2]}`);
    return pc ? { kind: 'postcode', value: pc, raw: m[0] } : null;
  });
  take(/£\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\b|\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?\s?(?:pounds|quid|gbp)\b/i, (m) => {
    const whole = (m[1] ?? m[3] ?? '0').replace(/,/g, '');
    const frac = (m[2] ?? m[4] ?? '').padEnd(2, '0');
    // A price is bound to its basis: "£60 an hour" is not "£60 for the job" (§68 misleading combinations).
    const start = m.index ?? 0;
    const before = text.slice(Math.max(0, start - 12), start).toLowerCase();
    const after = text.slice(start + m[0].length, start + m[0].length + 24).toLowerCase();
    const basis = /^\s*(an hour|a hour|per hour|\/\s?h(ou)?r|hourly|ph\b)/.test(after) ? 'hourly'
      : /^\s*(per|a|each)\s(panel|metre|meter|m2|sq|square|item|door|window|lock|tile|day)/.test(after) ? 'per_unit'
        : /(from|starting at|starts at)\s*$/.test(before) ? 'from'
          : 'flat';
    return { kind: 'money', value: `${Number(whole) * 100 + Number(frac || '0')}:${basis}`, raw: m[0] };
  });
  take(/\b(\d{1,3}(?:\.\d+)?)\s?(?:%|per ?cent)/i, (m) => ({ kind: 'percent', value: String(Number(m[1])), raw: m[0] }));
  // Dates: 14th October (2026), 14 Oct, 14/10(/2026), weekday names, today, tomorrow.
  take(/\b(\d{1,2})(?:st|nd|rd|th)?\s(?:of\s)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s(\d{4}))?\b/i, (m) => {
    const month = MONTHS.indexOf((m[2] ?? '').slice(0, 3).toLowerCase()) + 1;
    let year = m[3] ? Number(m[3]) : Number(today.date.slice(0, 4));
    if (!m[3] && `${year}-${pad(month)}-${pad(Number(m[1]))}` < today.date) year += 1;
    return { kind: 'date', value: `${year}-${pad(month)}-${pad(Number(m[1]))}`, raw: m[0] };
  });
  take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (m) => {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : Number(today.date.slice(0, 4));
    return { kind: 'date', value: `${y}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`, raw: m[0] };
  });
  take(/\b(?:(next|this)\s)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, (m) => {
    const wd = DAYS[(m[2] ?? '').toLowerCase()] ?? 'mon';
    let delta = (ORDER.indexOf(wd) - ORDER.indexOf(today.weekday) + 7) % 7;
    if (delta === 0 && (m[1] ?? '').toLowerCase() !== 'this') delta = 7;
    if ((m[1] ?? '').toLowerCase() === 'next' && delta < 7) delta += 7;
    return { kind: 'date', value: addDays(today.date, delta), raw: m[0] };
  });
  take(/\b(today|tonight|tomorrow)\b/i, (m) => ({ kind: 'date', value: addDays(today.date, m[1]?.toLowerCase() === 'tomorrow' ? 1 : 0), raw: m[0] }));
  // Times: 2pm, 2:30 pm, 14:00, noon, midday.
  take(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/i, (m) => {
    let h = Number(m[1]) % 12;
    if ((m[3] ?? '').toLowerCase() === 'pm') h += 12;
    return { kind: 'time', value: `${pad(h)}:${m[2] ?? '00'}`, raw: m[0] };
  });
  take(/\b([01]?\d|2[0-3]):([0-5]\d)\b/, (m) => ({ kind: 'time', value: `${pad(Number(m[1]))}:${m[2]}`, raw: m[0] }));
  take(/\b(noon|midday)\b/i, (m) => ({ kind: 'time', value: '12:00', raw: m[0] }));
  // Any remaining number is a claim too ("2 engineers", "within 4 hours", "10 year guarantee").
  take(/\b\d+(?:\.\d+)?\b/, (m) => ({ kind: 'number', value: String(Number(m[0])), raw: m[0] }));
  return out;
}

export const claimKey = (c: Pick<Claim, 'kind' | 'value'>) => `${c.kind}:${c.value}`;
