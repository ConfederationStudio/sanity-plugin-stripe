import {evaluate, parse} from 'groq-js'

import {isObject} from '../core/guards'
import {SHOP_SETTINGS_ID, SHOP_SETTINGS_TYPE, STOCK_TYPE, stockId} from '../core/ids'
import type {RawConfig, SanityReader, SanityWriter} from '../server/sanity'

export type Doc = {_id: string; _type: string; [field: string]: unknown}

const product = (id: string, title: string, commerce: Record<string, unknown>): Doc => ({
  _id: id,
  _type: 'product',
  title,
  slug: {_type: 'slug', current: id.split('.').at(-1)},
  commerce: {_type: 'stripeCommerce', availability: 'onSale', ...commerce},
})

const MAGAZINE_IMAGE = [
  {_key: 'a', _type: 'image', asset: {_type: 'reference', _ref: 'image-magazine'}},
]
const SHIRT_VARIANTS = [
  {_key: 'm', _type: 'stripeVariant', label: 'M'},
  {_key: 'l', _type: 'stripeVariant', label: 'L', availability: 'soldOut'},
]

/**
 * A shop as a dataset holds it: a magazine (3 in stock) that also exists as an unpublished draft
 * with another price and as a copy in a Content Release, a shirt in two sizes (1 M in stock, L
 * switched to sold out), a poster that isn't counted, the shop settings, and the private stock
 * documents.
 */
export const SHOP: Doc[] = [
  {_id: 'image-magazine', _type: 'sanity.imageAsset', url: 'https://cdn.sanity.io/magazine.jpg'},
  {...product('magazine', 'Issue 16', {price: 25, taxClass: 'reduced'}), images: MAGAZINE_IMAGE},
  product('drafts.magazine', 'Issue 16 (draft)', {price: 1, taxClass: 'reduced'}),
  product('versions.rSummer.magazine', 'Issue 16 (summer)', {price: 20, taxClass: 'reduced'}),
  product('shirt', 'Shirt', {price: 29.5, taxClass: 'standard', variants: SHIRT_VARIANTS}),
  product('drafts.shirt', 'Shirt', {price: 29.5, taxClass: 'standard', variants: SHIRT_VARIANTS}),
  product('poster', 'Poster', {price: 12, taxClass: 'standard'}),
  {
    _id: SHOP_SETTINGS_ID,
    _type: SHOP_SETTINGS_TYPE,
    shippingRegions: [
      {_key: 'nl', title: 'Netherlands', countries: ['NL'], rate: 5},
      {_key: 'eu', title: 'European Union', countries: ['DE', 'FR'], rate: 12},
      {_key: 'world', title: 'Rest of the world', everywhereElse: true, rate: 18},
    ],
    autoSoldOut: true,
  },
  {_id: stockId('magazine'), _type: STOCK_TYPE, stockCount: 3},
  {_id: stockId('shirt'), _type: STOCK_TYPE, variants: [{_key: 'm', stockCount: 1}]},
]

/** One step of a patch path: a field, an array item by key (`variants[_key=="m"]`), or the last item. */
const STEP = /^(\w+)(?:\[(?:_key=="([\w-]+)"|(-1))\])?$/

interface Target {
  holder: Record<string, unknown>
  key: string
  /** Set when the path ends at an array item: the array it is in, and the item's place. */
  item?: {array: unknown[]; index: number}
}

/** Where a patch path such as `commerce.variants[_key=="m"].availability` points, or null. */
function target(doc: Doc, path: string): Target | null {
  const steps = path.split('.')
  let holder: Record<string, unknown> = doc
  for (const [index, step] of steps.entries()) {
    const match = STEP.exec(step)
    if (!match) throw new Error(`The fake dataset can't follow ${path}`)
    const [, field = '', itemKey, lastItem] = match
    const last = index === steps.length - 1
    if (itemKey === undefined && lastItem === undefined) {
      if (last) return {holder, key: field}
      const next = holder[field]
      if (!isObject(next)) return null
      holder = next
      continue
    }
    const array: unknown = holder[field]
    if (!Array.isArray(array)) return null
    const list: unknown[] = array
    const at = lastItem
      ? list.length - 1
      : list.findIndex((item) => isObject(item) && item._key === itemKey)
    if (last) return {holder, key: field, item: {array: list, index: at}}
    const next = list[at]
    if (!isObject(next)) return null
    holder = next
  }
  return null
}

interface FakePatch {
  dec?: Record<string, number>
  set?: Record<string, unknown>
  unset?: string[]
  setIfMissing?: Record<string, unknown>
  insert?: {after: string; items: unknown[]}
}

