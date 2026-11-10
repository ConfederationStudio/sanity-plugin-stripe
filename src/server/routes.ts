import type Stripe from 'stripe'

import {readCartProducts, sanitizeLines, type CartLine, type CartProduct} from '../core/cart'
import {isObject} from '../core/guards'
import {
  checkoutProductsQuery,
  resolveProductQuery,
  SHOP_SETTINGS_QUERY,
  type ProductQueryOptions,
} from '../core/queries'
import {
  readShopSettings,
  regionsFromSettings,
  type ShippingRegion,
  type ShopSettings,
} from '../core/regions'
import {buildCheckoutSession} from './checkout'
import {classifyEvent, verifyEvent} from './events'
import {runOnce} from './once'
import {getOrder, type Order} from './order'
import type {SanityReader, SanityWriter} from './sanity'
import {decrementStock, type StockChange} from './stock'

type Handler = (request: Request) => Promise<Response>
type Log = (level: 'info' | 'warn' | 'error', message: string) => void

// Info lines go to the server's log too: they say what each payment did to stock and orders.
const consoleLog: Log = (level, message) => console[level](message)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
  })

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Checkout

export interface CheckoutMessages {
  /** The checkout can't be started: no key, no shipping regions, or Stripe refused. */
  unavailable: string
  /** The request couldn't be read. */
  invalid: string
  empty: string
  /** No shipping region, or one that no longer exists. */
  region: string
  /** A product in the cart sold out, changed or went away. */
  changed: string
}

const CHECKOUT_MESSAGES: CheckoutMessages = {
  unavailable: "Checkout isn't available right now. Please try again later.",
  invalid: 'The cart could not be read.',
  empty: 'Your cart is empty.',
  region: 'Choose where to ship the order.',
  changed: 'Some things in your cart have changed. Check them and try again.',
}

export interface CheckoutRouteOptions {
  /** From `createStripe`. Without one the route answers 503, so a site runs before it has keys. */
  stripe: Stripe | null | undefined
  /** Reads products and the shop settings. It must skip the CDN, so prices and stock are fresh. */
  client: SanityReader
  /** ISO 4217 code, the same one the Studio plugin has. */
  currency: string
  /**
   * Where Stripe sends the buyer after paying: a path on the site or a full address. Include
   * `{CHECKOUT_SESSION_ID}`, such as `/shop/thanks?session_id={CHECKOUT_SESSION_ID}`.
   */
  successUrl: string
  /** Where Stripe's back link goes: the cart. A path or a full address. */
  cancelUrl: string
  /** Where the site keeps its products. Default: `product` documents with a `commerce` field. */
  products?: ProductQueryOptions
  /** Tags the shop's sessions in the Stripe Dashboard. End it with 8 random letters. */
  integrationIdentifier?: string
  /** Stripe tax rate ids (`txr_…`) by tax class, so receipts show the tax. */
  taxRates?: Partial<Record<string, string>>
  /** Most of one item a buyer can order at once. Default 10. */
  maxQuantity?: number
  /** Minutes until an unpaid session expires, 30 at least. Stripe's default is 24 hours. */
  expiresInMinutes?: number
  /** Changes the session before it is created: promotion codes, phone numbers, consent. */
  extend?: (
    params: Stripe.Checkout.SessionCreateParams,
    context: {lines: CartLine[]; region: ShippingRegion; request: Request},
  ) => Stripe.Checkout.SessionCreateParams | Promise<Stripe.Checkout.SessionCreateParams>
  /** What buyers read when the checkout can't start. */
  messages?: Partial<CheckoutMessages>
  /** Adds the reason to error replies. For development only. */
  debug?: boolean
  log?: Log
}

/**
 * The site's checkout route. The browser posts the cart's product references and the chosen
 * shipping region; prices, stock and shipping are read fresh from Sanity here.
 *
 * ```ts
 * // app/api/checkout/route.ts
 * export const POST = checkoutRoute({stripe, client, currency: 'eur', successUrl, cancelUrl})
 * ```
 *
 * It answers `{url}` to go to, or `{error, message, problems}`.
 */
