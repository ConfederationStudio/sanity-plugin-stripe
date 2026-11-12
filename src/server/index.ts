/**
 * `sanity-plugin-stripe/server`: the site's checkout route, Stripe webhook, customer portal
 * route and the routes the Studio's Orders tab calls. Web `Request` and `Response` only, so the handlers fit Next.js, Remix, Astro, SvelteKit
 * or Hono. It imports neither Sanity nor React.
 */
export {dashboardUrl, orderEmail, type OrderEmail, type OrderEmailOptions} from './email'
export {WEBHOOK_EVENTS} from './events'
export type {Order, OrderItem} from './order'
export {
  checkoutRoute,
  portalRoute,
  webhookRoute,
  type CheckoutMessages,
  type CheckoutRouteOptions,
  type OrderContext,
  type PortalRouteOptions,
  type RenewalContext,
  type SubscriptionContext,
  type WebhookRouteOptions,
} from './routes'
export type {SanityReader, SanityTransaction, SanityWriter} from './sanity'
export {readStock, type StockChange} from './stock'
export {createStripe, STRIPE_API_VERSION} from './stripe'
export {studioRoutes, type StudioRoutes, type StudioRoutesOptions} from './studio'

// For the site's server components and queries.
export {
  describeInterval,
  readCartProducts,
  readSubscription,
  type Availability,
  type CartLine,
  type CartProduct,
  type CartVariant,
  type CheckoutProblem,
  type Interval,
} from '../core/cart'
export {EU_COUNTRIES} from '../core/countries'
export type {
  OrderAddress,
  OrderDetail,
  OrderDetailItem,
  OrderReply,
  OrdersReply,
  OrderStatus,
  OrderSummary,
  StudioRouteErrorCode,
} from '../core/orders'
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
  shippingQuote,
  type RegionOption,
  type ShippingQuote,
  type ShippingRegion,
  type ShopSettings,
  type SubscriptionDelivery,
} from '../core/regions'
export {stockLeft, type ProductStock} from '../core/stock'
