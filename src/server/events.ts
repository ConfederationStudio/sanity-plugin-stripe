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
  | {type: 'ignored'}

/** The events a webhook endpoint for the shop listens to. */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
] as const

/** What a webhook event means for the shop. Only `paid` is fulfilled. */
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
    default:
      return {type: 'ignored'}
  }
}
