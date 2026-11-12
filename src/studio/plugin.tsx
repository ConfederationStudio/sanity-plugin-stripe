import {BasketIcon} from '@sanity/icons/Basket'
import {definePlugin} from 'sanity'

import {SHOP_SETTINGS_TYPE} from '../core/ids'
import {resolveConfig, type StripeCommerceConfig} from './config'
import {OrdersTool} from './OrdersTool'
import {createCommerceType, createSubscriptionType, createVariantType} from './schema/commerce'
import {createShippingRegionType, createShopSettingsType} from './schema/settings'

/** What an editor can do with the one shop settings document: not duplicate or delete it. */
const SETTINGS_ACTIONS = new Set(['publish', 'discardChanges', 'restore'])

/** There is one shop settings document, made by opening it in the structure: no "new" for it. */
export function withoutSettingsTemplate<T extends {templateId: string}>(options: T[]): T[] {
  return options.filter((option) => option.templateId !== SHOP_SETTINGS_TYPE)
}

/** The shop settings keep publish, discard and restore; every other document keeps everything. */
export function settingsActions<T extends {action?: string}>(
  actions: T[],
  schemaType: string,
): T[] {
  return schemaType === SHOP_SETTINGS_TYPE
    ? actions.filter(({action}) => action !== undefined && SETTINGS_ACTIONS.has(action))
    : actions
}

/**
 * Selling with Stripe Checkout from the Studio: the `stripeCommerce` field (price, tax class,
 * on sale or sold out, an optional subscription, variants, and stock counts kept out of the
 * public dataset) and the shop settings document (shipping regions, selling out at 0, delivery
 * for subscriptions). With `api`, an Orders tab too: the shop's orders, read from Stripe through
 * the site and never saved in Sanity.
 *
 * ```ts
 * plugins: [structureTool({structure}), stripeCommerce({currency: 'eur'})]
 * ```
 *
 * Give a product the field with `defineField({name: 'commerce', type: 'stripeCommerce'})`, and
 * put the settings in the structure with `shopSettingsListItem(S)`.
 */
export const stripeCommerce = definePlugin<StripeCommerceConfig>((options) => {
  const config = resolveConfig(options)
  const {api} = config
  return {
    name: 'sanity-plugin-stripe',
    tools: api
      ? [
          {
            name: 'orders',
            title: 'Orders',
            icon: BasketIcon,
            component: () => <OrdersTool api={api} />,
          },
        ]
      : [],
    schema: {
      types: [
        createCommerceType(config),
        createVariantType(),
        createSubscriptionType(config),
        createShippingRegionType(config),
        createShopSettingsType(config),
      ],
    },
    document: {
      newDocumentOptions: (previous) => withoutSettingsTemplate(previous),
      actions: (previous, context) => settingsActions(previous, context.schemaType),
    },
  }
})
