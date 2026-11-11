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
import type {ProductStock} from '../core/stock'
import {buildCheckoutSession} from './checkout'
import {classifyEvent, verifyEvent} from './events'
import {once, oncePerInvoice} from './once'
import {getOrder, getRenewal, type Order} from './order'
import type {SanityReader, SanityWriter} from './sanity'
import {decrementStock, readStock, type StockChange} from './stock'

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

/** Stripe wants 30 minutes at least, counted on its own clock: leave a minute's margin. */
const SHORTEST_EXPIRY = 31 * 60

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
  /**
   * Reads products and the shop settings, without a token, so it sees published documents only.
   * It must skip the CDN, so prices are fresh.
   */
  client: SanityReader
  /**
   * A Sanity client with a token, to read stock counts, which the public can't. Without it nothing
   * is counted and the shop sells by the on-sale switch alone.
   */
  stockClient?: SanityReader | null
  /** ISO 4217 code, the same one the Studio plugin has. */
  currency: string
  /**
   * Where Stripe sends the buyer after paying: a path on the site or a full address. Include
   * `{CHECKOUT_SESSION_ID}`, such as `/shop/thanks?session_id={CHECKOUT_SESSION_ID}`.
   */
  successUrl: string
  /** Where Stripe's back link goes: the cart. A path or a full address. */
  cancelUrl: string
  /**
   * Marks this shop's sessions: the webhook fulfils only sessions that carry it, and the Stripe
   * Dashboard groups them by it. Give the webhook route the same value. End it with 8 random
   * letters, such as `myshop_qhzvmkpt`.
   */
  integrationIdentifier: string
  /** Where the site keeps its products. Default: `product` documents with a `commerce` field. */
  products?: ProductQueryOptions
  /** Stripe tax rate ids (`txr_…`) by tax class, so receipts show the tax. */
  taxRates?: Partial<Record<string, string>>
  /** Most of one item a buyer can order at once. Default 10. */
  maxQuantity?: number
  /** Answer "not that many left" without saying how many, when a cart asks for too many. */
  hideRemaining?: boolean
  /** Minutes until an unpaid session expires, about 30 at least. Stripe's default is 24 hours. */
  expiresInMinutes?: number
  /**
   * Shows a field for a promotion code on Stripe's page. Codes are made in the Stripe Dashboard,
   * one per checkout. On a subscription, the code's coupon says whether renewals are discounted.
   */
  promotionCodes?: boolean
  /** Changes the session before it is created: phone numbers, consent, a customer. */
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
 * shipping region; prices, stock and shipping are read fresh from Sanity here. A cart with a
 * subscription in it becomes a subscription checkout; anything bought once in the same cart is
 * charged with the first payment.
 *
 * ```ts
 * // app/api/checkout/route.ts
 * export const POST = checkoutRoute({stripe, client, stockClient, currency: 'eur', …})
 * ```
 *
 * It answers `{url}` to go to, or `{error, message, problems}`.
 */
