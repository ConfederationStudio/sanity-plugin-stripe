import {evaluate, parse} from 'groq-js'
import type {SanityReader, SanityTransaction, SanityWriter} from 'sanity-plugin-stripe/server'

/**
 * Sample products for the test shop before it has a Sanity project. It answers the site's and the
 * plugin's own GROQ with groq-js, draws the same line Sanity does between what anyone can read
 * and what needs a token, and applies the webhook's transactions the way Sanity does: all or
 * nothing, and no second document with the same id. It lives in memory, so stock goes back to
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

const SHIRT_VARIANTS = [
  {_key: 'm', _type: 'stripeVariant', label: 'M'},
  {_key: 'l', _type: 'stripeVariant', label: 'L'},
  {_key: 'xl', _type: 'stripeVariant', label: 'XL', availability: 'soldOut'},
]

const SAMPLE: Doc[] = [
  product('magazine', 'Magazine, issue 1', 'magazine-issue-1', {price: 25, taxClass: 'reduced'}),
  // An unpublished edit: it must turn sold out with the published one, and never be sold itself.
  product('drafts.magazine', 'Magazine, issue 1 (new title)', 'magazine-issue-1', {
    price: 1,
    taxClass: 'reduced',
  }),
  product('shirt', 'Shirt', 'shirt', {
    price: 29.5,
    taxClass: 'standard',
    variants: SHIRT_VARIANTS,
  }),
  // No stock document: it is never counted.
  product('poster', 'Poster', 'poster', {price: 12, taxClass: 'standard'}),
  {
    _id: 'stripeShopSettings',
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
    autoSoldOut: true,
  },
  // Stock counts live apart from the products, under ids only a token can read.
  {_id: 'stripe.stock.magazine', _type: 'stripe.stock', stockCount: 3},
  {
    _id: 'stripe.stock.shirt',
    _type: 'stripe.stock',
    variants: [
      {_key: 'm', stockCount: 1},
      {_key: 'l', stockCount: 5},
    ],
  },
]

// One dataset for the whole server, whichever route or page asks.
const shared: typeof globalThis & {standInShop?: Map<string, Doc>} = globalThis
const dataset = () =>
  (shared.standInShop ??= new Map(SAMPLE.map((doc) => [doc._id, structuredClone(doc)])))

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** One step of a patch path: a field, or an array item by key (`variants[_key=="m"]`). */
const STEP = /^(\w+)(?:\[_key=="([\w-]+)"\])?$/

/** The object and key a patch path points at, or null when it matches nothing. */
function target(doc: Doc, path: string): {holder: Record<string, unknown>; key: string} | null {
  const steps = path.split('.')
  let holder: Record<string, unknown> = doc
  for (const [index, step] of steps.entries()) {
    const match = STEP.exec(step)
    if (!match) throw new Error(`The stand-in dataset can't follow ${path}`)
    const [, field = '', itemKey] = match
    if (index === steps.length - 1) return itemKey === undefined ? {holder, key: field} : null
    const value: unknown = holder[field]
    const items: unknown[] = Array.isArray(value) ? value : []
    const next: unknown =
      itemKey === undefined ? value : items.find((item) => isObject(item) && item._key === itemKey)
    if (!isObject(next)) return null
    holder = next
  }
  return null
}

function transaction(): SanityTransaction {
  const steps: Array<(next: Map<string, Doc>) => void> = []
  const self: SanityTransaction = {
    create(document) {
      steps.push((next) => {
        if (next.has(document._id))
          throw Object.assign(new Error(`Document ${document._id} already exists`), {
            statusCode: 409,
          })
        next.set(document._id, structuredClone(document))
      })
      return self
    },
    patch(documentId, operations) {
      steps.push((next) => {
        const doc = next.get(documentId)
        if (!doc)
          throw Object.assign(new Error(`Document ${documentId} not found`), {statusCode: 409})
        for (const [path, amount] of Object.entries(operations.dec ?? {})) {
          const found = target(doc, path)
          const current = found?.holder[found.key]
          if (found && typeof current === 'number') found.holder[found.key] = current - amount
        }
        for (const [path, value] of Object.entries(operations.set ?? {})) {
          const found = target(doc, path)
          if (found) found.holder[found.key] = value
        }
      })
      return self
    },
    delete(documentId) {
      steps.push((next) => void next.delete(documentId))
      return self
    },
    async commit() {
      // Work on a copy, so a failed step leaves the dataset as it was.
      const next = structuredClone(dataset())
      for (const step of steps) step(next)
      shared.standInShop = next
    },
  }
  return self
}

async function run(visible: (id: string) => boolean, query: string, params = {}) {
  const docs = [...dataset().values()].filter((doc) => visible(doc._id))
  const result = await evaluate(parse(query, {params}), {dataset: docs, params})
  const value: unknown = await result.get()
  return value
}

/** What the site reads with, as anyone can: documents whose id has no dot. */
export const standInReader: SanityReader = {
  fetch: (query, params) => run((id) => !id.includes('.'), query, params),
  withConfig: () => standInReader,
}

/**
 * What a client with a token sees: everything but drafts and release copies, until it asks for
 * the raw perspective, as the plugin does to read stock and mark every version sold out.
 */
function withToken(everything: boolean): SanityWriter {
  return {
    fetch: (query, params) =>
      run((id) => everything || !/^(drafts|versions)\./.test(id), query, params),
    withConfig: () => withToken(true),
    transaction,
  }
}

export const standInWriter = withToken(false)
