import {asArray, isObject} from './guards'

/** The cart's types and rules. Used by the Studio, the browser and the server alike. */

export type Availability = 'onSale' | 'soldOut'

/** How often a subscription is delivered and charged. */
export interface Interval {
  unit: 'week' | 'month'
  /** 6 with `week` means every 6 weeks. */
  every: number
}

/** What the browser keeps in the cart: references only, never prices. */
export interface CartLine {
  /** Sanity document id of the product. */
  productId: string
  /** `_key` of the chosen variant, when the product has variants. */
  variantKey?: string
  /** Set when the buyer subscribes. Left out when the product is bought once. */
  plan?: 'subscribe'
  quantity: number
}

/** The subscription a product offers, as the Studio saves it. */
export interface CartSubscription {
  enabled?: boolean | null
  /** Per delivery, in currency units. */
  price?: number | null
  every?: number | null
  unit?: string | null
}

export interface CartVariant {
  _key: string
  label?: string | null
  availability?: Availability | null
}

/**
 * A product as the cart and the checkout read it from Sanity: see `cartProductProjection`. It
 * says whether the product is on sale, never how many are left: counts are private.
 */
export interface CartProduct {
  _id: string
  title?: string | null
  slug?: string | null
  imageUrl?: string | null
  commerce?: {
    availability?: Availability | null
    /** In currency units (25 means €25). */
    price?: number | null
    taxClass?: string | null
    variants?: CartVariant[] | null
    subscription?: CartSubscription | null
  } | null
}

/** Stripe charges a subscription at least once every three years. */
const LONGEST: Record<Interval['unit'], number> = {week: 156, month: 36}

/** The subscription a product offers, when it is switched on and filled in. Null otherwise. */
export function readSubscription(
  subscription: CartSubscription | null | undefined,
): {price: number; interval: Interval} | null {
  if (!subscription?.enabled) return null
  const {price, every, unit} = subscription
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return null
  if (unit !== 'week' && unit !== 'month') return null
  if (typeof every !== 'number' || !Number.isInteger(every) || every < 1 || every > LONGEST[unit])
    return null
  return {price, interval: {unit, every}}
}

/** "every 6 weeks", "every month": how an interval reads in English. */
export function describeInterval(interval: Interval): string {
  return interval.every === 1
    ? `every ${interval.unit}`
    : `every ${interval.every} ${interval.unit}s`
}

/**
 * Products as a query with `cartProductProjection` returns them. Anything that isn't a document
 * is dropped; the fields are checked where they are used, in `lineStatus`.
 */
export function readCartProducts(value: unknown): CartProduct[] {
  return asArray(value).filter(
    (item): item is CartProduct => isObject(item) && typeof item._id === 'string',
  )
}

/** Most of one item a buyer can order at once. */
export const MAX_QUANTITY = 10

/** One cart line per product, variant and way of buying. */
export function lineKey(line: Pick<CartLine, 'productId' | 'variantKey' | 'plan'>): string {
  return `${line.productId}:${line.variantKey ?? ''}${line.plan ? `:${line.plan}` : ''}`
}

/**
 * Turns anything (stored JSON, a request body) into valid cart lines: drops what doesn't parse,
 * merges duplicates and keeps quantities between 1 and `max`.
 *
 * A product id with a dot is dropped: a published document's id has none, so a draft or a copy
 * inside a release can never be put in a cart, whatever the site's Sanity client is able to read.
 */
export function sanitizeLines(input: unknown, max = MAX_QUANTITY): CartLine[] {
  const merged = new Map<string, CartLine>()
  for (const item of asArray(input).slice(0, 100)) {
    if (!isObject(item)) continue
    const {productId, variantKey, plan, quantity} = item
    if (typeof productId !== 'string' || !productId || productId.length > 200) continue
    if (productId.includes('.')) continue
    if (variantKey !== undefined && (typeof variantKey !== 'string' || variantKey.length > 200))
      continue
    if (typeof quantity !== 'number' || !Number.isFinite(quantity)) continue
    const line: CartLine = {
      productId,
      quantity: 0,
      ...(variantKey ? {variantKey} : {}),
      ...(plan === 'subscribe' ? {plan} : {}),
    }
    const key = lineKey(line)
    const existing = merged.get(key)
    const total = (existing?.quantity ?? 0) + Math.floor(quantity)
    if (total < 1) continue
    merged.set(key, {...line, quantity: Math.min(total, max)})
  }
  return [...merged.values()]
}

