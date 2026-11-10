import {evaluate, parse} from 'groq-js'
import type {SanityTransaction, SanityWriter} from 'sanity-plugin-stripe/server'

/**
 * Sample products for the test shop before it has a Sanity project. It answers the site's and the
 * plugin's own GROQ with groq-js, and applies the webhook's transactions the way Sanity does: all
 * or nothing, and no second document with the same id. It lives in memory, so stock goes back to
 * the sample values when the server restarts.
 */

type Doc = {_id: string; _type: string; [field: string]: unknown}

const product = (
  id: string,
  title: string,
  slug: string,
  commerce: Record<string, unknown>,
): Doc => ({
  _id: id,
  _type: 'product',
  title,
  slug: {_type: 'slug', current: slug},
  commerce: {_type: 'stripeCommerce', availability: 'onSale', ...commerce},
})

const SAMPLE: Doc[] = [
  product('magazine', 'Magazine, issue 1', 'magazine-issue-1', {
    price: 25,
    taxClass: 'reduced',
    stockCount: 3,
  }),
  // An unpublished edit: its stock count has to go down with the published one.
  product('drafts.magazine', 'Magazine, issue 1 (new title)', 'magazine-issue-1', {
    price: 25,
    taxClass: 'reduced',
    stockCount: 3,
  }),
  product('shirt', 'Shirt', 'shirt', {
    price: 29.5,
    taxClass: 'standard',
    variants: [
      {_key: 'm', _type: 'stripeVariant', label: 'M', stockCount: 1},
      {_key: 'l', _type: 'stripeVariant', label: 'L', stockCount: 5},
      {_key: 'xl', _type: 'stripeVariant', label: 'XL', availability: 'soldOut'},
    ],
  }),
  // No stock count: it never sells out by itself.
  product('poster', 'Poster', 'poster', {price: 12, taxClass: 'standard'}),
  {
    _id: 'shopSettings',
    _type: 'stripeShopSettings',
    shippingRegions: [
      {_key: 'nl', _type: 'stripeShippingRegion', title: 'Netherlands', countries: ['NL'], rate: 5},
      {
        _key: 'eu',
        _type: 'stripeShippingRegion',
        title: 'Germany, France and Belgium',
        countries: ['DE', 'FR', 'BE'],
        rate: 12,
      },
      {
        _key: 'world',
        _type: 'stripeShippingRegion',
        title: 'Rest of the world',
        everywhereElse: true,
        rate: 18,
      },
    ],
    orderEmail: 'orders@example.com',
    autoSoldOut: true,
  },
]

// One dataset for the whole server, whichever route or page asks.
const shared: typeof globalThis & {standInShop?: Map<string, Doc>} = globalThis
const dataset = () =>
  (shared.standInShop ??= new Map(SAMPLE.map((doc) => [doc._id, structuredClone(doc)])))

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The object and key a patch path such as `commerce.variants[_key=="m"].stockCount` points at. */
function fieldAt(doc: Doc, path: string): {holder: Record<string, unknown>; key: string} {
  const match = /^(\w+)(?:\.variants\[_key=="([\w-]+)"\])?\.(\w+)$/.exec(path)
  if (!match) throw new Error(`The stand-in dataset can't patch ${path}`)
  const [, field = '', variantKey, key = ''] = match
  const commerce = doc[field]
  if (!isObject(commerce)) throw new Error(`${doc._id} has no ${field}`)
  if (!variantKey) return {holder: commerce, key}
  const variants = Array.isArray(commerce.variants) ? commerce.variants : []
  const variant: unknown = variants.find(
    (candidate: unknown) => isObject(candidate) && candidate._key === variantKey,
  )
  if (!isObject(variant)) throw new Error(`${doc._id} has no variant ${variantKey}`)
  return {holder: variant, key}
}

/**
 * `raw` sees everything, as a client with a token and the raw perspective does. Without it the
 * client sees what the public does: no drafts, and nothing with a dot in its id.
 */
function standInClient(raw: boolean): SanityWriter {
  return {
    async fetch(query, params = {}) {
      const docs = [...dataset().values()].filter((doc) => raw || !doc._id.includes('.'))
      const result = await evaluate(parse(query, {params}), {dataset: docs, params})
      const value: unknown = await result.get()
      return value
    },
    withConfig: () => standInClient(true),
    transaction() {
      const steps: Array<(next: Map<string, Doc>) => void> = []
      const transaction: SanityTransaction = {
        create(document) {
          steps.push((next) => {
            if (next.has(document._id))
              throw Object.assign(new Error(`Document ${document._id} already exists`), {
                statusCode: 409,
              })
            next.set(document._id, structuredClone(document))
          })
          return transaction
        },
        patch(documentId, operations) {
          steps.push((next) => {
            const doc = next.get(documentId)
            if (!doc) throw new Error(`${documentId} not found`)
            for (const [path, amount] of Object.entries(operations.dec ?? {})) {
              const {holder, key} = fieldAt(doc, path)
              holder[key] = Number(holder[key]) - amount
            }
            for (const [path, value] of Object.entries(operations.set ?? {})) {
              const {holder, key} = fieldAt(doc, path)
              holder[key] = value
            }
          })
          return transaction
        },
        async commit() {
          // Work on a copy, so a failed step leaves the dataset as it was.
          const next = structuredClone(dataset())
          for (const step of steps) step(next)
          shared.standInShop = next
        },
      }
      return transaction
    },
  }
}

/** What the site reads with: published products and the shop settings. */
export const standInReader = standInClient(false)

/** What the webhook lowers stock with. */
export const standInWriter = standInClient(true)
