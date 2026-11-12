import type Stripe from 'stripe'

const keyOf = (step: string) => `fulfilled_${step}`
const stamp = (step: string) => ({metadata: {[keyOf(step)]: new Date().toISOString()}})

/**
 * Runs a fulfilment step once per Checkout Session, even when Stripe delivers the event again.
 * The step's completion is recorded in the session's own metadata, so a failed step is retried on
 * the next delivery while finished steps are skipped. It works for free orders too, which have no
 * PaymentIntent.
 *
 * `session` must be read fresh from Stripe's API. Two deliveries arriving in the same moment can
 * both run the step, so it is for steps where a rare repeat is harmless, such as an email sent
 * with an idempotency key. Stock is guarded on its own, in `decrementStock`.
 */
export async function once(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  step: string,
  fn: () => Promise<void>,
): Promise<'done' | 'skipped'> {
  if (session.metadata?.[keyOf(step)]) return 'skipped'
  await fn()
  await stripe.checkout.sessions.update(session.id, stamp(step))
  return 'done'
}

/**
 * The same for a renewal: once per invoice, recorded in the invoice's metadata. `invoice` must be
 * read fresh from Stripe's API.
 */
export async function oncePerInvoice(
  stripe: Stripe,
  invoice: Stripe.Invoice,
  step: string,
  fn: () => Promise<void>,
): Promise<'done' | 'skipped'> {
  if (invoice.metadata?.[keyOf(step)]) return 'skipped'
  await fn()
  await stripe.invoices.update(invoice.id, stamp(step))
  return 'done'
}

/** When a step finished for a session or an invoice, as ISO 8601, or null when it hasn't. */
export function finishedAt(
  metadata: Stripe.Metadata | null | undefined,
  step: string,
): string | null {
  return metadata?.[keyOf(step)] || null
}
