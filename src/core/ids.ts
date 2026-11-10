/** Schema type names. They are saved in content, so they never change. */
export const COMMERCE_TYPE = 'stripeCommerce'
export const VARIANT_TYPE = 'stripeVariant'
export const SHIPPING_REGION_TYPE = 'stripeShippingRegion'
export const SHOP_SETTINGS_TYPE = 'stripeShopSettings'

/**
 * The one shop settings document, named after its type. Its id has no dot, so the site reads it
 * without a token: it holds what the cart shows anyway.
 */
export const SHOP_SETTINGS_ID = 'stripeShopSettings'

/**
 * A product's stock counts. They are kept out of the product document, which anyone can read
 * from a public dataset: a dot in an id means Sanity serves the document to members and tokens
 * only.
 */
export const STOCK_TYPE = 'stripe.stock'

export function stockId(productId: string): string {
  return `stripe.stock.${productId}`
}

/**
 * What one paid Checkout Session did to stock, written in the same transaction as the change, so
 * the same payment never lowers stock twice. It holds product ids and counts, nothing about the
 * buyer, and is deleted after a month.
 */
export const STOCK_CHANGE_TYPE = 'stripe.stockChange'

export function stockChangeId(sessionId: string): string {
  return `stripe.stockChange.${sessionId.replaceAll(/[^\w-]/g, '-')}`
}

/** The id a product is published under, whichever version of it a form is editing. */
export function publishedId(documentId: string): string {
  if (documentId.startsWith('drafts.')) return documentId.slice('drafts.'.length)
  if (documentId.startsWith('versions.')) return documentId.split('.').slice(2).join('.')
  return documentId
}
