/** Formatting only. Amount validation, arithmetic and missing-value policy stay with callers. */
export type UsdPrecision = 'cents' | 'whole' | 'optionalCents';
const whole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatUsdDollars(dollars: number, precision: UsdPrecision = 'cents'): string {
  return (precision === 'whole' || precision === 'optionalCents' && Number.isInteger(dollars) ? whole : cents).format(dollars);
}

export function formatUsdCents(amountCents: number, precision: UsdPrecision = 'cents'): string {
  // Choose from the original cents, before division can lose a remainder at large magnitudes.
  if (precision === 'optionalCents') return (amountCents % 100 ? cents : whole).format(amountCents / 100);
  return formatUsdDollars(amountCents / 100, precision);
}
