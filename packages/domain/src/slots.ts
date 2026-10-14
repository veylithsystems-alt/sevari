/** Slot extraction (§5.2): name, contact details, postcode, urgency, preferred time. Deterministic. */
import { normaliseEmail, normalisePhone, normalisePostcode } from './normalise.ts';
import { hasAffirmed, normaliseForMatch } from './text.ts';
import { addDays, localParts, type Weekday } from './time.ts';

export interface PreferredTime {
  readonly raw: string;
  readonly date?: string;
  readonly partOfDay?: 'morning' | 'afternoon' | 'evening' | 'any';
}

export interface Slots {
  readonly name?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly postcode?: string;
  readonly outwardCode?: string;
  readonly urgency: 'emergency' | 'soon' | 'flexible' | 'unspecified';
  readonly preferredTime?: PreferredTime;
}

const POSTCODE_FULL = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
const POSTCODE_OUTWARD = /\b([A-Z]{1,2}\d{1,2}[A-Z]?)\b/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(?:\+44\s?\(?0?\)?\s?|0)(?:\d[\s-]?){9,10}\b/;

const DAY_WORDS: Record<string, Weekday> = { monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri', saturday: 'sat', sunday: 'sun' };
const ORDER: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function extractSlots(text: string, ctx: { nowMs: number; timezone: string; fromName?: string }): Slots {
  const h = normaliseForMatch(text);
  const full = POSTCODE_FULL.exec(text);
  const postcode = full ? normalisePostcode(`${full[1]}${full[2]}`) ?? undefined : undefined;
  // Outward-only codes ("I'm in CH65") must look like a real outward code and be uppercase in the source.
  const outward = postcode?.split(' ')[0] ?? (() => {
    const m = /\b(?:in|at|near|postcode|area)\s+([A-Z]{1,2}\d{1,2}[A-Z]?)\b/.exec(text) ?? POSTCODE_OUTWARD.exec(text.replace(/[a-z]/g, ' '));
    return m?.[1] && /^[A-Z]{1,2}\d/.test(m[1]) ? m[1] : undefined;
  })();
  const email = EMAIL.exec(text)?.[0];
  const phoneRaw = PHONE.exec(text)?.[0];
  const phone = phoneRaw ? normalisePhone(phoneRaw) ?? undefined : undefined;

  const urgency: Slots['urgency'] =
    ['emergency', 'urgent', 'urgently', 'asap', 'as soon as possible', 'right now', 'immediately', 'tonight', 'flooding', 'locked out'].some((p) => hasAffirmed(h, p)) ? 'emergency'
      : ['today', 'tomorrow', 'this week', 'soon', 'quickly'].some((p) => hasAffirmed(h, p)) ? 'soon'
        : ['no rush', 'whenever', 'not urgent', 'next month', 'in the spring', 'in the summer', 'flexible'].some((p) => h.includes(normaliseForMatch(p))) ? 'flexible'
          : 'unspecified';

  const preferredTime = extractPreferredTime(h, ctx);
  const name = ctx.fromName?.trim() || extractName(text);
  return {
    ...(name ? { name } : {}), ...(email ? { email: normaliseEmail(email) } : {}), ...(phone ? { phone } : {}),
    ...(postcode ? { postcode } : {}), ...(outward ? { outwardCode: outward.toUpperCase() } : {}),
    urgency, ...(preferredTime ? { preferredTime } : {}),
  };
}

function extractName(text: string): string | undefined {
  const m = /\b(?:my name is|this is|i'm|i am)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\b/.exec(text)
    ?? /(?:^|\n)\s*(?:thanks|thank you|regards|cheers|many thanks|best),?\s*\n?\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*$/i.exec(text.trim());
  const n = m?.[1];
  return n && !/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Hi|Hello)$/.test(n) ? n : undefined;
}

function extractPreferredTime(h: string, ctx: { nowMs: number; timezone: string }): PreferredTime | undefined {
  const today = localParts(ctx.nowMs, ctx.timezone);
  const part: PreferredTime['partOfDay'] = /\bmorning\b/.test(h) ? 'morning' : /\bafternoon\b/.test(h) ? 'afternoon' : /\b(evening|tonight|after work)\b/.test(h) ? 'evening' : undefined;
  const withPart = (raw: string, date?: string): PreferredTime => ({ raw, ...(date ? { date } : {}), ...(part ? { partOfDay: part } : {}) });
  if (/\b(today|tonight)\b/.test(h)) return withPart('today', today.date);
  if (/\btomorrow\b/.test(h)) return withPart('tomorrow', addDays(today.date, 1));
  for (const [word, wd] of Object.entries(DAY_WORDS)) {
    const m = new RegExp(`\\b(next |this )?${word}\\b`).exec(h);
    if (m) {
      let delta = (ORDER.indexOf(wd) - ORDER.indexOf(today.weekday) + 7) % 7;
      if (delta === 0) delta = 7;
      if (m[1] === 'next ' && delta < 7) delta += 7;
      return withPart(m[0].trim(), addDays(today.date, delta));
    }
  }
  const dm = /\b(\d{1,2})(?:st|nd|rd|th)?(?: of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/.exec(h);
  if (dm) {
    const day = Number(dm[1]);
    const month = MONTHS.indexOf((dm[2] ?? '').slice(0, 3)) + 1;
    let year = Number(today.date.slice(0, 4));
    const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (candidate < today.date) year += 1;
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && day >= 1 && day <= 31) return withPart(dm[0].trim(), date);
  }
  if (/\bnext week\b/.test(h)) return withPart('next week');
  if (/\bthis week\b/.test(h)) return withPart('this week');
  if (part) return { raw: part, partOfDay: part };
  return undefined;
}
