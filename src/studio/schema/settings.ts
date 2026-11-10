import {CogIcon} from '@sanity/icons/Cog'
import {PinIcon} from '@sanity/icons/Pin'
import {defineArrayMember, defineField, defineType} from 'sanity'

import {asArray, isObject} from '../../core/guards'
import {SHIPPING_REGION_TYPE, SHOP_SETTINGS_TYPE} from '../../core/ids'
import {formatPrice} from '../../core/money'
import {moneyTitle, type ResolvedConfig} from '../config'

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
}

/** The shop settings document as the Studio saves it. */
export interface ShopSettingsValue {
  shippingRegions?: ShippingRegionValue[]
  orderEmail?: string
  autoSoldOut?: boolean
}

// A region as validation and `hidden` get it: unknown, and maybe half filled in.
const coversEverywhereElse = (region: unknown) => isObject(region) && region.everywhereElse === true

/** The regions from the plugin's options, as the first shop settings document starts with them. */
export function initialRegions(config: ResolvedConfig): ShippingRegionValue[] {
  return config.shop.shippingRegions.map((region, index) => ({
    _key: `region-${index + 1}`,
    _type: SHIPPING_REGION_TYPE,
    title: region.title,
    ...(region.everywhereElse
      ? {everywhereElse: true}
      : {countries: [...(region.countries ?? [])]}),
    rate: region.rate,
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
    ],
    preview: {
      select: {
        title: 'title',
        rate: 'rate',
        countries: 'countries',
        everywhereElse: 'everywhereElse',
      },
      prepare: ({title, rate, countries, everywhereElse}) => ({
        title,
        subtitle: [
          typeof rate === 'number' ? formatPrice(rate, config.currency) : 'No rate',
          everywhereElse ? 'every other country' : `${asArray(countries).length} countries`,
        ].join(' · '),
      }),
    },
  })
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
        type: 'array',
        description:
          'Buyers choose one in the cart. Its rate is added at checkout, and Stripe only accepts addresses in its countries.',
        of: [defineArrayMember({type: SHIPPING_REGION_TYPE})],
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
        name: 'orderEmail',
        title: 'Order email',
        type: 'string',
        description: 'Where new orders are sent.',
        ...(config.shop.orderEmail ? {initialValue: config.shop.orderEmail} : {}),
        validation: (rule) => rule.required().email(),
      }),
      defineField({
        name: 'autoSoldOut',
        title: 'Sell out automatically',
        type: 'boolean',
        description: 'When a product or variant with a stock count reaches 0, mark it sold out.',
        initialValue: true,
      }),
    ],
    preview: {prepare: () => ({title: 'Shop settings'})},
  })
}
