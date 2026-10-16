/** Normalisers used before blind-indexing and for grounding comparisons. Pure. */

export function normaliseEmail(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

/**
 * UK-first phone normalisation to E.164. Returns null when the input cannot be a phone number.
 * 07700 900123 / 447700900123 / +44 (0)7700 900123 / 0044 7700 900123 -> +447700900123
 */
export function normalisePhone(raw: string, defaultCountry: 'GB' = 'GB'): string | null {
  let s = raw.normalize('NFKC').trim().replace(/\(0\)/g, '').replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!/^\+?\d{6,15}$/.test(s)) return null;
  if (s.startsWith('+')) return s;
  if (defaultCountry === 'GB') {
    if (s.startsWith('44') && s.length >= 12) return '+' + s;
    if (s.startsWith('0')) return '+44' + s.slice(1);
  }
  return null;
}

/** UK mobile (07xxx) after normalisation: +447 followed by 9 digits. */
export const isUkMobile = (e164: string): boolean => /^\+447\d{9}$/.test(e164);

/** UK postcode, normalised to outward + space + inward, upper case. */
export function normalisePostcode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/\s+/g, '');
  const m = /^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/.exec(s);
  return m ? `${m[1]} ${m[2]}` : null;
}
