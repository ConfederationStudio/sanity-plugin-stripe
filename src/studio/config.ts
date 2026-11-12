import {priceDecimals} from '../core/money'

/** The Studio's API version for the plugin's own reads and writes. */
export const API_VERSION = '2025-02-19'

/** A tax class an editor can give a product, such as a reduced and a standard VAT rate. */
export interface TaxClass {
  /** What the editor reads, such as "Printed matter (9%)". */
  title: string
  /** What is saved, and what the site maps to a Stripe tax rate, such as `reduced`. */
  value: string
}

/** A shipping region to start the shop settings with. */
export interface ShippingRegionInput {
  title: string
  /** ISO 3166-1 alpha-2 codes, such as `['NL']` or `[...EU_COUNTRIES]`. */
  countries?: readonly string[]
  /** Covers every country Stripe ships to that no other region lists. */
  everywhereElse?: boolean
  /** One flat rate per order, in currency units. */
  rate: number
  /** Goods adding up to this amount or more are delivered free. In currency units. */
  freeFrom?: number
}

export interface StripeCommerceConfig {
  /** ISO 4217 code of the currency every price is in, such as `eur` or `usd`. */
  currency: string
  tax?: {
    /** What tax is called where the shop is: `VAT`, `GST`, `sales tax`. Default `tax`. */
    label?: string
    /** Whether the prices editors enter include tax. It only changes the labels. Default true. */
    included?: boolean
    /** Tax classes editors choose from. Without any, products have no tax class field. */
    classes?: readonly TaxClass[]
  }
  /** Starting values for the shop settings document, offered while it has no regions. */
  shop?: {
    shippingRegions?: readonly ShippingRegionInput[]
  }
  /**
   * Where the site answers the Studio, such as `https://www.example.com/api/shop`: the address
   * `studioRoutes` is mounted on. With it the Studio gets an Orders tab, read from Stripe through
   * the site. A Studio that runs on the site itself can give the path alone: `/api/shop`.
   */
  api?: string
}

export interface ResolvedConfig {
  /** Lower case. */
  currency: string
  /** Upper case, for labels. */
  currencyLabel: string
  priceDecimals: 0 | 2
  tax: {label: string; included: boolean; classes: readonly TaxClass[]}
  shop: {shippingRegions: readonly ShippingRegionInput[]}
  /** Without a slash at the end. Null when the site has no Studio routes. */
  api: string | null
}

function resolveApi(api: string | undefined): string | null {
  if (api === undefined) return null
  const address = typeof api === 'string' ? api.trim().replace(/\/+$/, '') : ''
  if (!/^(?:https?:\/\/[^/\s]+|\/[^/\s])\S*$/.test(address))
    throw new TypeError(
      `sanity-plugin-stripe: api must be an address or a path, such as stripeCommerce({api: 'https://www.example.com/api/shop'})`,
    )
  return address
}

export function resolveConfig(config: StripeCommerceConfig): ResolvedConfig {
  const currency = typeof config?.currency === 'string' ? config.currency.trim().toLowerCase() : ''
  if (!/^[a-z]{3}$/.test(currency))
    throw new TypeError(
      `sanity-plugin-stripe: currency must be a three-letter code, such as stripeCommerce({currency: 'eur'})`,
    )
  return {
    currency,
    currencyLabel: currency.toUpperCase(),
    priceDecimals: priceDecimals(currency),
    tax: {
      label: config.tax?.label?.trim() || 'tax',
      included: config.tax?.included ?? true,
      classes: config.tax?.classes ?? [],
    },
    shop: {shippingRegions: config.shop?.shippingRegions ?? []},
    api: resolveApi(config.api),
  }
}

/** "Price (EUR, including VAT)", or "Price (EUR)" when prices are entered without tax. */
export function moneyTitle(name: string, config: ResolvedConfig): string {
  return config.tax.included
    ? `${name} (${config.currencyLabel}, including ${config.tax.label})`
    : `${name} (${config.currencyLabel})`
}
