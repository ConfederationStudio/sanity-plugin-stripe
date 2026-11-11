import {orderEmail, webhookRoute, type Order, type OrderContext} from 'sanity-plugin-stripe/server'

import {reader, stockClient} from '../../../../lib/sanity'
import {INTEGRATION_IDENTIFIER, stripe} from '../../../../lib/stripe'

/** A real site sends the email with its email service; the test site prints it. */
function printEmail(order: Order, {stock, stockError}: OrderContext) {
  const email = orderEmail(order, {
    shopName: 'Plugin test shop',
    stock,
    ...(stockError ? {stockError} : {}),
  })
  process.stdout.write(
    [
      '[order email] Not sent: the test site has no email service.',
      `To: ${process.env.ORDER_EMAIL_TO ?? '(set ORDER_EMAIL_TO)'}`,
      `Subject: ${email.subject}`,
      '',
      email.text,
      '',
    ].join('\n'),
  )
}

/**
 * Stripe calls this when a Checkout Session is paid: stock goes down and the order is handed to
 * `onOrder`. A paid renewal of a subscription does the same and reaches `onRenewal`. The address
 * orders go to is the site's own setting, never something stored in Sanity.
 */
export const POST = webhookRoute({
  stripe,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  integrationIdentifier: INTEGRATION_IDENTIFIER,
  client: reader,
  stockClient,
  onOrder: printEmail,
  onRenewal: printEmail,
  onSubscriptionEnded(subscription) {
    process.stdout.write(`[subscription] ${subscription.id} ended.\n`)
  },
})
