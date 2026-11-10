import {createStripe} from 'sanity-plugin-stripe/server'

const key = process.env.STRIPE_SECRET_KEY

/** The Stripe client, or null before `.env.local` has a key: the routes then answer 503. */
export const stripe = key ? createStripe(key) : null

/**
 * Marks this site's Checkout Sessions. The webhook fulfils only sessions that carry it, and the
 * Stripe Dashboard groups them by it.
 */
export const INTEGRATION_IDENTIFIER = 'stripe_plugin_test_qhzvmkpt'
