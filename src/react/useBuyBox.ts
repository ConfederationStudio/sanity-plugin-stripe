import {useState} from 'react'

import {
  lineKey,
  lineStatus,
  type CartProduct,
  type CartVariant,
  type LineStatus,
} from '../core/cart'
import {useCart} from './cart'

export interface BuyBox {
  /** The product's variants, each with whether it can be bought. Empty for a product without any. */
  variants: Array<CartVariant & {available: boolean}>
  /** The chosen variant: the first one on sale, until the buyer picks another. */
  variantKey: string | undefined
  chooseVariant: (variantKey: string) => void
  /** Nothing of this product can be bought. */
  soldOut: boolean
  /** Whether the chosen product and variant can be bought, its price and how many. */
  status: LineStatus
  /** How many of the chosen product and variant the cart holds. */
  inCart: number
  /** The cart already holds as many as can be ordered. */
  full: boolean
  /** True after `add`, until the buyer picks another variant. */
  added: boolean
  add: (quantity?: number) => void
}

/**
 * What a product page's buy button needs: the variants, which one is chosen, whether it can be
 * bought, and adding it to the cart. The markup is yours.
 */
export function useBuyBox(product: CartProduct): BuyBox {
  const cart = useCart()
  const max = cart.maxQuantity
  const variants = (product.commerce?.variants ?? []).map((variant) =>
    Object.assign({}, variant, {available: lineStatus(product, variant._key, max).available}),
  )
  const firstAvailable = variants.find((variant) => variant.available)
  const [chosen, setChosen] = useState<string>()
  const [added, setAdded] = useState(false)

  const variantKey = chosen ?? firstAvailable?._key
  const status = lineStatus(product, variantKey, max)
  const soldOut = variants.length ? !firstAvailable : !status.available
  const line = {productId: product._id, ...(variantKey ? {variantKey} : {})}
  const inCart = cart.lines.find((candidate) => lineKey(candidate) === lineKey(line))?.quantity ?? 0

  return {
    variants,
    variantKey,
    chooseVariant(key) {
      setChosen(key)
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
