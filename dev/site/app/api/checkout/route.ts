import {checkoutRoute} from 'sanity-plugin-stripe/server'

import {CURRENCY} from '../../../lib/env'
import {reader, stockClient} from '../../../lib/sanity'
import {INTEGRATION_IDENTIFIER, stripe} from '../../../lib/stripe'

/** Starts Stripe Checkout for the cart the browser posts. */
export const POST = checkoutRoute({
  stripe,
  client: reader,
  stockClient,
  currency: CURRENCY,
  successUrl: '/thanks?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: '/cart',
  integrationIdentifier: INTEGRATION_IDENTIFIER,
  taxRates: {
    reduced: process.env.STRIPE_TAX_RATE_REDUCED,
    standard: process.env.STRIPE_TAX_RATE_STANDARD,
  },
  debug: process.env.NODE_ENV !== 'production',
})
