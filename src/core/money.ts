/**
 * Prices are entered in the Studio in currency units (25 means €25) and sent to Stripe in the
 * currency's minor unit (2500). Which is which follows https://docs.stripe.com/currencies.
 */

const ZERO_DECIMAL = new Set([
  'bif',
  'clp',
  'djf',
  'gnf',
  'jpy',
  'kmf',
  'krw',
  'mga',
  'pyg',
  'rwf',
  'vnd',
  'vuv',
  'xaf',
  'xof',
  'xpf',
])

const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd'])

/** Whole amounts only, which Stripe still takes as if they had two decimals: 5 ISK is `500`. */
const WHOLE_AS_TWO_DECIMAL = new Set(['isk', 'ugx'])

/** How many decimals Stripe's amounts carry: `1099` is 10.99 USD, `10` is 10 JPY. */
export function minorUnitDigits(currency: string): 0 | 2 | 3 {
  const code = currency.toLowerCase()
  if (ZERO_DECIMAL.has(code)) return 0
  if (THREE_DECIMAL.has(code)) return 3
  return 2
}

/** How many decimals a price in this currency can have: 0 for yen, 2 for euros. */
export function priceDecimals(currency: string): 0 | 2 {
  const code = currency.toLowerCase()
  return ZERO_DECIMAL.has(code) || WHOLE_AS_TWO_DECIMAL.has(code) ? 0 : 2
}

/** Converts a price entered in the Studio (25, 29.5) into the amount Stripe expects. */
export function toMinorUnits(amount: number, currency: string): number {
  const code = currency.toLowerCase()
  if (WHOLE_AS_TWO_DECIMAL.has(code)) return Math.round(amount) * 100
  const digits = minorUnitDigits(code)
  const minor = Math.round(amount * 10 ** digits)
  // Stripe refuses three-decimal amounts that don't end in 0.
  return digits === 3 ? Math.round(minor / 10) * 10 : minor
}

/** The other way: Stripe's amount back into currency units. */
export function fromMinorUnits(minor: number, currency: string): number {
  return minor / 10 ** minorUnitDigits(currency)
}

/** Formats one of Stripe's amounts, such as `2500` and `eur`, for people: "€25.00". */
export function formatMoney(minor: number, currency: string, locale = 'en'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(fromMinorUnits(minor, currency))
}

/** Formats a price as entered in the Studio. */
export function formatPrice(amount: number, currency: string, locale = 'en'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount)
}
