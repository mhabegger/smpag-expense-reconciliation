// Money is stored everywhere as integer MINOR units (e.g. cents) + a currency.
// These helpers convert between human decimals and minor units without floats.

const DECIMALS: Record<string, number> = {
  CHF: 2,
  EUR: 2,
  USD: 2,
  GBP: 2,
  JPY: 0,
  KRW: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
}

export function currencyDecimals(currency: string): number {
  return DECIMALS[currency.toUpperCase()] ?? 2
}

/** Convert a numeric (possibly float) amount in major units to integer minor units. */
export function toMinor(amount: number, currency: string): number {
  const factor = 10 ** currencyDecimals(currency)
  // round to avoid binary float drift (e.g. 0.1 + 0.2)
  return Math.round(amount * factor)
}

/** Convert integer minor units back to a major-unit number. */
export function fromMinor(minor: number, currency: string): number {
  const factor = 10 ** currencyDecimals(currency)
  return minor / factor
}

/** Format minor units as a localized string with currency code, e.g. "1'234.50 CHF". */
export function formatMoney(
  minor: number | null | undefined,
  currency: string,
): string {
  if (minor == null) return '—'
  const decimals = currencyDecimals(currency)
  const major = fromMinor(minor, currency)
  const formatted = new Intl.NumberFormat('de-CH', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(major)
  return `${formatted} ${currency.toUpperCase()}`
}

/** Absolute value in minor units. */
export function absMinor(minor: number): number {
  return Math.abs(minor)
}
