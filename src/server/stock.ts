import {asArray, asNumber, isObject} from '../core/guards'
import {STOCK_RECORD_TYPE, stockRecordId} from '../core/ids'
import {resolveProductQuery, stockQuery, type ProductQueryOptions} from '../core/queries'
import type {OrderItem} from './order'
import type {SanityWriter} from './sanity'

const SAFE_KEY = /^[\w-]+$/

export interface StockChange {
  /** The document that was changed: the published product, or its draft. */
  documentId: string
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
}

interface StockDocument {
  _id: string
  stockCount: number | null
  variants: Array<{_key: string; stockCount: number | null}>
}

function readStockDocuments(value: unknown): StockDocument[] {
  return asArray(value).flatMap((item) => {
    if (!isObject(item) || typeof item._id !== 'string') return []
    const commerce = isObject(item.commerce) ? item.commerce : {}
    return [
      {
        _id: item._id,
        stockCount: asNumber(commerce.stockCount),
        variants: asArray(commerce.variants).flatMap((variant) =>
          isObject(variant) && typeof variant._key === 'string'
            ? [{_key: variant._key, stockCount: asNumber(variant.stockCount)}]
            : [],
        ),
      },
    ]
  })
}

function readChanges(value: unknown): StockChange[] {
  return asArray(value).flatMap((item) => {
    if (!isObject(item)) return []
    const {documentId, productId, variantKey, from, to} = item
    if (typeof documentId !== 'string' || typeof productId !== 'string') return []
    if (typeof from !== 'number' || typeof to !== 'number') return []
    const change: StockChange = {documentId, productId, from, to}
    if (typeof variantKey === 'string') change.variantKey = variantKey
    return [change]
  })
}

const isConflict = (error: unknown) => isObject(error) && error.statusCode === 409

/**
 * Lowers the stock count of every ordered product or variant that has one, in the published
 * document and in its draft (so publishing a draft doesn't put the old count back). Products and
 * variants without a stock count are left alone.
 *
 * It happens once per Checkout Session, however often it is called: the counts change in one
 * transaction with a record of the session, and Sanity refuses a second record with the same id.
 */
export async function decrementStock(
  client: SanityWriter,
  order: {sessionId: string; items: readonly OrderItem[]},
  options: StockOptions = {},
): Promise<StockResult> {
  const {field} = resolveProductQuery(options.products)
  const autoSoldOut = options.autoSoldOut ?? true

  const ordered = new Map<string, number>()
  for (const item of order.items) {
    if (!item.productId || (item.variantKey && !SAFE_KEY.test(item.variantKey))) continue
    const key = `${item.productId}:${item.variantKey ?? ''}`
    ordered.set(key, (ordered.get(key) ?? 0) + item.quantity)
  }
  if (!ordered.size) return {status: 'untracked', changes: []}

  // Drafts and the record are only visible with the raw perspective and a token.
  const raw = client.withConfig?.({perspective: 'raw', useCdn: false}) ?? client
  const recordId = stockRecordId(order.sessionId)
  const readRecord = async (): Promise<StockChange[] | null> => {
    const record = await raw.fetch(`*[_id == $id][0]{changes}`, {id: recordId})
    return isObject(record) ? readChanges(record.changes) : null
  }

  const before = await readRecord()
  if (before) return {status: 'already', changes: before}

  const productIds = [...new Set([...ordered.keys()].map((key) => key.split(':')[0] ?? ''))]
  const documents = readStockDocuments(
    await raw.fetch(stockQuery(options.products), {
      ids: productIds.flatMap((id) => [id, `drafts.${id}`]),
    }),
  )

  const changes: StockChange[] = []
  const patches: Array<{id: string; dec: Record<string, number>; set: Record<string, unknown>}> = []
  for (const document of documents) {
    const productId = document._id.replace(/^drafts\./, '')
    const dec: Record<string, number> = {}
    const set: Record<string, unknown> = {}
    for (const [key, quantity] of ordered) {
      const [id, variantKey] = key.split(':')
      if (id !== productId) continue
      const from = variantKey
        ? document.variants.find((variant) => variant._key === variantKey)?.stockCount
        : document.stockCount
      if (typeof from !== 'number') continue
      const path = variantKey ? `${field}.variants[_key=="${variantKey}"]` : field
      const to = from - quantity
      dec[`${path}.stockCount`] = quantity
      if (autoSoldOut && to <= 0) set[`${path}.availability`] = 'soldOut'
      const change: StockChange = {documentId: document._id, productId, from, to}
      if (variantKey) change.variantKey = variantKey
      changes.push(change)
    }
    if (Object.keys(dec).length) patches.push({id: document._id, dec, set})
  }
  if (!changes.length) return {status: 'untracked', changes: []}

  const transaction = client.transaction().create({
    _id: recordId,
    _type: STOCK_RECORD_TYPE,
    sessionId: order.sessionId,
    loweredAt: new Date().toISOString(),
    changes: changes.map((change, index) => Object.assign({_key: `change-${index}`}, change)),
  })
  for (const {id, dec, set} of patches) {
    transaction.patch(id, Object.keys(set).length ? {dec, set} : {dec})
  }

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
