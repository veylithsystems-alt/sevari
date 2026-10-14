/**
 * The facts bundle (§5.3, §9): everything a reply may say, built only from the analysis and the owner's
 * confirmed records. The same bundle feeds the template, the model (as JSON) and grounding (as text),
 * so the model can never be given a fact that grounding would not accept, or the reverse.
 */
import type { EnquiryAnalysis } from './analyse.ts';
import type { KnowledgeSnapshot } from './knowledge.ts';

export interface FactsBundle {
  /** Structured facts for the model's prompt. Contact details of the customer are never included. */
  readonly facts: Readonly<Record<string, unknown>>;
  /** The same facts as plain sentences, for grounding. */
  readonly texts: readonly string[];
  /** Citations (record id@version). */
  readonly ids: readonly string[];
  /** For "we do / we don't do" checks. */
  readonly services: readonly { readonly code: string; readonly names: readonly string[]; readonly offered: boolean }[];
}

const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "2026-10-15" → "Thursday 15 October 2026" (the date is already local to the business). */
export function longDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return DAY.format(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).replace(',', '');
}

export function factsBundle(a: EnquiryAnalysis, k: KnowledgeSnapshot): FactsBundle {
  const facts: Record<string, unknown> = {};
  const texts: string[] = [];
  const b = k.business?.body;
  if (b) {
    facts['business'] = { name: b.trading_name, ...(b.phone ? { phone: b.phone } : {}), ...(b.email ? { email: b.email } : {}), reply_time: b.reply_time_statement };
    texts.push([b.trading_name, b.phone ? `Phone ${b.phone}.` : '', b.email ? `Email ${b.email}.` : '', `We reply ${b.reply_time_statement}.`].filter(Boolean).join(' '));
  }
  const services = a.services.map((code) => {
    const rec = k.services.find((s) => s.body.code === code)?.body;
    return { code, names: [rec?.name ?? code.replace(/_/g, ' ')], offered: rec?.offered ?? false };
  });
  if (services.length) {
    facts['services'] = services.map((s) => ({ name: s.names[0], offered: s.offered }));
    for (const s of services) texts.push(`${s.offered ? 'We do' : 'We do not do'} ${s.names[0]}.`);
  }
  if (a.price?.kind === 'known') {
    facts['price'] = a.price.statement;
    texts.push(a.price.statement);
  }
  if (a.windows?.length) {
    const ws = a.windows.map((w) => `${longDate(w.date)} ${w.start}–${w.end}`);
    facts['available_windows'] = ws;
    texts.push(`Available: ${ws.join(', ')}.`);
  }
  const faqs = k.faqs.filter((f) => a.faqs.includes(`${f.id}@${f.version}`));
  if (faqs.length) {
    facts['answers'] = faqs.map((f) => ({ question: f.body.question, answer: f.body.answer }));
    for (const f of faqs) texts.push(f.body.answer);
  }
  if (a.eligibility.overall !== 'unknown') facts['in_service_area'] = a.eligibility.overall === 'yes';
  if (a.factsMissing.length) facts['team_will_confirm'] = a.factsMissing.map((m) => m.replace(/^knowledge:/, '').replace(/[:_]/g, ' '));
  return { facts, texts, ids: a.factsUsed, services };
}
