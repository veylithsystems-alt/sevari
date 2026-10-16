/** Money is integer minor units plus a currency. The model never computes money (§19.2). */
export interface Money {
  readonly minor: number;
  readonly currency: 'GBP' | 'EUR' | 'USD';
}

export function money(minor: number, currency: Money['currency'] = 'GBP'): Money {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RangeError(`money: invalid minor units ${minor}`);
  return { minor, currency };
}

/** £1,234.50 style. Deterministic, en-GB, no locale lookups. */
export function formatMoney(m: Money): string {
  const symbol = m.currency === 'GBP' ? '£' : m.currency === 'EUR' ? '€' : '$';
  const pounds = Math.floor(m.minor / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const pence = m.minor % 100;
  return pence === 0 ? `${symbol}${pounds}` : `${symbol}${pounds}.${pence.toString().padStart(2, '0')}`;
}
