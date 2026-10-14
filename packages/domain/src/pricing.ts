/**
 * Price answers come only from price records (§5.2, §42). "Price on inspection" is a valid, grounded
 * answer. No record means UNKNOWN, never an estimate.
 */
import type { KnowledgeFact, KnowledgeSnapshot, PriceRecord } from './knowledge.ts';
import { formatMoney, money } from './money.ts';

export type PriceAnswer =
  | { readonly kind: 'known'; readonly serviceCode: string; readonly statement: string; readonly vat: PriceRecord['vat']; readonly basis: PriceRecord['basis']; readonly factsUsed: readonly string[] }
  | { readonly kind: 'unknown'; readonly serviceCode: string | null; readonly missing: string };

export function priceFor(k: KnowledgeSnapshot, serviceCode: string | null): PriceAnswer {
  if (!serviceCode) return { kind: 'unknown', serviceCode: null, missing: 'service' };
  const recs = k.prices.filter((p) => p.body.service_code === serviceCode);
  if (recs.length === 0) return { kind: 'unknown', serviceCode, missing: `knowledge:price:${serviceCode}` };
  // Deterministic choice: the main basis first, call-out fees appended.
  const order: PriceRecord['basis'][] = ['fixed', 'from', 'range', 'per_hour', 'on_inspection', 'call_out'];
  const sorted = [...recs].sort((a, b) => order.indexOf(a.body.basis) - order.indexOf(b.body.basis));
  const main = sorted.find((r) => r.body.basis !== 'call_out') ?? sorted[0];
  if (!main) return { kind: 'unknown', serviceCode, missing: `knowledge:price:${serviceCode}` };
  const callOut = sorted.find((r) => r.body.basis === 'call_out' && r !== main);
  const parts = [describe(main)];
  if (callOut) parts.push(describe(callOut));
  return {
    kind: 'known', serviceCode, statement: parts.join('; '), vat: main.body.vat, basis: main.body.basis,
    factsUsed: [main, ...(callOut ? [callOut] : [])].map((r) => `${r.id}@${r.version}`),
  };
}

function vatText(v: PriceRecord['vat']): string {
  return v === 'inclusive' ? ' including VAT' : v === 'exclusive' ? ' plus VAT' : '';
}

function describe(r: KnowledgeFact<PriceRecord>): string {
  const p = r.body;
  const m = (n?: number) => formatMoney(money(n ?? 0, p.currency));
  const cond = p.conditions ? ` (${p.conditions})` : '';
  switch (p.basis) {
    case 'fixed': return `${m(p.amount_minor)}${vatText(p.vat)}${cond}`;
    case 'from': return `from ${m(p.amount_minor)}${vatText(p.vat)}${cond}`;
    case 'range': return `between ${m(p.amount_minor)} and ${m(p.max_minor)}${vatText(p.vat)}${cond}`;
    case 'per_hour': return `${m(p.amount_minor)} an hour${vatText(p.vat)}${cond}`;
    case 'call_out': return `a call-out charge of ${m(p.amount_minor)}${vatText(p.vat)}${cond}`;
    case 'on_inspection': return `priced on inspection${cond}`;
  }
}
