import type Stripe from 'stripe'

import {
  lineName,
  lineStatus,
  MAX_QUANTITY,
  sanitizeLines,
  type CartLine,
  type CartProduct,
  type CheckoutProblem,
} from '../core/cart'
import {toMinorUnits} from '../core/money'
import {resolveRegions, type ShippingRegion} from '../core/regions'
import {stockLeft, type ProductStock} from '../core/stock'

/**
 * Builds a Checkout Session from the cart and fresh product data. Nothing here trusts a price
 * sent by the browser: the cart holds references, and prices come from `products`.
 */

type SessionParams = Stripe.Checkout.SessionCreateParams
type LineItemParams = Stripe.Checkout.SessionCreateParams.LineItem

export interface CheckoutInput {
  /** The cart as the browser sent it. Checked here, so pass the raw value. */
  lines: unknown
  /** The shipping region the buyer chose, as the browser sent it. */
  regionId: unknown
  /** Fresh product data (not from a CDN cache) for every product in the cart. */
  products: readonly CartProduct[]
  /** Stock by product id, from `readStock`. Without it nothing is counted. */
  stock?: ReadonlyMap<string, ProductStock>
  /** Shipping regions from the shop settings, before `resolveRegions`. */
  regions: readonly ShippingRegion[]
  /** ISO 4217 code, such as `eur`. */
  currency: string
  successUrl: string
  cancelUrl: string
  /** Marks the session as this shop's, for the webhook and the Stripe Dashboard. */
  integrationIdentifier: string
  /** Stripe tax rate ids (`txr_…`) by tax class, so receipts show the tax. */
  taxRates?: Partial<Record<string, string>>
  /** Most of one item a buyer can order at once. Default 10. */
  maxQuantity?: number
  /** Don't say how many are left when a cart asks for too many. */
  hideRemaining?: boolean
  /** When the session stops taking payment, as a Unix time. Stripe's default is 24 hours on. */
  expiresAt?: number
}

export type CheckoutResult =
  | {ok: true; params: SessionParams; lines: CartLine[]; region: ShippingRegion}
  | {ok: false; error: 'empty' | 'region' | 'unavailable'; problems: CheckoutProblem[]}

export function buildCheckoutSession(input: CheckoutInput): CheckoutResult {
  const max = input.maxQuantity ?? MAX_QUANTITY
  const currency = input.currency.toLowerCase()
  const lines = sanitizeLines(input.lines, max)
  if (!lines.length) return {ok: false, error: 'empty', problems: []}

  const region = resolveRegions(input.regions).find((candidate) => candidate.id === input.regionId)
  if (!region) return {ok: false, error: 'region', problems: []}

  const products = new Map(input.products.map((product) => [product._id, product]))
  const problems: CheckoutProblem[] = []
  const lineItems: LineItemParams[] = []

  for (const line of lines) {
    const product = products.get(line.productId)
    const status = lineStatus(product, line.variantKey, max)
    const ref = {
      productId: line.productId,
      ...(line.variantKey ? {variantKey: line.variantKey} : {}),
    }
    if (!product || !status.available) {
      problems.push({
        ...ref,
        ...(product?.title ? {name: product.title} : {}),
        reason: status.available ? 'missing' : status.reason,
      })
      continue
    }
    const name = lineName(product, status.variant)

    // Counts are private, so this is the one place a buyer meets them.
    const left = stockLeft(input.stock?.get(line.productId), line.variantKey)
    if (left !== null && left <= 0) {
      problems.push({...ref, name, reason: 'soldOut'})
      continue
    }
    const most = left === null ? status.maxQuantity : Math.min(status.maxQuantity, left)
    if (line.quantity > most) {
      problems.push({
        ...ref,
        name,
        reason: 'tooMany',
        ...(input.hideRemaining ? {} : {maxQuantity: most}),
      })
      continue
    }

    const taxClass = product.commerce?.taxClass
    const taxRate = taxClass ? input.taxRates?.[taxClass] : undefined
    lineItems.push({
      quantity: line.quantity,
      price_data: {
        currency,
        unit_amount: toMinorUnits(status.price, currency),
        product_data: {
          name,
          ...(product.imageUrl ? {images: [product.imageUrl]} : {}),
          // Read back by the webhook, to know which product and variant was bought.
          metadata: ref,
        },
      },
      ...(taxRate ? {tax_rates: [taxRate]} : {}),
    })
  }

  if (problems.length) return {ok: false, error: 'unavailable', problems}

  return {
    ok: true,
    lines,
    region,
    params: {
      mode: 'payment',
      line_items: lineItems,
      // No payment method list: Stripe shows what the Dashboard has switched on.
      shipping_address_collection: {allowed_countries: region.countries},
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            display_name: region.title,
            fixed_amount: {amount: toMinorUnits(region.rate, currency), currency},
          },
        },
      ],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: {region: region.id, regionTitle: region.title},
      integration_identifier: input.integrationIdentifier,
      ...(input.expiresAt ? {expires_at: input.expiresAt} : {}),
    },
  }
}
