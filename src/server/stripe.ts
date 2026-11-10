import {Stripe} from 'stripe'

import {VERSION} from '../version'

/** The Stripe API version the plugin is written and tested against (stripe-node 23). */
export const STRIPE_API_VERSION = '2026-10-28.endive'

/**
 * A Stripe client pinned to the API version the plugin is tested against, so a Stripe upgrade
 * never changes the API under the shop. Pass the key from the site's environment, never from code:
 *
 * ```ts
 * const stripe = process.env.STRIPE_SECRET_KEY ? createStripe(process.env.STRIPE_SECRET_KEY) : null
 * ```
 *
 * A restricted key (`rk_…`) is enough, and safer than a secret key. `config` takes the rest of
 * stripe-node's options, such as `maxNetworkRetries` or `httpClient`.
 */
export function createStripe(
  secretKey: string,
  config: Omit<Stripe.StripeConfig, 'apiVersion' | 'appInfo'> = {},
): Stripe {
  return new Stripe(secretKey, {
    ...config,
    apiVersion: STRIPE_API_VERSION,
    appInfo: {
      name: 'sanity-plugin-stripe',
      version: VERSION,
      url: 'https://github.com/ConfederationStudio/sanity-plugin-stripe',
    },
  })
}
