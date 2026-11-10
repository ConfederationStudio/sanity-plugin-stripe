/**
 * `sanity-plugin-stripe`: the Studio's side. The site imports `sanity-plugin-stripe/react` and
 * `sanity-plugin-stripe/server` instead.
 */
export {stripeCommerce} from './studio/plugin'
export type {ShippingRegionInput, StripeCommerceConfig, TaxClass} from './studio/config'
export type {StripeCommerceValue, StripeVariantValue} from './studio/schema/commerce'
export type {ShippingRegionValue, ShopSettingsValue} from './studio/schema/settings'
export {isShopSettingsListItem, shopSettingsListItem} from './studio/structure'

export type {Availability} from './core/cart'
export {EU_COUNTRIES} from './core/countries'
export {COMMERCE_TYPE, SHOP_SETTINGS_ID, SHOP_SETTINGS_TYPE} from './core/ids'
