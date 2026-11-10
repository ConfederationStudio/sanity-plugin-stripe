import type Stripe from 'stripe'

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
  const key = `fulfilled_${step}`
  if (session.metadata?.[key]) return 'skipped'
  await fn()
  await stripe.checkout.sessions.update(session.id, {
    metadata: {[key]: new Date().toISOString()},
  })
  return 'done'
}
