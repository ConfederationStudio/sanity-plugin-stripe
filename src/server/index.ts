/**
 * `sanity-plugin-stripe/server`: the site's checkout route and Stripe webhook. Web `Request` and
 * `Response` only, so the handlers fit Next.js, Remix, Astro, SvelteKit or Hono. It imports
 * neither Sanity nor React.
 */
export {dashboardUrl, orderEmail, type OrderEmail, type OrderEmailOptions} from './email'
export {WEBHOOK_EVENTS} from './events'
export type {Order, OrderItem} from './order'
export {
  checkoutRoute,
  webhookRoute,
  type CheckoutMessages,
  type CheckoutRouteOptions,
  type OrderContext,
  type WebhookRouteOptions,
} from './routes'
export type {SanityReader, SanityTransaction, SanityWriter} from './sanity'
export {readStock, type StockChange} from './stock'
export {createStripe, STRIPE_API_VERSION} from './stripe'

// For the site's server components and queries.
export {
  readCartProducts,
  type Availability,
  type CartLine,
  type CartProduct,
  type CartVariant,
  type CheckoutProblem,
} from '../core/cart'
export {EU_COUNTRIES} from '../core/countries'
export {formatMoney, formatPrice} from '../core/money'
export {
  cartProductProjection,
  cartProductsQuery,
  SHOP_SETTINGS_QUERY,
  type ProductQueryOptions,
} from '../core/queries'
export {
  readShopSettings,
  regionOptions,
  type RegionOption,
  type ShippingRegion,
  type ShopSettings,
} from '../core/regions'
export {stockLeft, type ProductStock} from '../core/stock'
