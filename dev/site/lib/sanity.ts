import {createClient} from '@sanity/client'
import {
  cartProductProjection,
  type SanityReader,
  type SanityWriter,
} from 'sanity-plugin-stripe/server'

import {dataset, projectId} from './env'
import {standInReader, standInWriter} from './stand-in'

/** Without a Sanity project the shop sells sample products, kept in memory: see `stand-in.ts`. */
export const standIn = !projectId

/**
 * Reads straight from the API, not the CDN, so the checkout sees today's prices and stock. The
 * dataset is public, and products and the shop settings need no token.
 */
const client = standIn
  ? null
  : createClient({
      projectId,
      dataset,
      apiVersion: '2025-02-19',
      useCdn: false,
      perspective: 'published',
    })

const token = process.env.SANITY_API_WRITE_TOKEN

/** Reads products and the shop settings. */
export const reader: SanityReader = client ?? standInReader

/** Lowers stock counts when an order is paid, or null without a token. */
export const writer: SanityWriter | null = client
  ? token
    ? client.withConfig({token})
    : null
  : standInWriter

export const PRODUCTS_QUERY = `*[_type == "product" && defined(slug.current)] | order(title asc){${cartProductProjection()}}`

export const PRODUCT_QUERY = `*[_type == "product" && slug.current == $slug][0]{${cartProductProjection()}}`
