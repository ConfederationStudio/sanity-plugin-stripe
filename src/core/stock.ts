import {asArray, asNumber, isObject} from './guards'
import {STOCK_TYPE, stockId} from './ids'

/** A product's stock, as its private stock document holds it. */
export interface ProductStock {
  /** For a product without variants. Null when it isn't counted. */
  stockCount: number | null
  /** One entry per counted variant, under the variant's `_key`. */
  variants: Array<{_key: string; stockCount: number | null}>
}

/** The stock documents with the ids in `$ids`. Only a client with a token gets an answer. */
export const STOCK_QUERY = `*[_type == "${STOCK_TYPE}" && _id in $ids]{_id, stockCount, variants[]{_key, stockCount}}`

/** Stock documents as Sanity returned them, by product id. */
export function readStockDocuments(value: unknown): Map<string, ProductStock> {
  const prefix = stockId('')
  const stock = new Map<string, ProductStock>()
  for (const item of asArray(value)) {
    if (!isObject(item) || typeof item._id !== 'string' || !item._id.startsWith(prefix)) continue
    stock.set(item._id.slice(prefix.length), {
      stockCount: asNumber(item.stockCount),
      variants: asArray(item.variants).flatMap((variant) =>
        isObject(variant) && typeof variant._key === 'string'
          ? [{_key: variant._key, stockCount: asNumber(variant.stockCount)}]
          : [],
      ),
    })
  }
  return stock
}

/** How many are left of a product or one of its variants. Null when it isn't counted. */
export function stockLeft(stock: ProductStock | undefined, variantKey?: string): number | null {
  if (!stock) return null
  if (!variantKey) return stock.stockCount
  return stock.variants.find((variant) => variant._key === variantKey)?.stockCount ?? null
}
