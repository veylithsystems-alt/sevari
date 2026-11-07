/**
 * Money arithmetic (§19.2). Integer minor units only; the model never computes money. VAT treatment is the
 * business's own confirmed record; the rate comes from the region's tax rules. Pure.
 */
export type VatTreatment = 'inclusive' | 'exclusive' | 'not_registered';
export interface Split { readonly net: number; readonly vat: number; readonly total: number }

/** Rounds half away from zero, on whole minor units. */
const div = (a: number, b: number) => Math.sign(a) * Math.floor((Math.abs(a) * 2 + b) / (2 * b));

/** Splits an amount into net, VAT and total, at invoice level (one rounding, HMRC-acceptable). */
export function vatSplit(amountMinor: number, treatment: VatTreatment, rateBp: number): Split {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new RangeError('amounts are non-negative whole minor units');
  if (treatment === 'not_registered' || rateBp === 0) return { net: amountMinor, vat: 0, total: amountMinor };
  if (treatment === 'inclusive') {
    const vat = div(amountMinor * rateBp, 10_000 + rateBp);
    return { net: amountMinor - vat, vat, total: amountMinor };
  }
  const vat = div(amountMinor * rateBp, 10_000);
  return { net: amountMinor, vat, total: amountMinor + vat };
}

export const formatMoney = (minor: number, currency = 'GBP'): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency, minimumFractionDigits: 2 }).format(minor / 100);
