import {asArray, isObject} from '../core/guards'
import {publishedId, STOCK_CHANGE_TYPE, stockChangeId, stockId} from '../core/ids'
import {productVersionsQuery, resolveProductQuery, type ProductQueryOptions} from '../core/queries'
import {readStockDocuments, STOCK_QUERY, stockLeft, type ProductStock} from '../core/stock'
import type {OrderItem} from './order'
import {rawReader, rawWriter, type SanityReader, type SanityWriter} from './sanity'

const SAFE_KEY = /^[\w-]+$/

/** Stripe stops redelivering an event after three days; a month leaves a wide margin. */
const KEEP_CHANGES_DAYS = 30

/**
 * The stock of the given products, by product id, read from their private stock documents. The
 * client needs a token. A product without a stock document isn't counted and has no entry.
 *
 * A site can use it on the server to say "only 2 left"; it should never send the counts of
 * everything to the browser.
 */
export async function readStock(
  client: SanityReader,
  productIds: readonly string[],
): Promise<Map<string, ProductStock>> {
  const ids = productIds.filter((id) => id && !id.includes('.')).map((id) => stockId(id))
  if (!ids.length) return new Map()
  return readStockDocuments(await rawReader(client).fetch(STOCK_QUERY, {ids}))
}

/** What an order did to one stock count. */
export interface StockChange {
  productId: string
  variantKey?: string
  from: number
  /** Below 0 when more was sold than was in stock. */
  to: number
}

export interface StockResult {
  /**
   * `lowered`: counts were changed now. `already`: this session's stock was lowered before, and
   * `changes` is what happened then. `untracked`: nothing in the order has a stock count.
   */
  status: 'lowered' | 'already' | 'untracked'
  changes: StockChange[]
}

export interface StockOptions {
  /** Mark a product or variant sold out when its count reaches 0. Default true. */
  autoSoldOut?: boolean
  /** Where the site keeps its products. */
  products?: ProductQueryOptions
  /** The current time, for tests. */
  now?: Date
}

function readChanges(value: unknown): StockChange[] {
  return asArray(value).flatMap((item) => {
    if (!isObject(item)) return []
    const {productId, variantKey, from, to} = item
    if (typeof productId !== 'string') return []
    if (typeof from !== 'number' || typeof to !== 'number') return []
    const change: StockChange = {productId, from, to}
    if (typeof variantKey === 'string') change.variantKey = variantKey
    return [change]
  })
}

interface ProductVersion {
  _id: string
  variants: string[]
}

function readVersions(value: unknown): ProductVersion[] {
  return asArray(value).flatMap((item) =>
    isObject(item) && typeof item._id === 'string'
      ? [
          {
            _id: item._id,
            variants: asArray(item.variants).filter(
              (key): key is string => typeof key === 'string',
            ),
          },
        ]
      : [],
  )
}

const isConflict = (error: unknown) => isObject(error) && error.statusCode === 409

/**
 * Lowers the stock count of every ordered product or variant that has one. Products and variants
 * without a count are left alone. When a count reaches 0 and `autoSoldOut` is on, the product or
 * variant is marked sold out in every version of the product document, so publishing a draft or a
 * release can't put it back on sale.
 *
 * It happens once per Checkout Session, however often it is called: the counts change in one
 * transaction with a record of the session, and Sanity refuses a second record with the same id.
 * The record holds product ids and counts only.
 */
export async function decrementStock(
  client: SanityWriter,
  order: {sessionId: string; items: readonly OrderItem[]},
  options: StockOptions = {},
): Promise<StockResult> {
  const {field} = resolveProductQuery(options.products)
  const autoSoldOut = options.autoSoldOut ?? true
  const now = options.now ?? new Date()

  const ordered: Array<{productId: string; variantKey?: string; quantity: number}> = []
  for (const item of order.items) {
    const {productId, variantKey, quantity} = item
    if (!productId || productId.includes('.')) continue
    if (variantKey && !SAFE_KEY.test(variantKey)) continue
    const same = ordered.find(
      (line) => line.productId === productId && line.variantKey === variantKey,
    )
    if (same) same.quantity += quantity
    else ordered.push(variantKey ? {productId, variantKey, quantity} : {productId, quantity})
  }
  if (!ordered.length) return {status: 'untracked', changes: []}

  const raw = rawWriter(client)
  const recordId = stockChangeId(order.sessionId)
  const readRecord = async (): Promise<StockChange[] | null> => {
    const record = await raw.fetch(`*[_id == $id][0]{changes}`, {id: recordId})
    return isObject(record) ? readChanges(record.changes) : null
  }

  const before = await readRecord()
  if (before) return {status: 'already', changes: before}

  const productIds = [...new Set(ordered.map((line) => line.productId))]
  const stock = await readStock(raw, productIds)

  const changes: StockChange[] = []
  const lower = new Map<string, Record<string, number>>()
  for (const {productId, variantKey, quantity} of ordered) {
    const from = stockLeft(stock.get(productId), variantKey)
    if (from === null) continue
    const dec = lower.get(productId) ?? {}
    dec[variantKey ? `variants[_key=="${variantKey}"].stockCount` : 'stockCount'] = quantity
    lower.set(productId, dec)
    const change: StockChange = {productId, from, to: from - quantity}
    if (variantKey) change.variantKey = variantKey
    changes.push(change)
  }
  if (!changes.length) return {status: 'untracked', changes: []}

  // The public sees "sold out", never the count: set it on every version of the product.
  const soldOut = autoSoldOut ? changes.filter((change) => change.to <= 0) : []
  const mark = new Map<string, Record<string, string>>()
  if (soldOut.length) {
    const {query, params} = productVersionsQuery(
      [...new Set(soldOut.map((change) => change.productId))],
      options.products,
    )
    for (const version of readVersions(await raw.fetch(query, params))) {
      const productId = publishedId(version._id)
      const set: Record<string, string> = {}
      for (const change of soldOut) {
        if (change.productId !== productId) continue
        if (!change.variantKey) set[`${field}.availability`] = 'soldOut'
        else if (version.variants.includes(change.variantKey))
          set[`${field}.variants[_key=="${change.variantKey}"].availability`] = 'soldOut'
      }
      if (Object.keys(set).length) mark.set(version._id, set)
    }
  }

  const cutoff = new Date(now.getTime() - KEEP_CHANGES_DAYS * 24 * 60 * 60 * 1000)
  const old = asArray(
    await raw.fetch(`*[_type == $type && loweredAt < $before][0...25]._id`, {
      type: STOCK_CHANGE_TYPE,
      before: cutoff.toISOString(),
    }),
  ).filter((id): id is string => typeof id === 'string')

  const transaction = client.transaction().create({
    _id: recordId,
    _type: STOCK_CHANGE_TYPE,
    sessionId: order.sessionId,
    loweredAt: now.toISOString(),
    changes: changes.map((change, index) => Object.assign({_key: `change-${index}`}, change)),
  })
  for (const [productId, dec] of lower) transaction.patch(stockId(productId), {dec})
  for (const [documentId, set] of mark) transaction.patch(documentId, {set})
  for (const documentId of old) transaction.delete(documentId)

  try {
    await transaction.commit()
  } catch (error) {
    // The record exists: another delivery of the same event got here first, and nothing changed now.
    if (isConflict(error)) {
      const winner = await readRecord()
      if (winner) return {status: 'already', changes: winner}
    }
    throw error
  }
  return {status: 'lowered', changes}
}
