import {CogIcon} from '@sanity/icons/Cog'
import {PinIcon} from '@sanity/icons/Pin'
import {defineArrayMember, defineField, defineType} from 'sanity'

import {asArray, isObject} from '../../core/guards'
import {SHIPPING_REGION_TYPE, SHOP_SETTINGS_TYPE} from '../../core/ids'
import {formatPrice} from '../../core/money'
import type {SubscriptionDelivery} from '../../core/regions'
import {moneyTitle, type ResolvedConfig} from '../config'
import {createRegionsInput} from '../RegionsInput'

/** A shipping region as the Studio saves it. */
export interface ShippingRegionValue {
  _key: string
  _type?: typeof SHIPPING_REGION_TYPE
  title: string
  /** Every country Stripe ships to that no other region lists. */
  everywhereElse?: boolean
  countries?: string[]
  /** Flat rate per order, in currency units. */
  rate: number
  /** Goods adding up to this amount or more are delivered free. In currency units. */
  freeFrom?: number
}

/**
 * The shop settings document as the Studio saves it. Anyone can read it from a public dataset,
 * so it holds only what the cart shows: no email address, no key.
 */
export interface ShopSettingsValue {
  shippingRegions?: ShippingRegionValue[]
  autoSoldOut?: boolean
  subscriptionDelivery?: SubscriptionDelivery
}

const SUBSCRIPTION_DELIVERY: Array<{title: string; value: SubscriptionDelivery}> = [
  {title: 'Free: delivery is in the subscription price', value: 'free'},
  {title: 'The region’s rate with every delivery', value: 'rate'},
]

// A region as validation and `hidden` get it: unknown, and maybe half filled in.
const coversEverywhereElse = (region: unknown) => isObject(region) && region.everywhereElse === true

/** The regions from the plugin's options, as the shop settings start with them. */
export function initialRegions(config: ResolvedConfig): ShippingRegionValue[] {
  return config.shop.shippingRegions.map((region, index) => ({
    _key: `region-${index + 1}`,
    _type: SHIPPING_REGION_TYPE,
    title: region.title,
    ...(region.everywhereElse
      ? {everywhereElse: true}
      : {countries: [...(region.countries ?? [])]}),
    rate: region.rate,
    ...(typeof region.freeFrom === 'number' ? {freeFrom: region.freeFrom} : {}),
  }))
}

export function createShippingRegionType(config: ResolvedConfig) {
  return defineType({
    name: SHIPPING_REGION_TYPE,
    title: 'Shipping region',
    type: 'object',
    icon: PinIcon,
    fields: [
      defineField({
        name: 'title',
        type: 'string',
        description: 'Shown in the cart, for example "European Union".',
        validation: (rule) => rule.required(),
      }),
      defineField({
        name: 'everywhereElse',
        title: 'Everywhere else',
        type: 'boolean',
        description: 'Covers every country Stripe ships to that no other region lists.',
        initialValue: false,
      }),
      defineField({
        name: 'countries',
        type: 'array',
        description:
          'Two-letter country codes, for example NL or DE. Stripe only accepts addresses in these countries.',
        of: [
          defineArrayMember({
            type: 'string',
            validation: (rule) =>
              rule
                .regex(/^[A-Z]{2}$/, {name: 'country code'})
                .error('Use a two-letter code in capitals.'),
          }),
        ],
        options: {layout: 'tags'},
        hidden: ({parent}) => coversEverywhereElse(parent),
        validation: (rule) =>
          rule.custom((countries, context) =>
            coversEverywhereElse(context.parent) || countries?.length
              ? true
              : 'Add at least one country.',
          ),
      }),
      defineField({
        name: 'rate',
        title: moneyTitle('Shipping', config),
        type: 'number',
        description: 'One flat rate per order.',
        validation: (rule) => rule.required().min(0).precision(config.priceDecimals),
      }),
      defineField({
        name: 'freeFrom',
        title: `Free from (${config.currencyLabel})`,
        type: 'number',
        description:
          'Optional. An order whose goods add up to this amount or more is delivered free. It goes by the goods before any promotion code.',
        validation: (rule) => rule.positive().precision(config.priceDecimals),
      }),
    ],
    preview: {
      select: {
        title: 'title',
        rate: 'rate',
        freeFrom: 'freeFrom',
        countries: 'countries',
        everywhereElse: 'everywhereElse',
      },
      prepare: ({title, rate, freeFrom, countries, everywhereElse}) => ({
        title,
        subtitle: [
          typeof rate === 'number' ? formatPrice(rate, config.currency) : 'No rate',
          ...(typeof freeFrom === 'number'
            ? [`free from ${formatPrice(freeFrom, config.currency)}`]
            : []),
          everywhereElse ? 'every other country' : countCountries(asArray(countries).length),
        ].join(' · '),
      }),
    },
  })
}

/** How many countries a region lists, for its line in the Studio. */
export function countCountries(count: number): string {
  return count === 1 ? '1 country' : `${count} countries`
}

export function createShopSettingsType(config: ResolvedConfig) {
  const regions = initialRegions(config)
  return defineType({
    name: SHOP_SETTINGS_TYPE,
    title: 'Shop settings',
    type: 'document',
    icon: CogIcon,
    fields: [
      defineField({
        name: 'shippingRegions',
        title: 'Shipping regions',
        type: 'array',
        description:
          'Buyers choose one in the cart. Its rate is added at checkout, and Stripe only accepts addresses in its countries.',
        of: [defineArrayMember({type: SHIPPING_REGION_TYPE})],
        components: {input: createRegionsInput(regions)},
        ...(regions.length ? {initialValue: regions} : {}),
        validation: (rule) =>
          rule
            .required()
            .min(1)
            .custom((value: ShippingRegionValue[] | undefined) => {
              if (!value) return true
              if (value.filter((region) => region.everywhereElse).length > 1) {
                return 'Only one region can cover everywhere else.'
              }
              const seen = new Map<string, string>()
              for (const region of value) {
                if (region.everywhereElse) continue
                for (const country of region.countries ?? []) {
                  const other = seen.get(country)
                  if (other) return `${country} is in both ${other} and ${region.title}.`
                  seen.set(country, region.title)
                }
              }
              return true
            }),
      }),
      defineField({
        name: 'autoSoldOut',
        title: 'Sell out automatically',
        type: 'boolean',
        description: 'When the stock count of a product or variant reaches 0, mark it sold out.',
        initialValue: true,
      }),
      defineField({
        name: 'subscriptionDelivery',
        title: 'Delivery for subscriptions',
        type: 'string',
        description:
          'Only matters when a product offers a subscription. With the region’s rate, the rate is charged with the first delivery and every one after it, unless the subscription reaches the region’s "free from" amount.',
        options: {list: SUBSCRIPTION_DELIVERY, layout: 'radio'},
        initialValue: 'free',
      }),
    ],
    preview: {prepare: () => ({title: 'Shop settings'})},
  })
}
