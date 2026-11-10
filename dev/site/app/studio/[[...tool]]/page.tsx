import {NextStudio} from 'next-sanity/studio'

import {projectId} from '../../../lib/env'
import config from '../../../sanity.config'

export const dynamic = 'force-static'
export {metadata, viewport} from 'next-sanity/studio'

/** The test Studio, inside the site. It needs a Sanity project; the shop's sample products don't. */
export default function StudioPage() {
  if (!projectId)
    return (
      <p style={{font: '1rem/1.5 system-ui, sans-serif', padding: '2rem'}}>
        The Studio needs a Sanity project. Set NEXT_PUBLIC_SANITY_PROJECT_ID in dev/site/.env.local
        and restart the site.
      </p>
    )
  return <NextStudio config={config} />
}
