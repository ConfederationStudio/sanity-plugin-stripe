import {studioRoutes} from 'sanity-plugin-stripe/server'

import {projectId} from '../../../../lib/env'
import {INTEGRATION_IDENTIFIER, stripe} from '../../../../lib/stripe'

/**
 * What the Studio's Orders tab asks: the shop's orders, read from Stripe for a signed-in editor
 * of the Sanity project. The Studio is on this site, so no other address has to be let in.
 */
export const {GET, OPTIONS} = studioRoutes({
  stripe,
  integrationIdentifier: INTEGRATION_IDENTIFIER,
  // Before `.env.local` names a project there is no Studio to ask from either.
  projectId: projectId || 'no-project',
})
