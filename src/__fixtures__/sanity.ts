import {asArray, isObject} from '../core/guards'
import {SHOP_SETTINGS_ID, SHOP_SETTINGS_TYPE} from '../core/ids'
import type {SanityTransaction, SanityWriter} from '../server/sanity'

type Doc = {_id: string; [field: string]: unknown}

/** A shop with a magazine (3 in stock, with a draft) and a shirt in two sizes. */
export const SHOP: Doc[] = [
  {
    _id: 'magazine',
    title: 'Issue 16',
    slug: 'issue-16',
    imageUrl: 'https://cdn.sanity.io/images/p/d/magazine.jpg',
    commerce: {availability: 'onSale', price: 25, taxClass: 'reduced', stockCount: 3},
  },
  {
    _id: 'drafts.magazine',
    title: 'Issue 16 (edited)',
    commerce: {availability: 'onSale', price: 25, taxClass: 'reduced', stockCount: 3},
  },
  {
    _id: 'shirt',
    title: 'Shirt',
    slug: 'shirt',
    imageUrl: null,
    commerce: {
      availability: 'onSale',
      price: 29.5,
      taxClass: 'standard',
      variants: [
        {_key: 'm', label: 'M', stockCount: 1},
        {_key: 'l', label: 'L', availability: 'soldOut'},
      ],
    },
  },
  {
    _id: SHOP_SETTINGS_ID,
    _type: SHOP_SETTINGS_TYPE,
    shippingRegions: [
      {_key: 'nl', title: 'Netherlands', countries: ['NL'], rate: 5},
      {_key: 'eu', title: 'European Union', countries: ['DE', 'FR'], rate: 12},
      {_key: 'world', title: 'Rest of the world', everywhereElse: true, rate: 18},
    ],
    orderEmail: 'orders@example.com',
    autoSoldOut: true,
  },
]

/** The object and key a patch path such as `commerce.variants[_key=="m"].stockCount` points at. */
function fieldAt(doc: Doc, path: string): {holder: Record<string, unknown>; key: string} {
  const match = /^(\w+)(?:\.variants\[_key=="([\w-]+)"\])?\.(\w+)$/.exec(path)
  if (!match) throw new Error(`The fake dataset can't patch ${path}`)
  const [, field = '', variantKey, key = ''] = match
  const commerce = doc[field]
  if (!isObject(commerce)) throw new Error(`${doc._id} has no ${field}`)
  if (!variantKey) return {holder: commerce, key}
  const variant = asArray(commerce.variants).find(
    (candidate) => isObject(candidate) && candidate._key === variantKey,
  )
  if (!isObject(variant)) throw new Error(`${doc._id} has no variant ${variantKey}`)
  return {holder: variant, key}
}

/**
 * A stand-in for a Sanity dataset that answers the plugin's queries and applies its
 * transactions the way Sanity does: all or nothing, and no second document with the same id.
 */
export function fakeDataset(initial: Doc[] = SHOP) {
  let docs = new Map(initial.map((doc) => [doc._id, structuredClone(doc)]))
  const perspectives: string[] = []

  const client: SanityWriter = {
    async fetch(query, params = {}) {
      if (query.includes('{changes}')) return docs.get(String(params.id)) ?? null
      if (query.includes(SHOP_SETTINGS_TYPE)) return docs.get(SHOP_SETTINGS_ID) ?? null
      const ids = asArray(params.ids)
      return structuredClone([...docs.values()].filter((doc) => ids.includes(doc._id)))
    },
    withConfig(config) {
      perspectives.push(config.perspective)
      return client
    },
    transaction() {
      const steps: Array<(next: Map<string, Doc>) => void> = []
      const transaction: SanityTransaction = {
        create(document) {
          steps.push((next) => {
            if (next.has(document._id))
              throw Object.assign(new Error('Document already exists'), {statusCode: 409})
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
          const next = structuredClone(docs)
          for (const step of steps) step(next)
          docs = next
        },
      }
      return transaction
    },
  }

  return {
    client,
    /** Which perspectives the plugin asked for, to see that it reads drafts. */
    perspectives,
    get: (id: string) => docs.get(id),
    /** A field read by a patch path, such as `commerce.stockCount`. */
    value(id: string, path: string): unknown {
      const doc = docs.get(id)
      if (!doc) return undefined
      const {holder, key} = fieldAt(doc, path)
      return holder[key]
    },
    ids: () => [...docs.keys()],
  }
}
