/** Schema type names. They are saved in content, so they never change. */
export const COMMERCE_TYPE = 'stripeCommerce'
export const VARIANT_TYPE = 'stripeVariant'
export const SHIPPING_REGION_TYPE = 'stripeShippingRegion'
export const SHOP_SETTINGS_TYPE = 'stripeShopSettings'

/** The one shop settings document. Its id has no dot, so the site reads it without a token. */
export const SHOP_SETTINGS_ID = 'shopSettings'

/**
 * Written once per paid Checkout Session when its stock is lowered, so the same payment never
 * lowers stock twice. It holds product ids and counts only, nothing about the buyer.
 */
export const STOCK_RECORD_TYPE = 'stripe.stockRecord'

/** The dot keeps Sanity from serving the record without a token. */
export function stockRecordId(sessionId: string): string {
  return `stripe.stock.${sessionId.replaceAll(/[^\w-]/g, '-')}`
}