export function checkoutRoute(options: CheckoutRouteOptions): Handler {
  const {client, currency, log = consoleLog} = options
  const messages = {...CHECKOUT_MESSAGES, ...options.messages}
  const productsQuery = checkoutProductsQuery(options.products)

  const unavailable = (detail: string, status = 503) => {
    log('error', `[checkout] ${detail}`)
    return json(
      {error: 'unavailable', message: messages.unavailable, ...(options.debug ? {detail} : {})},
      status,
    )
  }

  return async (request) => {
    const {stripe} = options
    if (!stripe) return unavailable('There is no Stripe key. Set one in the environment.')

    const body: unknown = await request.json().catch(() => null)
    if (!isObject(body)) return json({error: 'invalid', message: messages.invalid}, 400)

    const lines = sanitizeLines(body.lines, options.maxQuantity)
    const ids = [...new Set(lines.map((line) => line.productId))]
    let products: CartProduct[]
    let settings: ShopSettings | null
    try {
      const [foundProducts, foundSettings] = await Promise.all([
        ids.length ? client.fetch(productsQuery, {ids}) : [],
        client.fetch(SHOP_SETTINGS_QUERY),
      ])
      products = readCartProducts(foundProducts)
      settings = readShopSettings(foundSettings)
    } catch (error) {
      return unavailable(`Sanity could not be read: ${reason(error)}`, 502)
    }
    const regions = regionsFromSettings(settings)
    if (!regions.length)
      return unavailable('No shipping regions. Publish the shop settings in the Studio.')

    const origin = new URL(request.url).origin
    const result = buildCheckoutSession({
      lines,
      regionId: body.regionId,
      products,
      regions,
      currency,
      successUrl: absoluteUrl(options.successUrl, origin),
      cancelUrl: absoluteUrl(options.cancelUrl, origin),
      ...(options.integrationIdentifier
        ? {integrationIdentifier: options.integrationIdentifier}
        : {}),
      ...(options.taxRates ? {taxRates: options.taxRates} : {}),
      ...(options.maxQuantity ? {maxQuantity: options.maxQuantity} : {}),
      ...(options.expiresInMinutes
        ? {expiresAt: Math.floor(Date.now() / 1000) + Math.max(30, options.expiresInMinutes) * 60}
        : {}),
    })

    if (!result.ok) {
      const message = {
        empty: messages.empty,
        region: messages.region,
        unavailable: messages.changed,
      }[result.error]
      return json({error: result.error, message, problems: result.problems}, 409)
    }

    try {
      const params = options.extend
        ? await options.extend(result.params, {lines: result.lines, region: result.region, request})
        : result.params
      const session = await stripe.checkout.sessions.create(params)
      if (!session.url)
        return unavailable(`Checkout Session ${session.id} came back without a URL.`, 502)
      return json({url: session.url})
    } catch (error) {
      return unavailable(`Stripe refused the Checkout Session: ${reason(error)}`, 502)
    }
  }
}

/** Stripe needs full addresses. `{CHECKOUT_SESSION_ID}` must reach it as written, not encoded. */
function absoluteUrl(url: string, origin: string): string {
  return /^https?:\/\//.test(url) ? url : `${origin}${url.startsWith('/') ? '' : '/'}${url}`
}

// Webhook

export interface OrderContext {
  /** The shop settings as published, with the order email. Null before they are published. */
  settings: ShopSettings | null
  /** What the order did to stock counts. Empty when nothing ordered has a count. */
  stock: StockChange[]
  session: Stripe.Checkout.Session
  stripe: Stripe
}

