import {orderEmail, webhookRoute} from 'sanity-plugin-stripe/server'

import {reader, writer} from '../../../../lib/sanity'
import {stripe} from '../../../../lib/stripe'

/**
 * Stripe calls this when a Checkout Session is paid: stock goes down and the order is handed to
 * `onOrder`. A real site sends the email with its email service; the test site prints it.
 */
export const POST = webhookRoute({
  stripe,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  client: reader,
  writeClient: writer,
  onOrder(order, {settings, stock}) {
    const email = orderEmail(order, {shopName: 'Plugin test shop', stock})
    process.stdout.write(
      [
        '[order email] Not sent: the test site has no email service.',
        `To: ${settings?.orderEmail ?? '(no order email in the shop settings)'}`,
        `Subject: ${email.subject}`,
        '',
        email.text,
        '',
      ].join('\n'),
    )
  },
})
