import {portalRoute} from 'sanity-plugin-stripe/server'

import {stripe} from '../../lib/stripe'

/**
 * Sends a subscriber to Stripe's customer portal, to change their card or address, pause or
 * cancel. They sign in there with their email; the site keeps no accounts.
 */
export const GET = portalRoute({stripe})