export interface WebhookRouteOptions {
  /** From `createStripe`. */
  stripe: Stripe | null | undefined
  /** The endpoint's signing secret (`whsec_…`), from the environment. */
  webhookSecret: string | undefined
  /** Reads the shop settings. It must skip the CDN. */
  client: SanityReader
  /** Lowers stock counts when an order is paid. Without one, stock is left as it is. */
  writeClient?: SanityWriter | null
  /** Where the site keeps its products. The same as the checkout route's. */
  products?: ProductQueryOptions
  /**
   * Called once for each paid order, after stock is lowered: send the order email here. Throw
   * and Stripe delivers the event again later; stock isn't lowered twice.
   */
  onOrder?: (order: Order, context: OrderContext) => void | Promise<void>
  /** Called when a delayed payment (a bank transfer, for one) fails. Nothing was fulfilled. */
  onPaymentFailed?: (session: Stripe.Checkout.Session) => void | Promise<void>
  log?: Log
}

/**
 * The site's Stripe webhook. A paid order lowers stock and calls `onOrder`, each once per
 * payment however often Stripe delivers the event. Nothing is fulfilled on the thank-you page.
 *
 * ```ts
 * // app/api/stripe/webhook/route.ts
 * export const POST = webhookRoute({stripe, webhookSecret, client, writeClient, onOrder})
 * ```
 *
 * Point a Stripe webhook endpoint at it with the events in `WEBHOOK_EVENTS`.
 */
export function webhookRoute(options: WebhookRouteOptions): Handler {
  const {client, log = consoleLog} = options
  // Fail when the site starts, not on the first order.
  resolveProductQuery(options.products)

  const fulfil = async (stripe: Stripe, sessionId: string) => {
    // The event carries the session as the endpoint's API version shapes it. Read it again, as
    // this client's version shapes it, and trust that one's payment status.
    const session = await stripe.checkout.sessions.retrieve(sessionId)
    if (session.payment_status === 'unpaid') {
      log('info', `[stripe webhook] ${sessionId}: not paid yet.`)
      return
    }
    const [order, foundSettings] = await Promise.all([
      getOrder(stripe, session),
      client.fetch(SHOP_SETTINGS_QUERY),
    ])
    const settings = readShopSettings(foundSettings)

    let stock: StockChange[] = []
    if (options.writeClient) {
      const result = await decrementStock(options.writeClient, order, {
        autoSoldOut: settings?.autoSoldOut ?? true,
        ...(options.products ? {products: options.products} : {}),
      })
      stock = result.changes
      if (result.status === 'lowered') {
        const summary = stock
          .map((change) => `${change.documentId} ${change.from} → ${change.to}`)
          .join(', ')
        log('info', `[stripe webhook] ${sessionId}: stock ${summary}`)
      }
    }

    const {onOrder} = options
    if (onOrder) {
      const outcome = await runOnce(stripe, order.paymentIntentId, 'order', async () => {
        await onOrder(order, {settings, stock, session, stripe})
      })
      log('info', `[stripe webhook] ${sessionId}: order ${outcome}.`)
    }
  }

  return async (request) => {
    const {stripe, webhookSecret} = options
    if (!stripe || !webhookSecret) {
      log('error', '[stripe webhook] The Stripe key or the webhook secret is not set.')
      return json({error: 'Webhook not configured'}, 503)
    }

    // The signature covers the exact bytes Stripe sent, so read the body as text before parsing.
    const payload = await request.text()
    let event: Stripe.Event
    try {
      event = verifyEvent(stripe, payload, request.headers.get('stripe-signature'), webhookSecret)
    } catch (error) {
      log('warn', `[stripe webhook] Signature check failed: ${reason(error)}`)
      return json({error: 'Invalid signature'}, 400)
    }

    const result = classifyEvent(event)
    try {
      switch (result.type) {
        case 'paid':
          await fulfil(stripe, result.session.id)
          break
        case 'pending':
          log('info', `[stripe webhook] ${result.session.id}: waiting for a delayed payment.`)
          break
        case 'failed':
          log('warn', `[stripe webhook] ${result.session.id}: the delayed payment failed.`)
          await options.onPaymentFailed?.(result.session)
          break
        case 'ignored':
          break
      }
    } catch (error) {
      // A 500 makes Stripe deliver the event again. Steps that already finished are skipped then.
      log('error', `[stripe webhook] ${event.type} ${event.id} failed: ${reason(error)}`)
      return json({error: 'Fulfilment failed'}, 500)
    }

    return json({received: true})
  }
}
