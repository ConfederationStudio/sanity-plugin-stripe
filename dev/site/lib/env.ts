/** The test shop's Sanity project, from `.env.local`. The site and the Studio at /studio share it. */
export const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ?? ''
export const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET ?? 'production'

/** The one currency every price is in. The Studio plugin and the checkout route both take it. */
export const CURRENCY = 'eur'
