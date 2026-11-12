/**
 * Plain-English previews of drafted records (I5: the owner sees exactly what they confirm). Pure.
 * Money is formatted from minor units, never re-calculated.
 */
import type { AnyKnowledge } from '@sevari/domain';

const DAYS: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const money = (minor: number | undefined, currency = 'GBP') => minor === undefined ? '' : new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100);
const VAT: Record<string, string> = { inclusive: 'including VAT', exclusive: 'plus VAT', not_registered: 'no VAT' };

export function describeKnowledge(b: AnyKnowledge, serviceNames: ReadonlyMap<string, string> = new Map()): { readonly heading: string; readonly text: string } {
  switch (b.kind) {
    case 'business':
      return { heading: 'Your business', text: `${b.trading_name}. Reply promise: "${b.reply_time_statement}". Privacy notice: ${b.privacy_notice_url}.${b.phone ? ` Phone ${b.phone}.` : ''}${b.email ? ` Email ${b.email}.` : ''}` };
    case 'service':
      return { heading: `Service: ${b.name}`, text: `${b.offered ? 'Offered' : 'Not offered'}${b.emergency ? ', including emergencies' : ''}.${b.keywords.length ? ` Customers may call it: ${b.keywords.join(', ')}.` : ''}` };
    case 'price': {
      const name = serviceNames.get(b.service_code) ?? b.service_code.replace(/_/g, ' ');
      const vat = VAT[b.vat] ?? '';
      const amount = b.basis === 'on_inspection' ? 'Price on inspection'
        : b.basis === 'range' ? `${money(b.amount_minor, b.currency)} to ${money(b.max_minor, b.currency)}, ${vat}`
        : b.basis === 'from' ? `From ${money(b.amount_minor, b.currency)}, ${vat}`
        : b.basis === 'per_hour' ? `${money(b.amount_minor, b.currency)} an hour, ${vat}`
        : b.basis === 'call_out' ? `${money(b.amount_minor, b.currency)} call-out, ${vat}`
        : `${money(b.amount_minor, b.currency)} fixed price, ${vat}`;
      return { heading: `Price: ${name}`, text: `${amount}.${b.conditions ? ` ${b.conditions}` : ''}` };
    }
    case 'hours': {
      const days = Object.entries(b.weekly).filter(([, w]) => w.length).map(([d, w]) => `${DAYS[d] ?? d} ${w.map((x) => `${x.start}–${x.end}`).join(', ')}`);
      return { heading: 'Opening hours', text: `${days.length ? days.join('; ') : 'Closed every day'}.${b.emergency.available ? (b.emergency.always ? ' Emergencies any time.' : ' Emergencies in set hours.') : ''}` };
    }
    case 'area':
      return { heading: 'Area you cover', text: `${b.description}. Postcodes: ${[...b.outward_codes, ...b.postcode_areas].join(', ') || 'none given'}.` };
    case 'policy':
      return { heading: `Policy: ${b.topic.replace(/_/g, ' ')}`, text: b.text };
    case 'faq':
      return { heading: `Question: ${b.question}`, text: b.answer };
    case 'resolution_policy':
      return { heading: 'Complaints: how you put things right', text: `A full response within ${b.response_days} days. Remedies: ${b.remedies.map((r) => `${r.type.replace(/_/g, ' ')}${r.max_minor !== undefined ? ` up to ${money(r.max_minor)}` : ''}`).join(', ')}.` };
  }
}
