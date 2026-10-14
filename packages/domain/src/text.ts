/**
 * Text normalisation and phrase matching for the deterministic core (§5.3).
 * Whole-word matching only: "heat" never matches "wheat" (reference defect D-4).
 */

/** Lower-case, NFKC, curly quotes straightened, punctuation to spaces, single-spaced. */
export function normaliseForMatch(s: string): string {
  return ` ${s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[^a-z0-9£'\s]/g, ' ')
    .replace(/'(?![a-z])|(?<![a-z])'/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

/** True when `phrase` occurs as whole words in already-normalised `haystack`. */
export function hasPhrase(haystack: string, phrase: string): boolean {
  const p = normaliseForMatch(phrase);
  return p.trim().length > 0 && haystack.includes(p);
}

const NEGATORS = [' not ', " isn't ", ' no ', ' never ', " don't ", " doesn't ", ' without ', " wasn't ", " aren't "];

/** True when the phrase occurs but is negated within the three words before it ("not urgent"). */
export function isNegated(haystack: string, phrase: string): boolean {
  const p = normaliseForMatch(phrase);
  let from = 0;
  let found = false;
  for (;;) {
    const i = haystack.indexOf(p, from);
    if (i < 0) break;
    found = true;
    const before = haystack.slice(0, i + 1).split(' ').slice(-5).join(' ');
    if (!NEGATORS.some((n) => ` ${before} `.includes(n))) return false;
    from = i + 1;
  }
  return found;
}

/** Counts a phrase as present only when at least one occurrence is not negated. */
export function hasAffirmed(haystack: string, phrase: string): boolean {
  return hasPhrase(haystack, phrase) && !isNegated(haystack, phrase);
}
