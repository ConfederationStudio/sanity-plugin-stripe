import type Stripe from 'stripe'

import type {Interval} from '../core/cart'
import {DELIVERY_KEY} from './checkout'

export interface OrderItem {
  /** Sanity document id of the product. */
  productId?: string
  variantKey?: string
  name: string
  quantity: number
  /** For the whole line, in the currency's minor unit (cents). */
  amountTotal: number
  /** True on a line that is a subscription: it is delivered and charged again. */
  subscription?: boolean
}

/**
 * A paid order, read into what a shop needs to send it: a paid Checkout Session, or a renewal of
 * a subscription that one started. It is never saved in Sanity.
 */
export interface Order {
  /** The Checkout Session that took the order. For a renewal, the one that started the subscription. */
  sessionId: string
  paymentIntentId: string | null
  /** Set on a renewal: the invoice Stripe charged for it. */
  invoiceId?: string
  /** Set when the order started a subscription, and on each of its renewals. */
  subscription?: {
    id: string
    /** Null when Stripe holds an interval the plugin doesn't offer, such as days. */
    interval: Interval | null
  }
  /** False for a payment made in a sandbox or in test mode. */
  livemode: boolean
  currency: string
  /** Including shipping, in the currency's minor unit. */
  amountTotal: number
  amountShipping: number
  regionId?: string
  regionTitle?: string
  customer: {name: string | null; email: string | null; phone: string | null}
  shipping: {name: string | null; address: Stripe.Address | null}
  items: OrderItem[]
  createdAt: Date
}

function readInterval(recurring: Stripe.Price.Recurring | null | undefined): Interval | null {
  if (!recurring) return null
  const every = recurring.interval_count
  if (recurring.interval === 'week') return {unit: 'week', every}
  return recurring.interval === 'month' ? {unit: 'month', every} : null
}

const metadataOf = (product: string | Stripe.Product | Stripe.DeletedProduct | undefined) =>
  product && typeof product === 'object' && !product.deleted ? product.metadata : {}

const idOf = (value: string | {id: string} | null | undefined) =>
  typeof value === 'string' ? value : (value?.id ?? null)

/** Reads a completed session and its line items into an order. */
export async function getOrder(stripe: Stripe, session: Stripe.Checkout.Session): Promise<Order> {
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 100,
    expand: ['data.price.product'],
  })
  const items: OrderItem[] = []
  let interval: Interval | null = null
  // A subscription's delivery charge is a line of its own: it is shipping, not something to pack.
  let delivery = 0
  for (const item of lineItems.data) {
    const metadata = metadataOf(item.price?.product)
    if (metadata[DELIVERY_KEY]) {
      delivery += item.amount_total
      continue
    }
    const ordered: OrderItem = {
      name: item.description ?? 'Item',
      quantity: item.quantity ?? 1,
      amountTotal: item.amount_total,
    }
    if (metadata.productId) ordered.productId = metadata.productId
    if (metadata.variantKey) ordered.variantKey = metadata.variantKey
    if (item.price?.recurring) {
      ordered.subscription = true
      interval ??= readInterval(item.price.recurring)
    }
    items.push(ordered)
  }
  const shippingDetails = session.collected_information?.shipping_details
  const subscriptionId = idOf(session.subscription)
  return {
    sessionId: session.id,
    paymentIntentId: idOf(session.payment_intent),
    ...(subscriptionId ? {subscription: {id: subscriptionId, interval}} : {}),
    livemode: session.livemode,
    currency: session.currency ?? '',
    amountTotal: session.amount_total ?? 0,
    amountShipping: (session.shipping_cost?.amount_total ?? 0) + delivery,
    ...(session.metadata?.region ? {regionId: session.metadata.region} : {}),
    ...(session.metadata?.regionTitle ? {regionTitle: session.metadata.regionTitle} : {}),
    customer: {
      name: session.customer_details?.name ?? null,
      email: session.customer_details?.email ?? null,
      phone: session.customer_details?.phone ?? null,
    },
    shipping: {name: shippingDetails?.name ?? null, address: shippingDetails?.address ?? null},
    items,
    createdAt: new Date(session.created * 1000),
  }
}

/**
 * Reads a paid renewal into an order: what the subscription sends again, and where. The address
 * is the customer's as it is now, so one changed in the customer portal is the one used.
 *
 * `session` is the Checkout Session that started the subscription.
 */
export async function getRenewal(
  stripe: Stripe,
  invoice: Stripe.Invoice,
  session: Stripe.Checkout.Session,
  subscriptionId: string,
): Promise<Order> {
  // An invoice line names its Stripe product by id. The subscription's items carry the products
  // themselves, with the Sanity ids the checkout put in their metadata.
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price.product'],
  })
  const sold = new Map<
    string,
    {name: string; metadata: Stripe.Metadata; interval: Interval | null}
  >()
  for (const item of subscription.items.data) {
    const {product, recurring} = item.price
    if (typeof product === 'object' && !product.deleted)
      sold.set(product.id, {
        name: product.name,
        metadata: product.metadata,
        interval: readInterval(recurring),
      })
  }

  const items: OrderItem[] = []
  let interval: Interval | null = null
  let delivery = 0
  for (const line of invoice.lines.data) {
    const product = sold.get(line.pricing?.price_details?.product ?? '')
    if (product?.metadata[DELIVERY_KEY]) {
      delivery += line.amount
      continue
    }
    const ordered: OrderItem = {
      name: product?.name ?? line.description ?? 'Item',
      quantity: line.quantity ?? 1,
      amountTotal: line.amount,
      subscription: true,
    }
    if (product?.metadata.productId) ordered.productId = product.metadata.productId
    if (product?.metadata.variantKey) ordered.variantKey = product.metadata.variantKey
    interval ??= product?.interval ?? null
    items.push(ordered)
  }

  const started = session.collected_information?.shipping_details
  const where = invoice.parent?.subscription_details?.metadata ?? session.metadata
  return {
    sessionId: session.id,
    paymentIntentId: null,
    invoiceId: invoice.id,
    subscription: {id: subscriptionId, interval},
    livemode: invoice.livemode,
    currency: invoice.currency,
    amountTotal: invoice.total,
    amountShipping: delivery,
    ...(where?.region ? {regionId: where.region} : {}),
    ...(where?.regionTitle ? {regionTitle: where.regionTitle} : {}),
    customer: {
      name: invoice.customer_name,
      email: invoice.customer_email,
      phone: invoice.customer_phone,
    },
    shipping: {
      name: invoice.customer_shipping?.name ?? started?.name ?? null,
      address: invoice.customer_shipping?.address ?? started?.address ?? null,
    },
    items,
    createdAt: new Date((invoice.status_transitions.paid_at ?? invoice.created) * 1000),
  }
}