export function checkoutRoute(options: CheckoutRouteOptions): Handler {
  const {client, currency, log = consoleLog} = options
  const messages = {...CHECKOUT_MESSAGES, ...options.messages}
  const productsQuery = checkoutProductsQuery(options.products)
  let saidUncounted = false

  const unavailable = (detail: string, status = 503) => {
    log('error', `[checkout] ${detail}`)
    return json(
      {error: 'unavailable', message: messages.unavailable, ...(options.debug ? {detail} : {})},
      status,
    )
  }

  return async (request) => {
    const {stripe, stockClient} = options
    if (!stripe) return unavailable('There is no Stripe key. Set one in the environment.')

    const body: unknown = await request.json().catch(() => null)
    if (!isObject(body)) return json({error: 'invalid', message: messages.invalid}, 400)

    const lines = sanitizeLines(body.lines, options.maxQuantity)
    const ids = [...new Set(lines.map((line) => line.productId))]
    let products: CartProduct[]
    let settings: ShopSettings | null
    let stock: Map<string, ProductStock> | undefined
    try {
      const [foundProducts, foundSettings, foundStock] = await Promise.all([
        ids.length ? client.fetch(productsQuery, {ids}) : [],
        client.fetch(SHOP_SETTINGS_QUERY),
        stockClient ? readStock(stockClient, ids) : undefined,
      ])
      products = readCartProducts(foundProducts)
      settings = readShopSettings(foundSettings)
      stock = foundStock
    } catch (error) {
      return unavailable(`Sanity could not be read: ${reason(error)}`, 502)
    }
    if (!stockClient && !saidUncounted) {
      saidUncounted = true
      log('info', '[checkout] No stockClient: stock counts are not checked at checkout.')
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
      integrationIdentifier: options.integrationIdentifier,
      ...(stock ? {stock} : {}),
      ...(options.hideRemaining ? {hideRemaining: true} : {}),
      ...(options.promotionCodes ? {promotionCodes: true} : {}),
      ...(settings?.subscriptionDelivery
        ? {subscriptionDelivery: settings.subscriptionDelivery}
        : {}),
      ...(options.taxRates ? {taxRates: options.taxRates} : {}),
      ...(options.maxQuantity ? {maxQuantity: options.maxQuantity} : {}),
      ...(options.expiresInMinutes
        ? {
            expiresAt:
              Math.floor(Date.now() / 1000) +
              Math.max(SHORTEST_EXPIRY, options.expiresInMinutes * 60),
          }
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

const subscriptionOf = (invoice: Stripe.Invoice): string | null => {
  const subscription = invoice.parent?.subscription_details?.subscription
  return typeof subscription === 'string' ? subscription : (subscription?.id ?? null)
}

export interface OrderContext {
  /** The shop settings as published. Null before they are published. */
  settings: ShopSettings | null
  /** What the order did to stock counts. Empty when nothing ordered is counted. */
  stock: StockChange[]
  /**
   * Set when stock could not be lowered, with the reason: say so to whoever packs the order.
   * Stripe is asked to deliver the event again, and only the stock is tried again.
   */
  stockError?: string
  /** The Checkout Session that took the order. */
  session: Stripe.Checkout.Session
  stripe: Stripe
}

export interface RenewalContext extends OrderContext {
  /** The paid invoice. `session` is the Checkout Session that started the subscription. */
  invoice: Stripe.Invoice
}

export interface SubscriptionContext {
  /** The Checkout Session that started the subscription. */
  session: Stripe.Checkout.Session
  stripe: Stripe
}

export interface WebhookRouteOptions {
  /** From `createStripe`. */
  stripe: Stripe | null | undefined
  /** The endpoint's signing secret (`whsec_…`), from the environment. */
  webhookSecret: string | undefined
  /** The same value the checkout route has. Sessions without it are not this shop's. */
  integrationIdentifier: string
  /** Reads the shop settings, without a token. It must skip the CDN. */
  client: SanityReader
  /**
   * A Sanity client with a token that can write, to lower stock counts when an order is paid.
   * Without one, stock is left as it is.
   */
  stockClient?: SanityWriter | null
  /** Where the site keeps its products. The same as the checkout route's. */
  products?: ProductQueryOptions
  /**
   * Called once for each paid order, after stock is lowered: send the order email here. Throw
   * and Stripe delivers the event again later; stock isn't lowered twice.
   */
  onOrder?: (order: Order, context: OrderContext) => void | Promise<void>
  /** Called when a delayed payment (a bank transfer, for one) fails. Nothing was fulfilled. */
  onPaymentFailed?: (session: Stripe.Checkout.Session) => void | Promise<void>
  /**
   * Called once for each paid renewal of a subscription, after stock is lowered: there is a
   * parcel to send again. The order's address is the customer's as it is now. The first payment
   * of a subscription is not a renewal: it reaches `onOrder`.
   */
  onRenewal?: (order: Order, context: RenewalContext) => void | Promise<void>
  /**
   * Called when a renewal's payment fails. Stripe tries again and writes to the customer by
   * itself, so there is nothing that has to be done here. It can be called more than once.
   */
  onRenewalFailed?: (invoice: Stripe.Invoice, context: SubscriptionContext) => void | Promise<void>
  /** Called when a subscription ends: cancelled, or given up on after failed payments. */
  onSubscriptionEnded?: (
    subscription: Stripe.Subscription,
    context: SubscriptionContext,
  ) => void | Promise<void>
  /**
   * Called for every other event the endpoint receives, once its signature is checked: a
   * dispute, a refund. These are not sorted by shop: they are the Stripe account's.
   */
  onEvent?: (event: Stripe.Event, context: {stripe: Stripe}) => void | Promise<void>
  log?: Log
}

/**
 * The site's Stripe webhook. A paid order of this shop lowers stock and calls `onOrder`, each
 * once per payment however often Stripe delivers the event. A paid renewal of a subscription
 * does the same and calls `onRenewal`. Payments made any other way on the same Stripe account (a
 * Payment Link, another site) are left alone. Nothing is fulfilled on the thank-you page.
 *
 * ```ts
 * // app/api/stripe/webhook/route.ts
 * export const POST = webhookRoute({stripe, webhookSecret, integrationIdentifier, client, …})
 * ```
 *
 * Point a Stripe webhook endpoint at it with the events in `WEBHOOK_EVENTS`.
 */
export function webhookRoute(options: WebhookRouteOptions): Handler {
  const {client, log = consoleLog} = options
  // Fail when the site starts, not on the first order.
  resolveProductQuery(options.products)
  let saidUncounted = false

  /**
   * The session as this client's API version shapes it, or null when it isn't this shop's. The
   * event carries the session as the endpoint's version shapes it, so it is read again.
   */
  const ownSession = async (stripe: Stripe, sessionId: string) => {
    const session = await stripe.checkout.sessions.retrieve(sessionId)
    const own =
      session.mode !== 'setup' && session.integration_identifier === options.integrationIdentifier
    if (!own) log('info', `[stripe webhook] ${sessionId}: not one of this shop's, left alone.`)
    return own ? session : null
  }

  /** Lowers stock for a paid order or renewal, once per `id`: a session's or an invoice's. */
  const lowerStock = async (id: string, order: Order, settings: ShopSettings | null) => {
    if (!options.stockClient) {
      if (!saidUncounted) {
        saidUncounted = true
        log('info', '[stripe webhook] No stockClient: stock counts are left as they are.')
      }
      return {stock: []}
    }
    try {
      const result = await decrementStock(
        options.stockClient,
        {sessionId: id, items: order.items},
        {
          autoSoldOut: settings?.autoSoldOut ?? true,
          ...(options.products ? {products: options.products} : {}),
        },
      )
      if (result.status === 'lowered') {
        const summary = result.changes
          .map(
            ({productId, variantKey, from, to}) =>
              `${productId}${variantKey ? ` ${variantKey}` : ''} ${from} → ${to}`,
          )
          .join(', ')
        log('info', `[stripe webhook] ${id}: stock ${summary}`)
      }
      return {stock: result.changes}
    } catch (error) {
      // The order still has to reach the shop. It is told, and Stripe is asked to come back.
      const stockError = reason(error)
      log('error', `[stripe webhook] ${id}: stock was not lowered: ${stockError}`)
      return {stock: [], stockError}
    }
  }

  const fulfil = async (stripe: Stripe, sessionId: string) => {
    const session = await ownSession(stripe, sessionId)
    if (!session) return
    // Trust the payment status Stripe's API gives now over the one in the event.
    if (session.payment_status === 'unpaid') {
      log('info', `[stripe webhook] ${sessionId}: not paid yet.`)
      return
    }
    const [order, foundSettings] = await Promise.all([
      getOrder(stripe, session),
      client.fetch(SHOP_SETTINGS_QUERY),
    ])
    const settings = readShopSettings(foundSettings)
    const {stock, stockError} = await lowerStock(sessionId, order, settings)

    const {onOrder} = options
    if (onOrder) {
      const outcome = await once(stripe, session, 'order', async () => {
        await onOrder(order, {
          settings,
          stock,
          ...(stockError ? {stockError} : {}),
          session,
          stripe,
        })
      })
      log('info', `[stripe webhook] ${sessionId}: order ${outcome}.`)
    }

    if (stockError) throw new Error(`Stock was not lowered: ${stockError}`)
  }

  /**
   * The Checkout Session that started a subscription, or null when the subscription isn't this
   * shop's. It is looked up in Stripe, not taken from a label on the invoice.
   */
  const startedBy = async (stripe: Stripe, subscriptionId: string) => {
    const {data} = await stripe.checkout.sessions.list({subscription: subscriptionId, limit: 1})
    const session = data[0]
    const own = session?.integration_identifier === options.integrationIdentifier
    if (!own) log('info', `[stripe webhook] ${subscriptionId}: not one of this shop's, left alone.`)
    return own ? session : null
  }

  const renew = async (stripe: Stripe, invoiceId: string) => {
    // Read again: as this client's API version shapes it, and with the status it has now.
    const invoice = await stripe.invoices.retrieve(invoiceId)
    const subscriptionId = subscriptionOf(invoice)
    // A subscription's first invoice is the order the checkout's own event fulfils.
    if (!subscriptionId || invoice.billing_reason !== 'subscription_cycle') return
    const session = await startedBy(stripe, subscriptionId)
    if (!session) return
    if (invoice.status !== 'paid') {
      log('info', `[stripe webhook] ${invoiceId}: not paid yet.`)
      return
    }
    const [order, foundSettings] = await Promise.all([
      getRenewal(stripe, invoice, session, subscriptionId),
      client.fetch(SHOP_SETTINGS_QUERY),
    ])
    const settings = readShopSettings(foundSettings)
    // The renewal is paid already, so it can take a count below 0: `onRenewal` is told.
    const {stock, stockError} = await lowerStock(invoiceId, order, settings)

    const {onRenewal} = options
    if (onRenewal) {
      const outcome = await oncePerInvoice(stripe, invoice, 'renewal', async () => {
        await onRenewal(order, {
          settings,
          stock,
          ...(stockError ? {stockError} : {}),
          session,
          invoice,
          stripe,
        })
      })
      log('info', `[stripe webhook] ${invoiceId}: renewal ${outcome}.`)
    }

    if (stockError) throw new Error(`Stock was not lowered: ${stockError}`)
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
        case 'failed': {
          const session = await ownSession(stripe, result.session.id)
          if (session) {
            log('warn', `[stripe webhook] ${session.id}: the delayed payment failed.`)
            await options.onPaymentFailed?.(session)
          }
          break
        }
        case 'invoicePaid':
          await renew(stripe, result.invoice.id)
          break
        case 'invoiceFailed': {
          const {onRenewalFailed} = options
          if (!onRenewalFailed) break
          const invoice = await stripe.invoices.retrieve(result.invoice.id)
          const subscriptionId = subscriptionOf(invoice)
          const session = subscriptionId ? await startedBy(stripe, subscriptionId) : null
          if (session) {
            log('warn', `[stripe webhook] ${invoice.id}: a renewal's payment failed.`)
            await onRenewalFailed(invoice, {session, stripe})
          }
          break
        }
        case 'subscriptionEnded': {
          const {onSubscriptionEnded} = options
          if (!onSubscriptionEnded) break
          const session = await startedBy(stripe, result.subscription.id)
          if (session) {
            const subscription = await stripe.subscriptions.retrieve(result.subscription.id)
            log('info', `[stripe webhook] ${subscription.id}: the subscription ended.`)
            await onSubscriptionEnded(subscription, {session, stripe})
          }
          break
        }
        case 'ignored':
          await options.onEvent?.(event, {stripe})
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

// Customer portal

export interface PortalRouteOptions {
  /** From `createStripe`. */
  stripe: Stripe | null | undefined
  /** What a visitor reads when the portal can't be opened. */
  message?: string
  log?: Log
}

/** How long the portal's address is kept before Stripe is asked for it again. */
const PORTAL_LINK_AGE = 5 * 60 * 1000

/**
 * Sends a visitor to Stripe's customer portal, where a subscriber changes their card or address,
 * pauses or cancels, and finds their invoices. There are no accounts to build: the visitor types
 * their email on Stripe's page and Stripe emails them a link in.
 *
 * ```ts
 * // app/account/route.ts
 * export const GET = portalRoute({stripe})
 * ```
 *
 * Switch the portal's login link on once, in the Stripe Dashboard under Settings, Billing,
 * Customer portal, and choose there what subscribers may change.
 */
export function portalRoute(options: PortalRouteOptions): () => Promise<Response> {
  const {log = consoleLog} = options
  let link: {url: string; at: number} | undefined

  const unavailable = (detail: string) => {
    log('error', `[portal] ${detail}`)
    return new Response(options.message ?? "The account page isn't available right now.", {
      status: 503,
      headers: {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'},
    })
  }

  return async () => {
    const {stripe} = options
    if (!stripe) return unavailable('There is no Stripe key. Set one in the environment.')
    if (!link || Date.now() - link.at > PORTAL_LINK_AGE) {
      try {
        const {data} = await stripe.billingPortal.configurations.list({is_default: true, limit: 1})
        const url = data[0]?.login_page.url
        if (!url)
          return unavailable(
            'The customer portal has no login link. Activate it in the Stripe Dashboard: Settings, Billing, Customer portal.',
          )
        link = {url, at: Date.now()}
      } catch (error) {
        return unavailable(`Stripe could not be asked for the portal's address: ${reason(error)}`)
      }
    }
    return new Response(null, {
      status: 303,
      headers: {'Location': link.url, 'Cache-Control': 'no-store'},
    })
  }
}
