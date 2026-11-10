/**
 * `sanity-plugin-stripe/server`: the site's checkout route and Stripe webhook. Web `Request` and
 * `Response` only, so the handlers fit Next.js, Remix, Astro, SvelteKit or Hono. It imports
 * neither Sanity nor React.
 */
export {buildCheckoutSession, type CheckoutInput, type CheckoutResult} from './checkout'
export {dashboardUrl, orderEmail, type OrderEmail, type OrderEmailOptions} from './email'
export {classifyEvent, verifyEvent, WEBHOOK_EVENTS, type CheckoutEvent} from './events'
export {runOnce} from './once'
export {getOrder, type Order, type OrderItem} from './order'
export {
  checkoutRoute,
  webhookRoute,
  type CheckoutMessages,
  type CheckoutRouteOptions,
  type OrderContext,
  type WebhookRouteOptions,
} from './routes'
export type {SanityReader, SanityTransaction, SanityWriter} from './sanity'
export {decrementStock, type StockChange, type StockOptions, type StockResult} from './stock'
export {createStripe, STRIPE_API_VERSION} from './stripe'

export {
  cartRows,
  cartSubtotal,
  lineKey,
  lineName,
  lineStatus,
  MAX_QUANTITY,
  readCartProducts,
  sanitizeLines,
  type Availability,
  type CartLine,
  type CartProduct,
  type CartRow,
  type CartVariant,
  type CheckoutProblem,
  type LineStatus,
  type Unavailable,
} from '../core/cart'
export {EU_COUNTRIES, STRIPE_SHIPPING_COUNTRIES} from '../core/countries'
export {SHOP_SETTINGS_ID, SHOP_SETTINGS_TYPE} from '../core/ids'
export {formatMoney, formatPrice, toMinorUnits} from '../core/money'
export {
  cartProductProjection,
  cartProductsQuery,
  checkoutProductsQuery,
  COMMERCE_PROJECTION,
  SHOP_SETTINGS_QUERY,
  type ProductQueryOptions,
} from '../core/queries'
export {
  readShopSettings,
  regionOptions,
  regionsFromSettings,
  resolveRegions,
  type RegionOption,
  type ShippingRegion,
  type ShopSettings,
} from '../core/regions'
