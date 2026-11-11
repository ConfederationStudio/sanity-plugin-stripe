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
  promotionCodes: true,
  // To try a renewal: a customer on a Stripe test clock, whose time you can move forward. The
  // customer's delivery address is then saved from the checkout, as it is for a new customer.
  extend(params) {
    const customer = process.env.STRIPE_TEST_CUSTOMER
    return customer ? {...params, customer, customer_update: {shipping: 'auto'}} : params
  },
  taxRates: {
    reduced: process.env.STRIPE_TAX_RATE_REDUCED,
    standard: process.env.STRIPE_TAX_RATE_STANDARD,
  },
  debug: process.env.NODE_ENV !== 'production',
})
