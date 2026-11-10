import {definePlugin} from 'sanity'

import {SHOP_SETTINGS_TYPE} from '../core/ids'
import {resolveConfig, type StripeCommerceConfig} from './config'
import {createCommerceType, createVariantType} from './schema/commerce'
import {createShippingRegionType, createShopSettingsType} from './schema/settings'

/** What an editor can do with the one shop settings document: not duplicate or delete it. */
const SETTINGS_ACTIONS = new Set(['publish', 'discardChanges', 'restore'])

/**
 * Selling with Stripe Checkout from the Studio: the `stripeCommerce` field (price, tax class,
 * availability, stock and variants) and the shop settings document (shipping regions, the order
 * email, selling out at 0).
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
  return {
    name: 'sanity-plugin-stripe',
    schema: {
      types: [
        createCommerceType(config),
        createVariantType(),
        createShippingRegionType(config),
        createShopSettingsType(config),
      ],
    },
    document: {
      // There is one shop settings document, made by opening it in the structure.
      newDocumentOptions: (previous) =>
        previous.filter((option) => option.templateId !== SHOP_SETTINGS_TYPE),
      actions: (previous, context) =>
        context.schemaType === SHOP_SETTINGS_TYPE
          ? previous.filter(({action}) => action && SETTINGS_ACTIONS.has(action))
          : previous,
    },
  }
})