/** A patch as Sanity applies it: a path that matches nothing changes nothing. */
function applyPatch(doc: Doc, operations: FakePatch): void {
  for (const [path, value] of Object.entries(operations.setIfMissing ?? {})) {
    const found = target(doc, path)
    if (found && found.holder[found.key] === undefined) found.holder[found.key] = value
  }
  for (const [path, value] of Object.entries(operations.set ?? {})) {
    const found = target(doc, path)
    if (found && !found.item) found.holder[found.key] = value
  }
  for (const [path, amount] of Object.entries(operations.dec ?? {})) {
    const found = target(doc, path)
    const current = found && !found.item ? found.holder[found.key] : undefined
    if (found && typeof current === 'number') found.holder[found.key] = current - amount
  }
  for (const path of operations.unset ?? []) {
    const found = target(doc, path)
    if (!found) continue
    if (!found.item) delete found.holder[found.key]
    else if (found.item.index >= 0) found.item.array.splice(found.item.index, 1)
  }
  if (operations.insert) {
    const found = target(doc, operations.insert.after)
    if (found?.item) found.item.array.splice(found.item.index + 1, 0, ...operations.insert.items)
  }
}

/** A transaction as the plugin's server code and the Studio's stock boxes use one. */
export interface FakeTransaction {
  create(document: Doc): FakeTransaction
  createIfNotExists(document: Doc): FakeTransaction
  patch(documentId: string, operations: FakePatch): FakeTransaction
  delete(documentId: string): FakeTransaction
  commit(): Promise<void>
}

export interface FakeWriter extends SanityWriter {
  transaction(): FakeTransaction
  withConfig(config: RawConfig): FakeWriter
}

/**
 * A stand-in for a Sanity dataset. It runs the plugin's real GROQ with groq-js, draws the same
 * line Sanity does between what anyone can read and what needs a token, and applies transactions
 * the way Sanity does: all or nothing, and no second document with the same id.
 *
 * - `reader`: no token. It sees documents whose id has no dot, whatever it asks for.
 * - `writer`: a token. Like a client set to published documents, it leaves out drafts and release
 *   copies until it asks for the raw perspective, which the plugin must do.
 */
export function fakeDataset(initial: Doc[] = SHOP) {
  let docs = new Map(initial.map((doc) => [doc._id, structuredClone(doc)]))
  /** Every raw configuration the plugin asked for. */
  const raw: RawConfig[] = []
  /** Set to make the next commits fail, as a token without write rights would. */
  const failing: {commit: Error | null} = {commit: null}

  const run = async (visible: (id: string) => boolean, query: string, params = {}) => {
    const dataset = [...docs.values()].filter((doc) => visible(doc._id))
    const result = await evaluate(parse(query, {params}), {dataset, params})
    const value: unknown = await result.get()
    return value
  }

  const reader: SanityReader = {
    fetch: (query, params) => run((id) => !id.includes('.'), query, params),
    withConfig: () => reader,
  }

  const transaction = (): FakeTransaction => {
    const steps: Array<(next: Map<string, Doc>) => void> = []
    const self: FakeTransaction = {
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
      createIfNotExists(document) {
        steps.push((next) => {
          if (!next.has(document._id)) next.set(document._id, structuredClone(document))
        })
        return self
      },
      patch(documentId, operations) {
        steps.push((next) => {
          const doc = next.get(documentId)
          if (!doc)
            throw Object.assign(new Error(`Document ${documentId} not found`), {statusCode: 409})
          applyPatch(doc, operations)
        })
        return self
      },
      delete(documentId) {
        steps.push((next) => void next.delete(documentId))
        return self
      },
      async commit() {
        if (failing.commit) throw failing.commit
        // Work on a copy, so a failed step leaves the dataset as it was.
        const next = structuredClone(docs)
        for (const step of steps) step(next)
        docs = next
      },
    }
    return self
  }

  const client = (everything: boolean): FakeWriter => ({
    fetch: (query, params) =>
      run((id) => everything || !/^(drafts|versions)\./.test(id), query, params),
    withConfig(config) {
      raw.push(config)
      return client(true)
    },
    transaction,
  })

  return {
    reader,
    writer: client(false),
    raw,
    failing,
    get: (id: string) => docs.get(id),
    /** A field by patch path, such as `commerce.availability` or `variants[_key=="m"].stockCount`. */
    value(id: string, path: string): unknown {
      const doc = docs.get(id)
      const found = doc ? target(doc, path) : null
      return found && !found.item ? found.holder[found.key] : undefined
    },
    ids: () => [...docs.keys()],
    add: (doc: Doc) => void docs.set(doc._id, structuredClone(doc)),
  }
}
