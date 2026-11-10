import type Stripe from 'stripe'

export interface OrderItem {
  /** Sanity document id of the product. */
  productId?: string
  variantKey?: string
  name: string
  quantity: number
  /** For the whole line, in the currency's minor unit (cents). */
  amountTotal: number
}

/** A paid Checkout Session, read into what a shop needs to send it. It is never saved in Sanity. */
export interface Order {
  sessionId: string
  paymentIntentId: string | null
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

/** Reads a completed session and its line items into an order. */
export async function getOrder(stripe: Stripe, session: Stripe.Checkout.Session): Promise<Order> {
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 100,
    expand: ['data.price.product'],
  })
  const items = lineItems.data.map((item): OrderItem => {
    const product = item.price?.product
    const metadata =
      product && typeof product === 'object' && !product.deleted ? product.metadata : {}
    const ordered: OrderItem = {
      name: item.description ?? 'Item',
      quantity: item.quantity ?? 1,
      amountTotal: item.amount_total,
    }
    if (metadata.productId) ordered.productId = metadata.productId
    if (metadata.variantKey) ordered.variantKey = metadata.variantKey
    return ordered
  })
  const shippingDetails = session.collected_information?.shipping_details
  const paymentIntent = session.payment_intent
  return {
    sessionId: session.id,
    paymentIntentId:
      typeof paymentIntent === 'string' ? paymentIntent : (paymentIntent?.id ?? null),
    livemode: session.livemode,
    currency: session.currency ?? '',
    amountTotal: session.amount_total ?? 0,
    amountShipping: session.shipping_cost?.amount_total ?? 0,
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
