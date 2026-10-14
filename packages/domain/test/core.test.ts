import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  analyseEnquiry, canonicalJson, classifyIntent, formatMoney, hasAffirmed, localParts, localToEpoch, matchesKeyword, money,
  normaliseEmail, normaliseForMatch, normalisePhone, normalisePostcode, parseKnowledge, priceFor, proposeWindows, sensitiveFlags,
  snapshotFrom, stemTokens, tzOffsetMinutes, type KnowledgeFact, type AnyKnowledge,
} from '@sevari/domain';
import { drainage, landscaping } from '@sevari/verticals';
import { KNOWLEDGE } from '../../../eval/fixtures/knowledge.ts';

const TZ = 'Europe/London';
const WED_10AM = Date.parse('2026-10-14T09:00:00Z');

describe('text matching', () => {
  it('matches whole words only (reference defect D-4)', () => {
    expect(hasAffirmed(normaliseForMatch('the wheat field'), 'heat')).toBe(false);
    expect(hasAffirmed(normaliseForMatch('no heat in the house'), 'heat')).toBe(false); // negated
    expect(hasAffirmed(normaliseForMatch('we have no hot water but heat works'), 'heat')).toBe(true);
    expect(hasAffirmed(normaliseForMatch('Bleak outlook'), 'leak')).toBe(false);
  });
  it('matches word forms and nearby words', () => {
    expect(matchesKeyword(stemTokens('want all the locks changed'), 'change the locks')).toBe(true);
    expect(matchesKeyword(stemTokens('the drains are blocked'), 'blocked drain')).toBe(true);
    expect(matchesKeyword(stemTokens('change of plan, lock it'), 'change the locks')).toBe(true); // window match is by design
    expect(matchesKeyword(stemTokens('a lock'), 'change the locks')).toBe(false);
  });
});

describe('normalisers (property-based)', () => {
  it('UK mobiles normalise to one E.164 form however they are written', () => {
    fc.assert(fc.property(fc.stringMatching(/^7\d{9}$/), (rest) => {
      const e164 = `+44${rest}`;
      for (const v of [`0${rest}`, `+44${rest}`, `0044 ${rest}`, `+44 (0)${rest}`, `0${rest.slice(0, 4)} ${rest.slice(4)}`]) expect(normalisePhone(v)).toBe(e164);
    }));
  });
  it('postcodes normalise to OUTWARD INWARD', () => {
    expect(normalisePostcode('ch652ab')).toBe('CH65 2AB');
    expect(normalisePostcode('CH65  2AB')).toBe('CH65 2AB');
    expect(normalisePostcode('not a postcode')).toBeNull();
  });
  it('emails are case- and space-insensitive', () => expect(normaliseEmail('  Jo.Bloggs@Example.COM ')).toBe('jo.bloggs@example.com'));
  it('canonical JSON is key-order independent', () => {
    fc.assert(fc.property(fc.dictionary(fc.string(), fc.oneof(fc.integer(), fc.string(), fc.boolean())), (o) => {
      const reversed = Object.fromEntries(Object.entries(o).reverse());
      expect(canonicalJson(reversed)).toBe(canonicalJson(o));
    }));
  });
});

describe('money', () => {
  it('formats minor units deterministically', () => {
    expect(formatMoney(money(9500))).toBe('£95');
    expect(formatMoney(money(123456))).toBe('£1,234.56');
    expect(formatMoney(money(5))).toBe('£0.05');
  });
  it('refuses fractional or negative minor units', () => {
    expect(() => money(1.5)).toThrow();
    expect(() => money(-1)).toThrow();
  });
});

describe('time zones and UK clock changes (CONTRACT_REVIEW R-17)', () => {
  it('knows BST and GMT', () => {
    expect(tzOffsetMinutes(Date.parse('2026-07-01T12:00:00Z'), TZ)).toBe(60);
    expect(tzOffsetMinutes(Date.parse('2026-12-01T12:00:00Z'), TZ)).toBe(0);
  });
  it('a skipped local time (spring forward) resolves to the next valid instant', () => {
    // 29 March 2026: 01:00 GMT jumps to 02:00 BST, so 01:30 local does not exist.
    const t = localToEpoch('2026-03-29', '01:30', TZ);
    expect(new Date(t).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(localParts(t, TZ).time).toBe('02:30');
  });
  it('a repeated local time (fall back) resolves to its first occurrence', () => {
    // 25 October 2026: 01:30 local happens twice; the first is BST (00:30Z).
    expect(new Date(localToEpoch('2026-10-25', '01:30', TZ)).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });
  it('round-trips every quarter hour of a clock-change day', () => {
    for (let m = 0; m < 24 * 60; m += 15) {
      const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const t = localToEpoch('2026-10-25', hhmm, TZ);
      expect(localParts(t, TZ).date).toBe('2026-10-25');
    }
  });
});

describe('pricing never invents (§42, INV-5 groundwork)', () => {
  it('returns only what the records say, including price on inspection', () => {
    const k = KNOWLEDGE['drainage']!;
    expect(priceFor(k, 'blocked_drain')).toMatchObject({ kind: 'known', statement: '£95 including VAT (first hour, then £60 an hour)' });
    expect(priceFor(k, 'drain_repair')).toMatchObject({ kind: 'known', statement: 'priced on inspection' });
    expect(priceFor(k, 'jetting')).toEqual({ kind: 'unknown', serviceCode: 'jetting', missing: 'knowledge:price:jetting' });
    expect(priceFor(k, null)).toMatchObject({ kind: 'unknown', missing: 'service' });
  });
  it('the price statement only ever contains amounts present in the records', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.constantFrom('fixed', 'from', 'per_hour', 'call_out'), (amount, basis) => {
      const fact: KnowledgeFact<AnyKnowledge> = { id: 'p1', version: 1, body: parseKnowledge({ kind: 'price', service_code: 'x_job', basis, amount_minor: amount, vat: 'inclusive' }) };
      const ans = priceFor(snapshotFrom([fact]), 'x_job');
      expect(ans.kind).toBe('known');
      const amounts = [...(ans.kind === 'known' ? ans.statement : '').matchAll(/£([\d,]+(?:\.\d{2})?)/g)].map((m) => m[1]);
      expect(amounts).toEqual([formatMoney(money(amount)).slice(1)]);
    }));
  });
  it('rejects malformed price records', () => {
    expect(() => parseKnowledge({ kind: 'price', service_code: 'x_job', basis: 'fixed', vat: 'inclusive' })).toThrow();
    expect(() => parseKnowledge({ kind: 'price', service_code: 'x_job', basis: 'on_inspection', amount_minor: 100, vat: 'inclusive' })).toThrow();
  });
});

