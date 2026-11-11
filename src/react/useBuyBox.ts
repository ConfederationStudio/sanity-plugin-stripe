import {useState} from 'react'

import {
  lineKey,
  lineStatus,
  readSubscription,
  type CartProduct,
  type CartVariant,
  type Interval,
  type LineStatus,
} from '../core/cart'
import {useCart} from './cart'

export interface BuyBox {
  /** The product's variants, each with whether it can be bought. Empty for a product without any. */
  variants: Array<CartVariant & {available: boolean}>
  /** The chosen variant: the first one on sale, until the buyer picks another. */
  variantKey: string | undefined
  chooseVariant: (variantKey: string) => void
  /** The subscription the product offers: its price per delivery and how often. Null without one. */
  subscription: {price: number; interval: Interval} | null
  /** Whether the buyer buys once or subscribes. `once` until they choose. */
  plan: 'once' | 'subscribe'
  choosePlan: (plan: 'once' | 'subscribe') => void
  /** Nothing of this product can be bought. */
  soldOut: boolean
  /** Whether the chosen product, variant and plan can be bought, its price and how many. */
  status: LineStatus
  /** How many of the chosen product, variant and plan the cart holds. */
  inCart: number
  /** The cart already holds as many as can be ordered. */
  full: boolean
  /** True after `add`, until the buyer picks another variant or plan. */
  added: boolean
  add: (quantity?: number) => void
}

/**
 * What a product page's buy button needs: the variants, which one is chosen, buying once or
 * subscribing, whether it can be bought, and adding it to the cart. The markup is yours.
 */
export function useBuyBox(product: CartProduct): BuyBox {
  const cart = useCart()
  const max = cart.maxQuantity
  const variants = (product.commerce?.variants ?? []).map((variant) =>
    Object.assign({}, variant, {available: lineStatus(product, variant._key, max).available}),
  )
  const firstAvailable = variants.find((variant) => variant.available)
  const [chosen, setChosen] = useState<string>()
  const [wanted, setWanted] = useState<'once' | 'subscribe'>('once')
  const [added, setAdded] = useState(false)

  const subscription = readSubscription(product.commerce?.subscription)
  // A product that stops offering a subscription falls back to buying once.
  const plan = subscription ? wanted : 'once'
  const subscribe: {plan?: 'subscribe'} = plan === 'subscribe' ? {plan} : {}
  const variantKey = chosen ?? firstAvailable?._key
  const status = lineStatus(product, variantKey, max, subscribe.plan)
  const soldOut = variants.length
    ? !firstAvailable
    : !lineStatus(product, variantKey, max).available
  const line = {productId: product._id, ...(variantKey ? {variantKey} : {}), ...subscribe}
  const inCart = cart.lines.find((candidate) => lineKey(candidate) === lineKey(line))?.quantity ?? 0

  return {
    variants,
    variantKey,
    chooseVariant(key) {
      setChosen(key)
      setAdded(false)
    },
    subscription,
    plan,
    choosePlan(next) {
      setWanted(next)
      setAdded(false)
    },
    soldOut,
    status,
    inCart,
    full: status.available && inCart >= status.maxQuantity,
    added,
    add(quantity = 1) {
      if (!status.available) return
      cart.add({...line, quantity}, status.maxQuantity)
      setAdded(true)
    },
  }
}
