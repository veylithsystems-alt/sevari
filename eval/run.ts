/**
 * pnpm eval: runs the labelled corpus through the deterministic core and writes eval/reports/<date>.md
 * (§10.3). With --check, fails if any quality metric drops more than 2 points against the accepted
 * baseline (eval/baseline.json). With --accept, records the current run as the baseline (a human act).
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { analyseEnquiry, type EnquiryAnalysis } from '@sevari/domain';
import { packFor } from '@sevari/verticals';
import { KNOWLEDGE } from './fixtures/knowledge.ts';

const ROOT = resolve(import.meta.dirname);
const NOW = Date.parse('2026-10-14T09:00:00Z'); // Wednesday 10:00 in Ellesmere Port

interface Case { id: string; trade: string; text: string; from_name?: string; expect: { intent: string; route: string; service: string | null; outward: string | null; urgency: string } }

export function loadCorpus(dir = join(ROOT, 'corpus')): Case[] {
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Case));
}

export function runCase(c: Case): EnquiryAnalysis {
  const knowledge = KNOWLEDGE[c.trade];
  if (!knowledge) throw new Error(`no knowledge fixture for ${c.trade}`);
  return analyseEnquiry({ text: c.text, nowMs: NOW, timezone: 'Europe/London', pack: packFor(c.trade), knowledge, ...(c.from_name ? { fromName: c.from_name } : {}) });
}

export interface Metrics { n: number; intent: number; route: number; service: number; outward: number; urgency: number; safety_recall: number; human_recall: number; abstain_rate: number }

export function evaluate(cases: Case[]) {
  const rows = cases.map((c) => {
    const a = runCase(c);
    const got = { intent: a.intent.intent, route: a.route, service: a.services[0] ?? null, outward: a.slots.outwardCode ?? null, urgency: a.slots.urgency };
    return { c, got, a };
  });
  const pct = (f: (r: (typeof rows)[number]) => boolean, sub = rows) => (sub.length ? Math.round((sub.filter(f).length / sub.length) * 1000) / 10 : 100);
  const safety = rows.filter((r) => r.c.expect.route === 'safety_first');
  const human = rows.filter((r) => r.c.expect.route === 'human_only');
  const metrics: Metrics = {
    n: rows.length,
    intent: pct((r) => r.got.intent === r.c.expect.intent),
    route: pct((r) => r.got.route === r.c.expect.route),
    service: pct((r) => r.got.service === r.c.expect.service),
    outward: pct((r) => r.got.outward === r.c.expect.outward),
    urgency: pct((r) => r.got.urgency === r.c.expect.urgency),
    // Floors-adjacent: missing a safety or always-human case is the worst kind of error.
    safety_recall: pct((r) => r.got.route === 'safety_first', safety),
    human_recall: pct((r) => r.got.route === 'human_only' || r.got.route === 'safety_first', human),
    abstain_rate: pct((r) => r.a.intent.abstained),
  };
  return { rows, metrics };
}

function report(date: string, ev: ReturnType<typeof evaluate>, baseline: Metrics | null): string {
  const m = ev.metrics;
  const line = (k: keyof Metrics, label: string) => `| ${label} | ${m[k]}${k === 'n' ? '' : '%'} | ${baseline ? `${baseline[k]}${k === 'n' ? '' : '%'}` : '—'} |`;
  const misses = ev.rows.filter((r) => r.got.intent !== r.c.expect.intent || r.got.route !== r.c.expect.route || r.got.service !== r.c.expect.service || r.got.outward !== r.c.expect.outward || r.got.urgency !== r.c.expect.urgency);
  return [
    `# Corpus evaluation, ${date}`, '',
    'Deterministic core only (rules, no model). Corpus: `eval/corpus/` (100 synthetic enquiries, 5 provisional trades; **drafted, not frozen**: contract §65 freezes it once Dan confirms the trades).', '',
    '| Metric | This run | Accepted baseline |', '|---|---|---|',
    line('n', 'Cases'), line('intent', 'Intent accuracy'), line('route', 'Route accuracy (what happens next)'), line('service', 'Service detection'),
    line('outward', 'Postcode district'), line('urgency', 'Urgency'), line('safety_recall', 'Risk-to-life recall'), line('human_recall', 'Always-human recall'), line('abstain_rate', 'Rules abstained'), '',
    `## Cases that differ from the label (${misses.length})`, '',
    '| Case | Field(s) | Expected | Got |', '|---|---|---|---|',
    ...misses.map((r) => {
      const fields = (['intent', 'route', 'service', 'outward', 'urgency'] as const).filter((k) => r.got[k] !== r.c.expect[k]);
      return `| ${r.c.id} | ${fields.join(', ')} | ${fields.map((k) => String(r.c.expect[k])).join(' / ')} | ${fields.map((k) => String(r.got[k])).join(' / ')} |`;
    }),
    '',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ev = evaluate(loadCorpus());
  const baselinePath = join(ROOT, 'baseline.json');
  const baseline: Metrics | null = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
  const date = process.env['SEVARI_EVAL_DATE'] ?? new Date().toISOString().slice(0, 10); // eslint-disable-line sevari/no-raw-date -- report label only
  writeFileSync(join(ROOT, 'reports', `${date}.md`), report(date, ev, baseline));
  console.log(JSON.stringify(ev.metrics));
  if (process.argv.includes('--accept')) writeFileSync(baselinePath, JSON.stringify(ev.metrics, null, 2) + '\n');
  if (process.argv.includes('--check') && baseline) {
    const drops = (['intent', 'route', 'service', 'outward', 'urgency', 'safety_recall', 'human_recall'] as const).filter((k) => ev.metrics[k] < baseline[k] - 2);
    if (drops.length) {
      console.error(`Quality dropped more than 2 points: ${drops.join(', ')}`);
      process.exit(1);
    }
  }
}
