import {CreditCardIcon} from '@sanity/icons/CreditCard'
import {SyncIcon} from '@sanity/icons/Sync'
import {TagIcon} from '@sanity/icons/Tag'
import {defineArrayMember, defineField, defineType} from 'sanity'

import type {Availability, Interval} from '../../core/cart'
import {isObject} from '../../core/guards'
import {COMMERCE_TYPE, SUBSCRIPTION_TYPE, VARIANT_TYPE} from '../../core/ids'
import {moneyTitle, type ResolvedConfig} from '../config'
import {CommerceInput} from '../StockInput'

const AVAILABILITY: Array<{title: string; value: Availability}> = [
  {title: 'On sale', value: 'onSale'},
  {title: 'Sold out', value: 'soldOut'},
]

const UNITS: Array<{title: string; value: Interval['unit']}> = [
  {title: 'Weeks', value: 'week'},
  {title: 'Months', value: 'month'},
]

/** Stripe charges a subscription at least once every three years. */
const LONGEST: Record<Interval['unit'], number> = {week: 156, month: 36}

/** The subscription a product offers, as the Studio saves it. */
export interface StripeSubscriptionValue {
  enabled?: boolean
  /** Per delivery, in currency units. */
  price?: number
  /** With `unit`: 6 and `week` is every 6 weeks. */
  every?: number
  unit?: Interval['unit']
}

/** A variant as the Studio saves it. */
export interface StripeVariantValue {
  _key: string
  label: string
  availability?: Availability
}

/**
 * The price-and-availability field as the Studio saves it, on a document anyone can read. Stock
 * counts are not in it: they are kept in a private document of their own.
 */
export interface StripeCommerceValue {
  availability: Availability
  /** In currency units (25 means €25). */
  price?: number
  taxClass?: string
  subscription?: StripeSubscriptionValue
  variants?: StripeVariantValue[]
}

// The field's own value, as validation gets it: unknown, and maybe half filled in.
const isOnSale = (commerce: unknown) => isObject(commerce) && commerce.availability === 'onSale'
const isOffered = (subscription: unknown) => isObject(subscription) && subscription.enabled === true

export function createSubscriptionType(config: ResolvedConfig) {
  return defineType({
    name: SUBSCRIPTION_TYPE,
    title: 'Subscription',
    type: 'object',
    icon: SyncIcon,
    fields: [
      defineField({
        name: 'enabled',
        title: 'Offer a subscription',
        type: 'boolean',
        description:
          'Buyers can choose to get this again and again, charged with each delivery, until they cancel.',
        initialValue: false,
      }),
      defineField({
        name: 'price',
        title: moneyTitle('Price per delivery', config),
        type: 'number',
        hidden: ({parent}) => !isOffered(parent),
        validation: (rule) =>
          rule
            .min(0)
            .precision(config.priceDecimals)
            .custom((price, context) =>
              isOffered(context.parent) && typeof price !== 'number'
                ? 'A subscription needs a price.'
                : true,
            ),
      }),
      defineField({
        name: 'every',
        title: 'Delivered every',
        type: 'number',
        description: 'A whole number: 6 with "Weeks" below is every 6 weeks.',
        hidden: ({parent}) => !isOffered(parent),
        validation: (rule) =>
          rule
            .integer()
            .min(1)
            .custom((every, context) => {
              const parent: unknown = context.parent
              if (!isOffered(parent)) return true
              if (typeof every !== 'number') return 'Say how often it is delivered.'
              const unit = isObject(parent) && parent.unit === 'month' ? 'month' : 'week'
              return every > LONGEST[unit]
                ? 'Stripe charges a subscription at least once every three years.'
                : true
            }),
      }),
      defineField({
        name: 'unit',
        title: 'Weeks or months',
        type: 'string',
        options: {list: UNITS, layout: 'radio', direction: 'horizontal'},
        initialValue: 'week',
        hidden: ({parent}) => !isOffered(parent),
        validation: (rule) =>
          rule.custom((unit, context) =>
            isOffered(context.parent) && unit !== 'week' && unit !== 'month'
              ? 'Choose weeks or months.'
              : true,
          ),
      }),
    ],
  })
}

export function createVariantType() {
  return defineType({
    name: VARIANT_TYPE,
    title: 'Variant',
    type: 'object',
    icon: TagIcon,
    fields: [
      defineField({
        name: 'label',
        type: 'string',
        description: 'What the buyer chooses, for example "Black, L".',
        validation: (rule) => rule.required(),
      }),
      defineField({
        name: 'availability',
        type: 'string',
        options: {list: AVAILABILITY, layout: 'radio', direction: 'horizontal'},
        initialValue: 'onSale',
      }),
    ],
    preview: {
      select: {title: 'label', availability: 'availability'},
      prepare: ({title, availability}) => ({
        title,
        subtitle: availability === 'soldOut' ? 'Sold out' : 'On sale',
      }),
    },
  })
}

export function createCommerceType(config: ResolvedConfig) {
  const taxClasses = config.tax.classes
  return defineType({
    name: COMMERCE_TYPE,
    title: 'Price and stock',
    type: 'object',
    icon: CreditCardIcon,
    // Adds the stock boxes, which are saved outside this document.
    components: {input: CommerceInput},
    fields: [
      defineField({
        name: 'availability',
        type: 'string',
        options: {list: AVAILABILITY, layout: 'radio', direction: 'horizontal'},
        initialValue: 'onSale',
        validation: (rule) => rule.required(),
      }),
      defineField({
        name: 'price',
        title: moneyTitle('Price', config),
        type: 'number',
        validation: (rule) =>
          rule
            .min(0)
            .precision(config.priceDecimals)
            .custom((price, context) =>
              isOnSale(context.parent) && typeof price !== 'number'
                ? 'A product on sale needs a price.'
                : true,
            ),
      }),
      ...(taxClasses.length
        ? [
            defineField({
              name: 'taxClass',
              title: config.tax.label.charAt(0).toUpperCase() + config.tax.label.slice(1),
              type: 'string',
              options: {
                list: taxClasses.map(({title, value}) => ({title, value})),
                layout: 'radio',
              },
              initialValue: taxClasses[0]?.value,
              validation: (rule) => rule.required(),
            }),
          ]
        : []),
      defineField({
        name: 'subscription',
        title: 'Subscribe and save',
        type: SUBSCRIPTION_TYPE,
      }),
      defineField({
        name: 'variants',
        type: 'array',
        description: 'Sizes or colours. Each variant can sell out on its own.',
        of: [defineArrayMember({type: VARIANT_TYPE})],
      }),
    ],
  })
}
