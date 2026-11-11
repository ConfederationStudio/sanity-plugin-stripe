import type Stripe from 'stripe'

import {
  lineName,
  lineStatus,
  MAX_QUANTITY,
  sanitizeLines,
  type CartLine,
  type CartProduct,
  type CheckoutProblem,
  type Interval,
} from '../core/cart'
import {toMinorUnits} from '../core/money'
import {resolveRegions, type ShippingRegion, type SubscriptionDelivery} from '../core/regions'
import {stockLeft, type ProductStock} from '../core/stock'

/**
 * Builds a Checkout Session from the cart and fresh product data. Nothing here trusts a price
 * sent by the browser: the cart holds references, and prices come from `products`.
 */

type SessionParams = Stripe.Checkout.SessionCreateParams
type LineItemParams = Stripe.Checkout.SessionCreateParams.LineItem

/** The key, in a Stripe product's metadata, that marks a subscription's delivery charge. */
export const DELIVERY_KEY = 'delivery'

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
  /** How a subscription pays for delivery, from the shop settings. Default `free`. */
  subscriptionDelivery?: SubscriptionDelivery
  /** Shows the field for a promotion code on Stripe's page. */
  promotionCodes?: boolean
}

export type CheckoutResult =
  | {ok: true; params: SessionParams; lines: CartLine[]; region: ShippingRegion}
  | {ok: false; error: 'empty' | 'region' | 'unavailable'; problems: CheckoutProblem[]}

const sameInterval = (a: Interval, b: Interval) => a.unit === b.unit && a.every === b.every

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
  // A product can be in the cart twice, bought once and subscribed to: both draw on one count.
  const taken = new Map<string, number>()
  // One checkout takes one interval: the first subscription in the cart sets it.
  let interval: Interval | undefined
  // In the currency's minor unit: everything in the cart, and the part of it that repeats.
  let goods = 0
  let repeating = 0

  for (const line of lines) {
    const product = products.get(line.productId)
    const status = lineStatus(product, line.variantKey, max, line.plan)
    const ref = {
      productId: line.productId,
      ...(line.variantKey ? {variantKey: line.variantKey} : {}),
    }
    const asked = {...ref, ...(line.plan ? {plan: line.plan} : {})}
    if (!product || !status.available) {
      problems.push({
        ...asked,
        ...(product?.title ? {name: product.title} : {}),
        reason: status.available ? 'missing' : status.reason,
      })
      continue
    }
    const name = lineName(product, status.variant)

    // Counts are private, so this is the one place a buyer meets them.
    const counted = stockLeft(input.stock?.get(line.productId), line.variantKey)
    const stockKey = `${line.productId}:${line.variantKey ?? ''}`
    const left = counted === null ? null : counted - (taken.get(stockKey) ?? 0)
    if (left !== null && left <= 0) {
      problems.push({...asked, name, reason: 'soldOut'})
      continue
    }
    const most = left === null ? status.maxQuantity : Math.min(status.maxQuantity, left)
    if (line.quantity > most) {
      problems.push({
        ...asked,
        name,
        reason: 'tooMany',
        ...(input.hideRemaining ? {} : {maxQuantity: most}),
      })
      continue
    }
    taken.set(stockKey, (taken.get(stockKey) ?? 0) + line.quantity)

    if (status.interval) {
      interval ??= status.interval
      if (!sameInterval(status.interval, interval)) {
        problems.push({...asked, name, reason: 'otherInterval'})
        continue
      }
    }

    const unitAmount = toMinorUnits(status.price, currency)
    goods += unitAmount * line.quantity
    if (status.interval) repeating += unitAmount * line.quantity

    const taxClass = product.commerce?.taxClass
    const taxRate = taxClass ? input.taxRates?.[taxClass] : undefined
    lineItems.push({
      quantity: line.quantity,
      price_data: {
        currency,
        unit_amount: unitAmount,
        ...(status.interval
          ? {recurring: {interval: status.interval.unit, interval_count: status.interval.every}}
          : {}),
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

  // Free delivery goes by the goods before any promotion code: the code is typed on Stripe's
  // page, after this charge is set.
  const rate = toMinorUnits(region.rate, currency)
  const freeFrom = region.freeFrom === undefined ? null : toMinorUnits(region.freeFrom, currency)
  const charge = (amount: number) => (freeFrom !== null && amount >= freeFrom ? 0 : rate)

  // Stripe has no shipping options for a subscription. Delivery is either in the subscription's
  // price, or a line of its own that repeats with it; then it goes by what each later parcel
  // holds, the lines that repeat.
  if (interval && input.subscriptionDelivery === 'rate' && charge(repeating) > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency,
        unit_amount: charge(repeating),
        recurring: {interval: interval.unit, interval_count: interval.every},
        product_data: {name: `Delivery: ${region.title}`, metadata: {[DELIVERY_KEY]: region.id}},
      },
    })
  }

  const where = {region: region.id, regionTitle: region.title}
  return {
    ok: true,
    lines,
    region,
    params: {
      mode: interval ? 'subscription' : 'payment',
      line_items: lineItems,
      // No payment method list: Stripe shows what the Dashboard has switched on.
      shipping_address_collection: {allowed_countries: region.countries},
      ...(interval
        ? {subscription_data: {metadata: where}}
        : {
            shipping_options: [
              {
                shipping_rate_data: {
                  type: 'fixed_amount',
                  display_name: region.title,
                  fixed_amount: {amount: charge(goods), currency},
                },
              },
            ],
          }),
      ...(input.promotionCodes ? {allow_promotion_codes: true} : {}),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: where,
      integration_identifier: input.integrationIdentifier,
      ...(input.expiresAt ? {expires_at: input.expiresAt} : {}),
    },
  }
}