describe('availability', () => {
  it('proposes windows inside opening hours, after the lead time, avoiding bookings', () => {
    const k = KNOWLEDGE['drainage']!;
    const busy = [{ startMs: Date.parse('2026-10-14T12:00:00Z'), endMs: Date.parse('2026-10-14T14:00:00Z') }];
    const { windows } = proposeWindows(k, { nowMs: WED_10AM, busy, count: 3 });
    // 12:00 and 14:00 local overlap the 13:00–15:00 booking; 16:00 is the first free window today.
    expect(windows.map((w) => `${w.date} ${w.start}`)).toEqual(['2026-10-14 16:00', '2026-10-15 08:00', '2026-10-15 10:00']);
  });
  it('honours a preferred day and part of day', () => {
    const k = KNOWLEDGE['landscaping']!;
    const { windows } = proposeWindows(k, { nowMs: WED_10AM, busy: [], preferredDate: '2026-10-17', partOfDay: 'afternoon', count: 2 });
    expect(windows.map((w) => `${w.date} ${w.start}`)).toEqual(['2026-10-17 12:00', '2026-10-17 14:00']);
  });
});

describe('analysis routes', () => {
  const run = (text: string, pack = drainage, k = KNOWLEDGE['drainage']!, extra = {}) =>
    analyseEnquiry({ text, nowMs: WED_10AM, timezone: TZ, pack, knowledge: k, ...extra });
  it('risk to life is caught even when negated (recall first) and routes to safety', () => {
    expect(run('No smell of gas but the boiler is making a noise').route).toBe('safety_first');
    expect(run('There is water dripping onto the light fitting').route).toBe('safety_first');
  });
  it('legal threats, data rights and STOP never take the automatic path', () => {
    expect(run('I will be taking legal action').route).toBe('human_only');
    expect(run('Please send me a subject access request copy').route).toBe('human_only');
    expect(run('STOP').route).toBe('opt_out');
  });
  it('asks for the missing detail, then stops asking (never proceeds on a guess: D-5, INV-14)', () => {
    const a = run('Blocked drain, can you come?');
    expect(a.route).toBe('clarify');
    expect(a.clarify?.about).toBe('postcode');
    const b = run('Blocked drain, can you come?', drainage, KNOWLEDGE['drainage']!, { clarificationsSoFar: 2 });
    expect(b.route).toBe('unknown');
    expect(b.factsMissing).toContain('clarification_exhausted:postcode');
  });
  it('a price the records do not hold is UNKNOWN, not guessed (§5.4)', () => {
    const a = run('How much is drain jetting?');
    expect(a.route).toBe('unknown');
    expect(a.factsMissing).toContain('knowledge:price:jetting');
  });
  it('out-of-area enquiries are answered with the fact, never auto-refused', () => {
    const a = run('Blocked drain, can you come? L8 4TQ');
    expect(a.eligibility.area).toBe('no');
    expect(a.route).toBe('answer');
  });
  it('every answer cites the knowledge records it relies on', () => {
    const a = run('Can you come and unblock my drain? CH65 2AB');
    expect(a.route).toBe('answer');
    expect(a.factsUsed.length).toBeGreaterThan(0);
    for (const f of a.factsUsed) expect(f).toMatch(/^kb-drainage-\d+@1$/);
  });
  it('is deterministic: the same enquiry with different names and formats gets the same intent (§32 invariance)', () => {
    const variants = ['Hi, I am Jo. Quote for a new patio please, CH65 2AB', 'hello this is Priya!! quote for a NEW PATIO please - ch65 2ab', "Quote for a new patio please. CH652AB. Thanks, Mohammed"];
    const results = variants.map((v) => run(v, landscaping, KNOWLEDGE['landscaping']!));
    expect(new Set(results.map((r) => `${r.intent.intent}|${r.route}|${r.services[0]}|${r.slots.outwardCode}`)).size).toBe(1);
  });
  it('classification abstains rather than guessing on vague text', () => {
    expect(classifyIntent('hello', drainage).abstained).toBe(true);
  });
  it('sensitive flags include special category mentions but never infer them', () => {
    expect(sensitiveFlags('I am pregnant and the toilet is blocked')).toContain('special_category');
    expect(sensitiveFlags('The toilet is blocked')).toEqual([]);
  });
});
