import {STOCK_TYPE, stockId} from '../core/ids'
import {readStockDocuments, STOCK_QUERY, stockLeft, type ProductStock} from '../core/stock'

/**
 * Reading and writing a product's stock counts from the Studio. They live in their own document,
 * with a dot in its id, so a public dataset never serves them: the editor's own session reads and
 * writes it, and nobody without a token can.
 */

interface StockPatch {
  set?: Record<string, unknown>
  unset?: string[]
  setIfMissing?: Record<string, unknown>
  insert?: {after: string; items: unknown[]}
}

interface StockTransaction {
  createIfNotExists(document: {_id: string; _type: string}): StockTransaction
  patch(documentId: string, operations: StockPatch): StockTransaction
  commit(): Promise<unknown>
}

/** As much of the Studio's client as stock needs. */
export interface StockClient {
  fetch(query: string, params?: Record<string, unknown>): Promise<unknown>
  transaction(): StockTransaction
}

const SAFE_KEY = /^[\w-]+$/
const EMPTY: ProductStock = {stockCount: null, variants: []}

/** A product's stock, or empty counts when it has no stock document yet. */
export async function loadStock(client: StockClient, productId: string): Promise<ProductStock> {
  const found = await client.fetch(STOCK_QUERY, {ids: [stockId(productId)]})
  return readStockDocuments(found).get(productId) ?? EMPTY
}

/** What an editor typed in a stock box: a whole number from 0 up, or nothing for "not counted". */
export function parseCount(text: string): number | null | 'invalid' {
  const trimmed = text.trim()
  if (trimmed === '') return null
  return /^\d{1,9}$/.test(trimmed) ? Number(trimmed) : 'invalid'
}

/**
 * Sets one count, of the product or of one variant, leaving every other count as it is: an order
 * coming in at the same moment keeps its own change. `count: null` stops counting.
 */
export async function saveStock(
  client: StockClient,
  productId: string,
  current: ProductStock,
  change: {variantKey?: string; count: number | null},
): Promise<void> {
  const {variantKey, count} = change
  if (variantKey !== undefined && !SAFE_KEY.test(variantKey))
    throw new TypeError(`"${variantKey}" is not a variant key`)
  const id = stockId(productId)
  const transaction = client.transaction().createIfNotExists({_id: id, _type: STOCK_TYPE})

  if (variantKey === undefined) {
    transaction.patch(id, count === null ? {unset: ['stockCount']} : {set: {stockCount: count}})
  } else {
    const entry = `variants[_key=="${variantKey}"]`
    const exists = current.variants.some((variant) => variant._key === variantKey)
    if (exists) {
      transaction.patch(
        id,
        count === null ? {unset: [entry]} : {set: {[`${entry}.stockCount`]: count}},
      )
    } else if (count !== null) {
      transaction.patch(id, {setIfMissing: {variants: []}}).patch(id, {
        insert: {after: 'variants[-1]', items: [{_key: variantKey, stockCount: count}]},
      })
    } else {
      return
    }
  }
  await transaction.commit()
}

export {stockLeft}
