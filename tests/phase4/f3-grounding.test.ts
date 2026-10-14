import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { claimKey, extractClaims, ground, type GroundedDraft, type GroundingSources } from '@sevari/grounding';
import { contractSuite } from '../support/contract.ts';

const ctx = { nowMs: Date.parse('2026-10-14T09:00:00Z'), timezone: 'Europe/London' };
const pad = (n: number) => String(n).padStart(2, '0');

const sources: GroundingSources = {
  factIds: ['kb-1@1', 'kb-2@1', 'kb-3@1'],
  factTexts: [
    'Port Drains (example). Phone 0151 000 0000. Email hello@portdrains.example.com. Privacy: https://portdrains.example.com/privacy',
    'Blocked drain: £95 including VAT (first hour, then £60 an hour).',
    'Available: Thursday 15 October 2026 08:00–10:00, Friday 16 October 2026 14:00–16:00.',
    'We reply within 2 working hours.',
  ],
  customerText: 'Hi, my drain is blocked at CH65 2AB, call me on 07700 900123 please. Friday works.',
};
const check = (text: string) => ground(text, 'reply', sources, ctx);
const supportedKeys = new Set([...sources.factTexts, sources.customerText].flatMap((t) => extractClaims(t, ctx).map(claimKey)));

contractSuite('F3', () => {
  it('supported facts pass, with the citations attached', () => {
    const r = check('Thanks for your message. Clearing a blocked drain is £95 including VAT. We can come on Thursday 15 October at 08:00. We will call you on 07700 900123.');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.draft.factsUsed).toEqual(sources.factIds);
  });

  it('normalises formats: £95 = 95.00 pounds, 2pm = 14:00, 07700 900123 = +447700900123, 15/10 = 15th October', () => {
    for (const t of ['It is 95.00 pounds.', 'We can come at 2pm on Friday.', 'We will ring +44 7700 900123.', 'How about 15/10?', 'How about the 15th of October?', 'A visit on 16th Oct at 14:00.']) {
      expect(check(t), t).toMatchObject({ ok: true });
    }
  });

  it('property: any injected price not in the facts is blocked', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 5_000_000 }), (minor) => {
      fc.pre(!supportedKeys.has(`money:${minor}`));
      const pounds = (minor / 100).toFixed(2);
      for (const shown of [`£${pounds}`, `£${Number(pounds).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`, `${pounds} pounds`]) {
        expect(check(`The job will cost ${shown} in total.`).ok, shown).toBe(false);
      }
    }), { numRuns: 300 });
  });

  it('property: any injected date not in the facts or the customer\'s message is blocked', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 28 }), fc.integer({ min: 1, max: 12 }), (d, m) => {
      const iso = `${m < 10 || (m === 10 && d < 14) ? 2027 : 2026}-${pad(m)}-${pad(d)}`;
      fc.pre(!supportedKeys.has(`date:${iso}`));
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      expect(check(`We can come on ${d} ${months[m - 1]}.`).ok).toBe(false);
      expect(check(`We can come on ${d}/${m}.`).ok).toBe(false);
    }), { numRuns: 300 });
  });

  it('property: any injected time not in the facts is blocked', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 23 }), fc.constantFrom(0, 15, 30, 45), (h, mi) => {
      fc.pre(!supportedKeys.has(`time:${pad(h)}:${pad(mi)}`));
      expect(check(`An engineer will arrive at ${pad(h)}:${pad(mi)}.`).ok).toBe(false);
    }), { numRuns: 200 });
  });

  it('property: any injected phone number, postcode or email not supported is blocked', () => {
    fc.assert(fc.property(fc.stringMatching(/^7\d{9}$/), (rest) => {
      fc.pre(!supportedKeys.has(`phone:+44${rest}`));
      expect(check(`Call our engineer on 0${rest}.`).ok).toBe(false);
    }), { numRuns: 200 });
    fc.assert(fc.property(fc.constantFrom('L', 'M', 'WA', 'SK', 'B', 'LS'), fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 9 }), (area, district, sector) => {
      expect(check(`Our van is based at ${area}${district} ${sector}AB.`).ok).toBe(false);
    }), { numRuns: 100 });
    fc.assert(fc.property(fc.stringMatching(/^[a-z]{3,10}$/), (user) => {
      expect(check(`Email ${user}@other.example.org for help.`).ok).toBe(false);
    }), { numRuns: 100 });
  });

  it('property: any injected bare number or percentage is blocked unless supported', () => {
    fc.assert(fc.property(fc.integer({ min: 3, max: 9999 }), (n) => {
      fc.pre(!supportedKeys.has(`number:${n}`));
      expect(check(`We have ${n} engineers nearby.`).ok).toBe(false);
      expect(check(`You get ${n}% off.`).ok).toBe(false);
    }), { numRuns: 200 });
  });

  it('values the customer gave may be echoed back', () => {
    expect(check('We have your postcode as CH65 2AB and will call 07700 900123 on Friday.').ok).toBe(true);
  });

  it('blocks special-category references the customer did not raise (§8.4)', () => {
    const r = check('As you are pregnant we will prioritise your visit.');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures.map((f) => f.rule)).toContain('special_category');
    const raised = ground('We understand you are pregnant and will prioritise this.', 'reply', { ...sources, customerText: 'I am pregnant and the toilet is blocked' }, ctx);
    expect(raised.ok).toBe(true);
  });

  it('blocks marketing language in service messages', () => {
    const r = check('Book today and get our special offer!');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures.map((f) => f.rule)).toContain('marketing_language');
  });

  it('reports every failure and never rewrites the text (reference defect D-6)', () => {
    const r = check('It costs £120 and we come at 3pm with 2 vans.');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures.map((f) => f.detail)).toEqual(expect.arrayContaining([expect.stringContaining('£120'), expect.stringContaining('3pm')]));
  });

  it('a GroundedDraft cannot be constructed outside the grounding package (type-level)', () => {
    // @ts-expect-error the brand is a private unique symbol: object literals can't satisfy GroundedDraft
    const forged: GroundedDraft = { text: 'hi', purpose: 'reply', claims: [], factsUsed: [] };
    expect(forged.text).toBe('hi');
  });
});

describe('[F3] claim extraction details', () => {
  it('extracts each kind once, in normalised form', () => {
    const keys = extractClaims('£1,250.50 on 14th Oct at 2:30pm, ring 0151 000 0000 or a@b.co.uk, CH65 2AB, 20% and 3 vans. https://x.example.com/p', ctx).map(claimKey);
    expect(keys).toEqual(expect.arrayContaining([
      'money:125050', 'date:2026-10-14', 'time:14:30', 'phone:+441510000000', 'email:a@b.co.uk', 'postcode:CH65 2AB', 'percent:20', 'number:3', 'host:x.example.com',
    ]));
  });
});