export type Unavailable =
  | 'missing'
  | 'soldOut'
  | 'noPrice'
  | 'chooseVariant'
  | 'variantMissing'
  /** The line subscribes, and the product doesn't offer a subscription (any more). */
  | 'noSubscription'

export type LineStatus =
  | {
      available: true
      maxQuantity: number
      /** Once, or per delivery when `interval` is set. */
      price: number
      variant?: CartVariant
      /** Set when the line is a subscription. */
      interval?: Interval
    }
  | {available: false; reason: Unavailable}

/**
 * Whether a product (and variant) is on sale, as far as anyone can see. Stock counts are private,
 * so they are checked by the checkout route, on the server.
 */
export function lineStatus(
  product: CartProduct | undefined,
  variantKey?: string,
  max = MAX_QUANTITY,
  plan?: CartLine['plan'],
): LineStatus {
  const commerce = product?.commerce
  if (!product || !commerce) return {available: false, reason: 'missing'}
  if (commerce.availability === 'soldOut') return {available: false, reason: 'soldOut'}
  const subscription = plan === 'subscribe' ? readSubscription(commerce.subscription) : null
  if (plan === 'subscribe' && !subscription) return {available: false, reason: 'noSubscription'}
  const price = subscription ? subscription.price : commerce.price
  if (typeof price !== 'number') return {available: false, reason: 'noPrice'}

  const variants = commerce.variants ?? []
  let variant: CartVariant | undefined
  if (variants.length) {
    if (!variantKey) return {available: false, reason: 'chooseVariant'}
    variant = variants.find((candidate) => candidate._key === variantKey)
    if (!variant) return {available: false, reason: 'variantMissing'}
    if (variant.availability === 'soldOut') return {available: false, reason: 'soldOut'}
  } else if (variantKey) {
    return {available: false, reason: 'variantMissing'}
  }

  return {
    available: true,
    maxQuantity: max,
    price,
    variant,
    ...(subscription ? {interval: subscription.interval} : {}),
  }
}

/** Display name for a line: the product title, plus the variant label when there is one. */
export function lineName(
  product: Pick<CartProduct, 'title'>,
  variant?: Pick<CartVariant, 'label'>,
): string {
  const title = product.title ?? 'Product'
  return variant?.label ? `${title} – ${variant.label}` : title
}

/** Why the checkout turned a cart line down. */
export interface CheckoutProblem {
  productId: string
  variantKey?: string
  plan?: 'subscribe'
  name?: string
  /**
   * `otherInterval`: the cart holds subscriptions that repeat at different intervals, and one
   * checkout takes one interval.
   */
  reason: Unavailable | 'tooMany' | 'otherInterval'
  /** For `tooMany`: how many can be ordered. Left out when the shop hides what is left. */
  maxQuantity?: number
}

/** The problems in a checkout route's reply, as the browser reads them. */
export function readCheckoutProblems(value: unknown): CheckoutProblem[] {
  return asArray(value).filter(
    (item): item is CheckoutProblem =>
      isObject(item) && typeof item.productId === 'string' && typeof item.reason === 'string',
  )
}

/** A cart line with everything a cart page shows for it. */
export interface CartRow {
  line: CartLine
  product: CartProduct | undefined
  status: LineStatus
  name: string
  /** The line's quantity, capped at what can be ordered. 0 when the line can't be bought. */
  quantity: number
  /** Price times quantity, in currency units. 0 when the line can't be bought. */
  total: number
}

/** Joins the cart's lines with their products, as read from Sanity for the cart page. */
export function cartRows(
  lines: readonly CartLine[],
  products: readonly CartProduct[],
  max = MAX_QUANTITY,
): CartRow[] {
  const byId = new Map(products.map((product) => [product._id, product]))
  return lines.map((line) => {
    const product = byId.get(line.productId)
    const status = lineStatus(product, line.variantKey, max, line.plan)
    const name = product ? lineName(product, status.available ? status.variant : undefined) : 'Item'
    const quantity = status.available ? Math.min(line.quantity, status.maxQuantity) : 0
    const total = status.available ? status.price * quantity : 0
    return {line, product, status, name, quantity, total}
  })
}

/** What the cart's lines add up to, in currency units, before shipping. */
export function cartSubtotal(rows: readonly CartRow[]): number {
  return rows.reduce((sum, row) => sum + row.total, 0)
}
