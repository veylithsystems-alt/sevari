/**
 * Bookings in the deterministic core (§16.1 stages 3, 4 and 6). Pure functions only:
 *   - the one canonical way a booked slot is written, so templates, facts and checks agree;
 *   - matching a customer's reply ("Tuesday at 10 works", "the second one") against the exact windows
 *     they were offered. Only an offered window can become a booking, and only one clear match counts:
 *     anything ambiguous goes back as a question, never a guess.
 */
import { longDate } from './facts.ts';
import { extractSlots } from './slots.ts';
import { normaliseForMatch } from './text.ts';

export interface SlotTimes {
  /** Local date and times at the business (YYYY-MM-DD, HH:MM). */
  readonly date: string;
  readonly start: string;
  readonly end: string;
}

/** A booking the customer already has, as a fact the reply may state. */
export interface BookingFact extends SlotTimes {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly service?: string;
}

/** "Tuesday 20 October 2026, 10:00 to 12:00": the only wording a booked slot is ever written in. */
export const slotPhrase = (s: SlotTimes): string => `${longDate(s.date)}, ${s.start} to ${s.end}`;

export type ChoiceMatch =
  | { readonly kind: 'one'; readonly index: number }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly number[] }
  | { readonly kind: 'none' };

const ORDINALS: readonly [RegExp, (n: number) => number][] = [
  [/\b(first|1st|option (?:1|one)|number (?:1|one)|the earliest)\b/, () => 0],
  [/\b(second|2nd|option (?:2|two)|number (?:2|two))\b/, () => 1],
  [/\b(third|3rd|option (?:3|three)|number (?:3|three))\b/, () => 2],
  [/\b(last one|the last|the latest)\b/, (n) => n - 1],
];
const DECLINES = /\b(none of (?:those|them|these)|neither|(?:can'?t|cannot|can not) do (?:any|those|them)|(?:don'?t|doesn'?t|do not|does not) (?:work|suit)|not (?:any|those)|no good)\b/;
const AFFIRM = /\b(yes|yeah|yep|that works|works for me|suits me|perfect|great|book (?:it|me in)|go ahead|please do|sounds good|that'?s fine|fine by me)\b/;

/** A clock time in the message ("10am", "10:30", "2pm", "half 10", "midday") as HH:MM, or undefined. */
export function clockTimeIn(text: string): string | undefined {
  const h = text.toLowerCase();
  if (/\b(midday|noon)\b/.test(h)) return '12:00';
  const hm = /\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/.exec(h);
  const ap = /\b(\d{1,2})\s*(am|pm)\b/.exec(h);
  const half = /\bhalf (?:past )?(\d{1,2})\b/.exec(h);
  const at = /\b(?:at|for|from|around|about) (\d{1,2})\b(?![:.]\d)/.exec(h);
  let hour: number | undefined;
  let minute = 0;
  let suffix: string | undefined;
  if (hm) { hour = Number(hm[1]); minute = Number(hm[2]); suffix = hm[3]; }
  else if (ap) { hour = Number(ap[1]); suffix = ap[2]; }
  else if (half) { hour = Number(half[1]); minute = 30; }
  else if (at) hour = Number(at[1]);
  if (hour === undefined || hour > 23 || minute > 59) return undefined;
  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  // Without am/pm, "at 2" for a trade visit means 2pm (working hours), never 2am.
  if (!suffix && hour >= 1 && hour <= 7) hour += 12;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Which offered window, if exactly one, does this reply choose? */
export function matchOfferChoice(text: string, windows: readonly SlotTimes[], ctx: { nowMs: number; timezone: string }): ChoiceMatch {
  const h = normaliseForMatch(text);
  const raw = text.toLowerCase();
  if (!windows.length || DECLINES.test(raw)) return { kind: 'none' };
  for (const [re, idx] of ORDINALS) {
    if (re.test(raw)) {
      const i = idx(windows.length);
      return i >= 0 && i < windows.length ? { kind: 'one', index: i } : { kind: 'none' };
    }
  }
  const pt = extractSlots(text, ctx).preferredTime;
  const time = clockTimeIn(text);
  const part = pt?.partOfDay && pt.partOfDay !== 'any' ? pt.partOfDay : undefined;
  if (!pt?.date && !time && !part) {
    // "Yes please" to a single offered time is a clear choice; to several it is not.
    if (AFFIRM.test(raw) || AFFIRM.test(h)) return windows.length === 1 ? { kind: 'one', index: 0 } : { kind: 'ambiguous', candidates: windows.map((_, i) => i) };
    return { kind: 'none' };
  }
  const inPart = (start: string) => part === 'morning' ? start < '12:00' : part === 'afternoon' ? start >= '12:00' && start < '17:00' : start >= '17:00';
  const candidates = windows.map((w, i) => ({ w, i })).filter(({ w }) =>
    (!pt?.date || w.date === pt.date) && (!time || (w.start <= time && time < w.end)) && (!part || inPart(w.start))).map(({ i }) => i);
  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined) return { kind: 'one', index: only };
  return candidates.length ? { kind: 'ambiguous', candidates } : { kind: 'none' };
}
