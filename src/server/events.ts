import type Stripe from 'stripe'

/** Checks the signature and parses the event. Throws when the signature doesn't match. */
export function verifyEvent(
  stripe: Stripe,
  payload: string,
  signature: string | null,
  secret: string,
): Stripe.Event {
  if (!signature) throw new Error('Missing Stripe-Signature header')
  return stripe.webhooks.constructEvent(payload, signature, secret)
}

export type CheckoutEvent =
  /** Paid: fulfil the order. */
  | {type: 'paid'; session: Stripe.Checkout.Session}
  /** Completed, but a delayed payment method hasn't settled yet. Wait for async_payment_succeeded. */
  | {type: 'pending'; session: Stripe.Checkout.Session}
  /** A delayed payment failed. Nothing to fulfil. */
  | {type: 'failed'; session: Stripe.Checkout.Session}
  /** An invoice was paid. One that renews a subscription is fulfilled like an order. */
  | {type: 'invoicePaid'; invoice: Stripe.Invoice}
  /** A payment for an invoice failed. Stripe tries again and writes to the customer itself. */
  | {type: 'invoiceFailed'; invoice: Stripe.Invoice}
  /** A subscription ended: cancelled, or given up on after failed payments. */
  | {type: 'subscriptionEnded'; subscription: Stripe.Subscription}
  | {type: 'ignored'}

/**
 * The events a webhook endpoint for the shop listens to. The last three are for subscriptions; a
 * shop without any can leave them out.
 */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.deleted',
] as const

/** What a webhook event means for the shop. Only `paid` and a renewal's `invoicePaid` are fulfilled. */
export function classifyEvent(event: Stripe.Event): CheckoutEvent {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object
      return session.payment_status === 'unpaid'
        ? {type: 'pending', session}
        : {type: 'paid', session}
    }
    case 'checkout.session.async_payment_failed':
      return {type: 'failed', session: event.data.object}
    case 'invoice.paid':
      return {type: 'invoicePaid', invoice: event.data.object}
    case 'invoice.payment_failed':
      return {type: 'invoiceFailed', invoice: event.data.object}
    case 'customer.subscription.deleted':
      return {type: 'subscriptionEnded', subscription: event.data.object}
    default:
      return {type: 'ignored'}
  }
}
