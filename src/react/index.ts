'use client'

/**
 * `sanity-plugin-stripe/react`: the cart, for the browser. It imports neither Sanity nor Stripe.
 * A server component takes the plain helpers (queries, regions, prices) from
 * `sanity-plugin-stripe/server`, since everything here is client code to a React server.
 */
export {CartProvider, useCart, type Cart, type CartProviderProps} from './cart'
export {ClearCartOnReturn, type ClearCartOnReturnProps} from './ClearCartOnReturn'
export {useBuyBox, type BuyBox} from './useBuyBox'
export {
  useCheckout,
  type Checkout,
  type CheckoutState,
  type UseCheckoutOptions,
} from './useCheckout'

export {
  cartRows,
  cartSubtotal,
  describeInterval,
  lineKey,
  readSubscription,
  type Availability,
  type CartLine,
  type CartProduct,
  type CartRow,
  type CartVariant,
  type CheckoutProblem,
  type Interval,
  type LineStatus,
  type Unavailable,
} from '../core/cart'
export {formatMoney, formatPrice} from '../core/money'
export {shippingQuote, type RegionOption, type ShippingQuote} from '../core/regions'
