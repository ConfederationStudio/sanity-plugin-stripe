import {CreditCardIcon} from '@sanity/icons/CreditCard'
import {TagIcon} from '@sanity/icons/Tag'
import {defineArrayMember, defineField, defineType} from 'sanity'

import type {Availability} from '../../core/cart'
import {isObject} from '../../core/guards'
import {COMMERCE_TYPE, VARIANT_TYPE} from '../../core/ids'
import {moneyTitle, type ResolvedConfig} from '../config'
import {CommerceInput} from '../StockInput'

const AVAILABILITY: Array<{title: string; value: Availability}> = [
  {title: 'On sale', value: 'onSale'},
  {title: 'Sold out', value: 'soldOut'},
]

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
  variants?: StripeVariantValue[]
}

// The field's own value, as validation gets it: unknown, and maybe half filled in.
const isOnSale = (commerce: unknown) => isObject(commerce) && commerce.availability === 'onSale'

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
        name: 'variants',
        type: 'array',
        description: 'Sizes or colours. Each variant can sell out on its own.',
        of: [defineArrayMember({type: VARIANT_TYPE})],
      }),
    ],
  })
}
