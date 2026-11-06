/**
 * The synthetic test set for a pack (§81.2, §83.2, T-PACK-1): enquiries generated from the business's own
 * answers, run through the real deterministic core, the real templates and the real fact-checker. A pack
 * passes only if every service is recognised from its everyday words, the always-human and stop paths
 * route correctly, and no reply fails the fact check. Pure: same answers, same result.
 */
import { analyseEnquiry, factsBundle, replySections, snapshotFrom, type AnyKnowledge, type KnowledgeFact, type Route, type VerticalPack } from '@sevari/domain';
import { ground } from '@sevari/grounding';
import { render } from '@sevari/templates';

export interface SyntheticCase { readonly name: string; readonly text: string; readonly expect: { route?: Route; service?: string } }
export interface SyntheticReport {
  readonly passed: boolean;
  readonly total: number;
  readonly failures: readonly { readonly case: string; readonly why: string }[];
  readonly groundingFailures: number;
}

export function syntheticCases(records: readonly AnyKnowledge[], pack: VerticalPack): SyntheticCase[] {
  const area = records.find((r) => r.kind === 'area');
  const outward = area?.kind === 'area' ? area.outward_codes[0] ?? (area.postcode_areas[0] ? `${area.postcode_areas[0]}1` : undefined) : undefined;
  const pc = outward ? ` ${outward} 1AA` : '';
  const cases: SyntheticCase[] = [];
  for (const s of pack.services) {
    const offered = records.some((r) => r.kind === 'service' && r.code === s.code && r.offered);
    if (!offered) continue;
    const word = s.keywords.find((k) => k !== s.name.toLowerCase()) ?? s.keywords[0] ?? s.name;
    cases.push({ name: `price: ${s.name}`, text: `Hi, how much do you charge for ${word}?${pc}`, expect: { service: s.code, route: 'answer' } });
    cases.push({ name: `booking: ${s.name}`, text: `Hello, could you come out for ${word} please?${pc}`, expect: { service: s.code, route: 'answer' } });
  }
  cases.push({ name: 'stop', text: 'STOP', expect: { route: 'opt_out' } });
  cases.push({ name: 'complaint', text: 'I want to make a formal complaint about the work you did.', expect: { route: 'human_only' } });
  cases.push({ name: 'data request', text: 'Please delete all the personal data you hold about me.', expect: { route: 'human_only' } });
  return cases;
}

export function runSyntheticTests(records: readonly AnyKnowledge[], pack: VerticalPack, ctx: { nowMs: number; timezone: string }): SyntheticReport {
  const facts: KnowledgeFact[] = records.map((body, i) => ({ id: `synthetic-${i + 1}`, version: 1, body }));
  const snap = snapshotFrom(facts);
  const business = snap.business?.body;
  const failures: { case: string; why: string }[] = [];
  let groundingFailures = 0;
  const cases = syntheticCases(records, pack);
  for (const c of cases) {
    const a = analyseEnquiry({ text: c.text, nowMs: ctx.nowMs, timezone: ctx.timezone, pack, knowledge: snap });
    if (c.expect.route && a.route !== c.expect.route) failures.push({ case: c.name, why: `went to "${a.route}", expected "${c.expect.route}"${a.factsMissing.length ? ` (missing: ${a.factsMissing.join(', ')})` : ''}` });
    if (c.expect.service && !a.services.includes(c.expect.service)) failures.push({ case: c.name, why: `didn't recognise the service from "${c.text}"` });
    if ((a.route === 'answer' || a.route === 'clarify') && business) {
      const values = { business: business.trading_name, replyTime: business.reply_time_statement, privacyUrl: business.privacy_notice_url, discloseAutomation: false };
      const rendered = a.route === 'clarify' ? render('clarify', 'email', { ...values, question: a.clarify?.question ?? '' }) : render('reply', 'email', { ...values, sections: replySections(a, snap) });
      if (!rendered.ok) { failures.push({ case: c.name, why: `reply template: ${rendered.reason}` }); continue; }
      const b = factsBundle(a, snap);
      const g = ground(rendered.text, a.route === 'clarify' ? 'clarify' : 'reply', { factTexts: [...b.texts, business.trading_name, business.privacy_notice_url], factIds: [...b.ids], customerText: c.text, services: b.services }, ctx);
      if (!g.ok) {
        groundingFailures += g.failures.length;
        failures.push({ case: c.name, why: `fact check: ${g.failures.map((f) => f.detail).join('; ')}` });
      }
    }
  }
  return { passed: failures.length === 0, total: cases.length, failures, groundingFailures };
}
