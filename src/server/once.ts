import type Stripe from 'stripe'

/**
 * Runs a fulfilment step once per payment, even when Stripe delivers the event again. The step's
 * completion is recorded in the PaymentIntent's metadata, so a failed step is retried on the next
 * delivery while finished steps are skipped. The key needs Payment Intents: Write.
 *
 * Two deliveries arriving in the same moment can both run the step, so use it for steps where a
 * rare repeat is harmless, such as an email sent with an idempotency key. Stock is guarded on its
 * own, in `decrementStock`.
 */
export async function runOnce(
  stripe: Stripe,
  paymentIntentId: string | null,
  step: string,
  fn: () => Promise<void>,
): Promise<'done' | 'skipped'> {
  if (!paymentIntentId) {
    await fn()
    return 'done'
  }
  const key = `fulfilled_${step}`
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId)
  if (intent.metadata?.[key]) return 'skipped'
  await fn()
  await stripe.paymentIntents.update(paymentIntentId, {
    metadata: {[key]: new Date().toISOString()},
  })
  return 'done'
}
