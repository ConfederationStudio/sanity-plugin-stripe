import {createStripe} from 'sanity-plugin-stripe/server'

const key = process.env.STRIPE_SECRET_KEY

/** The Stripe client, or null before `.env.local` has a key: the routes then answer 503. */
export const stripe = key ? createStripe(key) : null

/** Tags this site's Checkout Sessions in the Stripe Dashboard. */
export const INTEGRATION_IDENTIFIER = 'stripe_plugin_test_qhzvmkpt'
