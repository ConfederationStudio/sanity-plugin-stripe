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
}

/** The shop settings document, as `SHOP_SETTINGS_QUERY` returns it. */
export interface ShopSettings {
  shippingRegions?: Array<{
    _key: string
    title?: string | null
    everywhereElse?: boolean | null
    countries?: string[] | null
    rate?: number | null
  }> | null
  orderEmail?: string | null
  autoSoldOut?: boolean | null
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
            },
          ]
        : [],
    ),
    orderEmail: asString(value.orderEmail),
    autoSoldOut: typeof value.autoSoldOut === 'boolean' ? value.autoSoldOut : null,
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
export type RegionOption = Pick<ShippingRegion, 'id' | 'title' | 'rate'>

/** The regions a buyer can choose from, the same ones the checkout accepts. */
export function regionOptions(settings: ShopSettings | null | undefined): RegionOption[] {
  return resolveRegions(regionsFromSettings(settings)).map(({id, title, rate}) => ({
    id,
    title,
    rate,
  }))
}
