/**
 * What the site's Studio routes and the Studio's Orders tab say to each other. Both import these,
 * so they can't drift apart. Orders are read from Stripe each time: none of this is saved in
 * Sanity.
 */

export interface OrderAddress {
  line1: string | null
  line2: string | null
  postalCode: string | null
  city: string | null
  state: string | null
  /** ISO 3166-1 alpha-2, such as `NL`. */
  country: string | null
}

/** `unpaid`: a delayed payment, such as a bank debit, that hasn't arrived or has failed. */
export type OrderStatus = 'paid' | 'unpaid'

export interface OrderSummary {
  /** A Checkout Session's id (`cs_…`), or for a subscription's renewal its invoice's (`in_…`). */
  id: string
  kind: 'order' | 'renewal'
  /** ISO 8601. */
  createdAt: string
  status: OrderStatus
  currency: string
  /** Including shipping, in the currency's minor unit (cents). */
  amountTotal: number
  customer: {name: string | null; email: string | null}
  /** Where it ships to: ISO 3166-1 alpha-2. */
  country: string | null
  /** True for an order that started a subscription, and for every renewal. */
  subscription: boolean
  /** False for a payment made in a sandbox or in test mode. */
  livemode: boolean
}

export interface OrdersReply {
  /** Newest first. */
  orders: OrderSummary[]
  /** What to ask for next, as `?before=`. Null when there are no older orders. */
  next: string | null
}

export interface OrderDetailItem {
  name: string
  quantity: number
  /** For the whole line, in the currency's minor unit. */
  amountTotal: number
  /** Sanity document id of the product. */
  productId?: string
  variantKey?: string
  subscription?: boolean
}

export interface OrderDetail extends OrderSummary {
  items: OrderDetailItem[]
  amountShipping: number
  regionTitle: string | null
  phone: string | null
  shipping: {name: string | null; address: OrderAddress | null}
  /** "every 6 weeks", for a subscription. */
  interval: string | null
  /** What was paid back, in the currency's minor unit. Null when the site's key may not ask. */
  amountRefunded: number | null
  /** When the site's own `onOrder` or `onRenewal` finished for it. ISO 8601. */
  handledAt: string | null
  /** The payment in the Stripe Dashboard. */
  stripeUrl: string
}

export interface OrderReply {
  order: OrderDetail
}

export type StudioRouteErrorCode =
  | 'signed-out'
  | 'not-member'
  | 'forbidden-origin'
  | 'forbidden-role'
  | 'no-stripe'
  | 'stripe-failed'
  | 'sanity-failed'
  | 'bad-request'
  | 'not-found'

export interface StudioRouteError {
  error: StudioRouteErrorCode
}

/** An address as lines to read or copy: name first, country code last. */
export function addressLines(name: string | null, address: OrderAddress | null): string[] {
  if (!address) return name ? [name] : []
  const city = [address.postalCode, address.city].filter(Boolean).join(' ')
  return [name, address.line1, address.line2, city, address.state, address.country].filter(
    (line): line is string => Boolean(line),
  )
}
