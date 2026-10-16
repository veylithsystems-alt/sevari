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
    // Negation scope: up to three words back, and never across a clause break ("no hot water but heat works").
    const words = haystack.slice(0, i).trim().split(' ');
    const lastBreak = Math.max(...['but', 'and', 'although', 'though', 'however', 'whereas'].map((b) => words.lastIndexOf(b)));
    const before = words.slice(Math.max(lastBreak + 1, words.length - 3)).join(' ');
    if (!NEGATORS.some((n) => ` ${before} `.includes(n))) return false;
    from = i + 1;
  }
  return found;
}

/** Counts a phrase as present only when at least one occurrence is not negated. */
export function hasAffirmed(haystack: string, phrase: string): boolean {
  return hasPhrase(haystack, phrase) && !isNegated(haystack, phrase);
}

/** Light, deterministic stemmer: "changed"/"change"/"changing" -> "chang"; "locks" -> "lock". */
export function stem(word: string): string {
  let w = word.replace(/'s$/, '').replace(/'/g, '');
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

const STOPWORDS = new Set(['a', 'an', 'the', 'my', 'our', 'your', 'of', 'to', 'in', 'on', 'for', 'and', 'is', 'it', 'at', 'be', 'me', 'we', 'i']);

export function stemTokens(s: string): string[] {
  return normaliseForMatch(s).trim().split(' ').filter(Boolean).map(stem);
}

/**
 * Keyword match on stemmed tokens: the keyword's content words appear contiguously, or (for multi-word
 * keywords) all within a window of `window` tokens in any order. "locks changed" matches "change locks".
 */
export function matchesKeyword(tokens: readonly string[], keyword: string, window = 6): boolean {
  const kw = stemTokens(keyword).filter((t) => !STOPWORDS.has(t));
  if (kw.length === 0) return false;
  if (kw.length === 1) return tokens.includes(kw[0] ?? '');
  for (let i = 0; i < tokens.length; i++) {
    if (!kw.includes(tokens[i] ?? '')) continue;
    const span = tokens.slice(i, i + window);
    if (kw.every((k) => span.includes(k))) return true;
  }
  return false;
}
