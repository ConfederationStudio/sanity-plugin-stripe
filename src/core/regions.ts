import {STRIPE_SHIPPING_COUNTRIES} from './countries'
import {asArray, asNumber, asString, isObject} from './guards'

/** A shipping region with one flat rate per order. */
export interface ShippingRegion {
  id: string
  title: string
  /** ISO 3166-1 alpha-2 codes. Empty for the "everywhere else" region until resolved. */
  countries: string[]
  everywhereElse: boolean
  /** In currency units. */
  rate: number
  /** Goods adding up to this amount or more are delivered free. In currency units. */
  freeFrom?: number
}

/** How a subscription pays for delivery: nothing extra, or the region's rate with every delivery. */
export type SubscriptionDelivery = 'free' | 'rate'

/** The shop settings document, as `SHOP_SETTINGS_QUERY` returns it. */
export interface ShopSettings {
  shippingRegions?: Array<{
    _key: string
    title?: string | null
    everywhereElse?: boolean | null
    countries?: string[] | null
    rate?: number | null
    freeFrom?: number | null
  }> | null
  autoSoldOut?: boolean | null
  subscriptionDelivery?: SubscriptionDelivery | null
}

/** The shop settings as Sanity returned them, or null when they aren't published yet. */
export function readShopSettings(value: unknown): ShopSettings | null {
  if (!isObject(value)) return null
  return {
    shippingRegions: asArray(value.shippingRegions).flatMap((region) =>
      isObject(region) && typeof region._key === 'string'
        ? [
            {
              _key: region._key,
              title: asString(region.title),
              everywhereElse: region.everywhereElse === true,
              countries: asArray(region.countries).filter(
                (country): country is string => typeof country === 'string',
              ),
              rate: asNumber(region.rate),
              freeFrom: asNumber(region.freeFrom),
            },
          ]
        : [],
    ),
    autoSoldOut: typeof value.autoSoldOut === 'boolean' ? value.autoSoldOut : null,
    subscriptionDelivery:
      value.subscriptionDelivery === 'rate' || value.subscriptionDelivery === 'free'
        ? value.subscriptionDelivery
        : null,
  }
}

/** Shipping regions from the shop settings, leaving out any that aren't filled in. */
export function regionsFromSettings(settings: ShopSettings | null | undefined): ShippingRegion[] {
  return (settings?.shippingRegions ?? []).flatMap((region) =>
    region.title && typeof region.rate === 'number'
      ? [
          {
            id: region._key,
            title: region.title,
            countries: region.countries ?? [],
            everywhereElse: Boolean(region.everywhereElse),
            rate: region.rate,
            ...(typeof region.freeFrom === 'number' && region.freeFrom > 0
              ? {freeFrom: region.freeFrom}
              : {}),
          },
        ]
      : [],
  )
}

/**
 * Fills in the "everywhere else" region with every country Stripe ships to that no other region
 * lists, and drops country codes Stripe doesn't accept. Regions left without countries are removed.
 */
export function resolveRegions(regions: readonly ShippingRegion[]): ShippingRegion[] {
  const supported = new Set<string>(STRIPE_SHIPPING_COUNTRIES)
  const listed = new Set(
    regions.filter((region) => !region.everywhereElse).flatMap((region) => region.countries),
  )
  return regions
    .map((region) => ({
      ...region,
      countries: region.everywhereElse
        ? STRIPE_SHIPPING_COUNTRIES.filter((country) => !listed.has(country))
        : region.countries.filter((country) => supported.has(country)),
    }))
    .filter((region) => region.countries.length > 0)
}

/** What a cart page needs of each region: no country lists. */
export type RegionOption = Pick<ShippingRegion, 'id' | 'title' | 'rate' | 'freeFrom'>

/** The regions a buyer can choose from, the same ones the checkout accepts. */
export function regionOptions(settings: ShopSettings | null | undefined): RegionOption[] {
  return resolveRegions(regionsFromSettings(settings)).map(({id, title, rate, freeFrom}) => {
    const option: RegionOption = {id, title, rate}
    if (freeFrom !== undefined) option.freeFrom = freeFrom
    return option
  })
}

/** What delivery costs for an order, and how far the order is from free delivery. */
export interface ShippingQuote {
  /** What the region charges for this order, in currency units. 0 when it is free. */
  amount: number
  /**
   * How much more makes delivery free, in currency units: 0 once it is, null when the region has
   * no "free from" amount.
   */
  missing: number | null
}

/**
 * What a region charges for goods adding up to `subtotal`, for the cart page. The checkout works
 * it out again on the server. It goes by the goods before any promotion code: a code is typed on
 * Stripe's page, after the delivery charge is set.
 */
export function shippingQuote(
  region: Pick<ShippingRegion, 'rate' | 'freeFrom'>,
  subtotal: number,
): ShippingQuote {
  if (region.freeFrom === undefined) return {amount: region.rate, missing: null}
  // Amounts are typed with a few decimals; a sum of them can land a hair under the amount.
  const missing = Math.round((region.freeFrom - subtotal) * 10000) / 10000
  return missing <= 0 ? {amount: 0, missing: 0} : {amount: region.rate, missing}
}
