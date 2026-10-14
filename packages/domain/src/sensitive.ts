/**
 * Escalation signals (§20, §22, §42). Tuned for recall: a false negative is worse than a false
 * positive (§20.1). Any hit takes the enquiry off the automatic path to an owner, with only a holding
 * acknowledgement. Risk to life gets the safety-first reply (§42) before anything else.
 */
import { hasAffirmed, hasPhrase, normaliseForMatch } from './text.ts';

export type SensitiveFlag =
  | 'risk_to_life' | 'legal_threat' | 'regulator' | 'safeguarding' | 'injury_or_damage' | 'discrimination'
  | 'media' | 'data_rights' | 'vulnerable_customer' | 'complaint' | 'opt_out' | 'special_category';

const RULES: ReadonlyArray<[SensitiveFlag, readonly string[]]> = [
  ['risk_to_life', ['smell gas', 'smell of gas', 'gas leak', 'carbon monoxide', 'co alarm', 'fire', 'smoke', 'sparking', 'electric shock', 'trapped', 'locked in', 'child locked', 'baby locked', 'collapsed', 'can\'t breathe', 'cannot breathe', 'unconscious', 'water near electrics', 'water near the electrics', 'ceiling collapsing', 'ceiling coming down', 'roof collapsing', 'sewage in the house', 'sewage in the kitchen']],
  ['legal_threat', ['solicitor', 'lawyer', 'legal action', 'take you to court', 'small claims', 'sue you', 'suing', 'court action', 'letter before action', 'trading standards']],
  ['regulator', ['ombudsman', 'ico', 'information commissioner', 'regulator', 'citizens advice', 'trading standards']],
  ['safeguarding', ['abuse', 'abused', 'neglect', 'unsafe at home', 'harassed', 'harassment', 'threatened me', 'scared of him', 'scared of her']],
  ['injury_or_damage', ['injured', 'injury', 'hurt myself', 'damaged my', 'damage to my', 'broke my', 'flooded my', 'ruined my', 'compensation']],
  ['discrimination', ['racist', 'racism', 'sexist', 'discriminated', 'discrimination', 'homophobic', 'disability discrimination']],
  ['media', ['journalist', 'newspaper', 'press', 'reporter', 'going to the papers', 'bbc', 'watchdog']],
  ['data_rights', ['subject access', 'access request', 'delete my data', 'erase my data', 'my personal data', 'gdpr', 'data protection', 'what data you hold', 'right to be forgotten']],
  ['vulnerable_customer', ['elderly', 'disabled', 'disability', 'wheelchair', 'carer', 'dementia', 'pregnant', 'newborn', 'bereaved', 'bereavement', 'passed away', 'terminally ill', 'hospital', 'mental health', 'struggling to pay', 'can\'t afford']],
  ['complaint', ['complaint', 'complain', 'not happy', 'unhappy', 'disappointed', 'terrible service', 'poor service', 'shoddy', 'refund', 'want my money back', 'still not fixed', 'came back worse', 'unacceptable', 'disgusted']],
  ['opt_out', ['stop', 'unsubscribe', 'stop texting', 'stop messaging', 'remove me', 'opt out', 'don\'t contact me', 'do not contact me']],
  ['special_category', ['cancer', 'hiv', 'pregnant', 'religion', 'muslim', 'christian', 'jewish', 'sexuality', 'gay', 'lesbian', 'trade union', 'criminal record']],
];

export function sensitiveFlags(text: string): SensitiveFlag[] {
  const h = normaliseForMatch(text);
  const out = new Set<SensitiveFlag>();
  for (const [flag, phrases] of RULES) {
    // Recall first: risk-to-life and legal phrases count even if negated ("no gas smell" still escalates
    // to a human, who can tell the difference). Softer signals require an affirmed mention.
    const strict = flag === 'risk_to_life' || flag === 'legal_threat' || flag === 'safeguarding';
    if (phrases.some((p) => (strict ? hasPhrase(h, p) : hasAffirmed(h, p)))) out.add(flag);
  }
  // A bare "STOP" message is an opt-out on SMS (§50.3, F39).
  if (/^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i.test(text)) out.add('opt_out');
  return [...out];
}

/** Flags that must never get an automatic reply beyond a holding acknowledgement (§20.2, T-CMP-1). */
export const ALWAYS_HUMAN_FLAGS: ReadonlySet<SensitiveFlag> = new Set([
  'legal_threat', 'regulator', 'safeguarding', 'injury_or_damage', 'discrimination', 'media', 'data_rights', 'vulnerable_customer', 'special_category',
]);
