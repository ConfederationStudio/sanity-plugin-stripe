import type Stripe from 'stripe'

import {describeInterval} from '../core/cart'
import {isObject} from '../core/guards'
import type {
  OrderAddress,
  OrderDetail,
  OrderReply,
  OrdersReply,
  OrderSummary,
  StudioRouteError,
  StudioRouteErrorCode,
} from '../core/orders'
import {isProjectId, SanityApiError, sanityEditor} from './editor'
import {dashboardUrl} from './email'
import {corsHeaders, globalFetch, originSet, reply} from './http'
import {finishedAt} from './once'
import {getOrder, getRenewal, subscriptionOf, type Order} from './order'

type Handler = (request: Request) => Promise<Response>
type Log = (level: 'info' | 'warn' | 'error', message: string) => void

const consoleLog: Log = (level, message) => console[level](message)

export interface StudioRoutesOptions {
  /** From `createStripe`. */
  stripe: Stripe | null | undefined
  /** The same value the checkout route has. Only orders that carry it are shown. */
  integrationIdentifier: string
  /** The Sanity project the Studio belongs to: it is asked who each caller is. */
  projectId: string
  /**
   * Where the Studio runs, such as `['https://example.sanity.studio']`. Other websites get no
   * answer. A Studio on the site's own address needs no entry.
   */
  studioOrigins?: readonly string[]
  /**
   * The project roles that may read orders, by name. Orders hold buyers' names and addresses, so
   * the default leaves viewers out: `['administrator', 'editor']`.
   */
  roles?: readonly string[]
  /**
   * Whether an API token of the project is answered like a person signed in to the Studio.
   * Default false: orders are for people, and a leaked token with editor rights gets none.
   */
  allowApiTokens?: boolean
  /** For tests. */
  fetch?: typeof fetch
  log?: Log
}

export interface StudioRoutes {
  GET: Handler
  OPTIONS: Handler
}

const STATUS: Record<StudioRouteErrorCode, number> = {
  'signed-out': 401,
  'not-member': 403,
  'forbidden-origin': 403,
  'forbidden-role': 403,
  'api-token': 403,
  'no-stripe': 503,
  'stripe-failed': 502,
  'sanity-failed': 502,
  'bad-request': 400,
  'not-found': 404,
}

class RouteError extends Error {
  readonly code: StudioRouteErrorCode
  constructor(code: StudioRouteErrorCode) {
    super(code)
    this.name = 'RouteError'
    this.code = code
  }
}

/** Orders in one answer. A second that holds the last of them is finished, so it can be more. */
const PAGE_SIZE = 25
/** How often Stripe is asked for older payments when a stretch holds none of this shop's. */
const MAX_ROUNDS = 4
const MAX_REMEMBERED = 5_000
const ORDER_ID = /^(?:cs|in)_[A-Za-z0-9_]{5,250}$/

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()
const statusOf = (error: unknown) => (isObject(error) ? error.statusCode : undefined)
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

function sessionSummary(session: Stripe.Checkout.Session): OrderSummary {
  const details = session.customer_details
  return {
    id: session.id,
    kind: 'order',
    createdAt: iso(session.created),
    status: session.payment_status === 'unpaid' ? 'unpaid' : 'paid',
    currency: session.currency ?? '',
    amountTotal: session.amount_total ?? 0,
    customer: {name: details?.name ?? null, email: details?.email ?? null},
    country:
      session.collected_information?.shipping_details?.address?.country ??
      details?.address?.country ??
      null,
    subscription: Boolean(session.subscription),
    livemode: session.livemode,
  }
}

function renewalSummary(invoice: Stripe.Invoice): OrderSummary {
  return {
    id: invoice.id,
    kind: 'renewal',
    createdAt: iso(invoice.created),
    status: invoice.status === 'paid' ? 'paid' : 'unpaid',
    currency: invoice.currency,
    amountTotal: invoice.total,
    customer: {name: invoice.customer_name, email: invoice.customer_email},
    country: invoice.customer_shipping?.address?.country ?? null,
    subscription: true,
    livemode: invoice.livemode,
  }
}

const readAddress = (address: Stripe.Address | null): OrderAddress | null =>
  address && {
    line1: address.line1,
    line2: address.line2,
    postalCode: address.postal_code,
    city: address.city,
    state: address.state,
    country: address.country,
  }

function orderDetail(
  summary: OrderSummary,
  order: Order,
  rest: Pick<OrderDetail, 'amountRefunded' | 'handledAt'>,
): OrderDetail {
  return {
    ...summary,
    items: order.items,
    amountShipping: order.amountShipping,
    regionTitle: order.regionTitle ?? null,
    phone: order.customer.phone,
    shipping: {name: order.shipping.name, address: readAddress(order.shipping.address)},
    interval: order.subscription?.interval ? describeInterval(order.subscription.interval) : null,
    stripeUrl: dashboardUrl(order),
    ...rest,
  }
}

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>) {
  const results: R[] = []
  for (let start = 0; start < items.length; start += size)
    // oxlint-disable-next-line no-await-in-loop -- a few at a time, so Stripe's rate limit holds
    results.push(...(await Promise.all(items.slice(start, start + size).map(run))))
  return results
}

/**
 * What the Studio's Orders tab asks the site. Orders are read from Stripe at that moment and
 * handed to a signed-in editor of the Sanity project: nothing about a buyer is saved in Sanity.
 *
 * ```ts
 * // app/api/shop/[...path]/route.ts
 * export const {GET, OPTIONS} = studioRoutes({stripe, integrationIdentifier, projectId})
 * ```
 *
 * - `GET …/orders`: this shop's orders and subscription renewals, newest first. `?before=` asks
 *   for older ones, with the `next` of the answer before.
 * - `GET …/orders/:id`: one of them in full: what to pack and where to send it.
 *
 * Every request must carry the editor's Sanity sign-in, which the Studio sends by itself. The
 * route asks Sanity whose it is and answers members with one of `roles` only, and no API token
 * unless `allowApiTokens` says so.
 */
export function studioRoutes(options: StudioRoutesOptions): StudioRoutes {
  if (!isProjectId(options.projectId))
    throw new TypeError('studioRoutes: projectId is not a Sanity project id')
  if (!options.integrationIdentifier)
    throw new TypeError('studioRoutes: integrationIdentifier is missing')

  const origins = originSet(options.studioOrigins ?? [])
  const roles = new Set(options.roles ?? ['administrator', 'editor'])
  const fetcher = options.fetch ?? globalFetch
  const {log = consoleLog} = options
  /** Whether a subscription was started by this shop's checkout. It never changes. */
  const owned = new Map<string, boolean>()

  const isOwn = (
    session: Stripe.Checkout.Session | undefined,
  ): session is Stripe.Checkout.Session =>
    session !== undefined &&
    session.mode !== 'setup' &&
    session.integration_identifier === options.integrationIdentifier

  /** The Checkout Session that started a subscription, or null when it isn't this shop's. */
  async function startedBy(stripe: Stripe, subscriptionId: string) {
    const {data} = await stripe.checkout.sessions.list({subscription: subscriptionId, limit: 1})
    const [session] = data
    if (owned.size >= MAX_REMEMBERED) owned.clear()
    owned.set(subscriptionId, isOwn(session))
    return isOwn(session) ? session : null
  }

  const ownsSubscription = async (stripe: Stripe, subscriptionId: string) =>
    owned.get(subscriptionId) ?? Boolean(await startedBy(stripe, subscriptionId))

  /**
   * One stretch of the account's payments, reduced to this shop's. Stripe can't be asked for one
   * shop's sessions, so they are picked out here. Everything newer than `floor` is in `found`;
   * what is older has to be asked for.
   */
  async function stretch(stripe: Stripe, before: number | undefined) {
    const created = before === undefined ? {} : {created: {lt: before}}
    const [sessions, invoices] = await Promise.all([
      stripe.checkout.sessions.list({status: 'complete', limit: 100, ...created}),
      stripe.invoices.list({status: 'paid', limit: 50, ...created}),
    ])
    let floor = -Infinity
    const oldest = [
      sessions.has_more ? sessions.data.at(-1)?.created : undefined,
      invoices.has_more ? invoices.data.at(-1)?.created : undefined,
    ]
    for (const second of oldest) if (second !== undefined) floor = Math.max(floor, second)

    const found: Array<{created: number; summary: OrderSummary}> = []
    for (const session of sessions.data)
      if (session.created > floor && isOwn(session))
        found.push({created: session.created, summary: sessionSummary(session)})

    // A subscription's first invoice is the order its checkout took: only renewals are added.
    const renewals: Array<{invoice: Stripe.Invoice; subscriptionId: string}> = []
    for (const invoice of invoices.data) {
      const subscriptionId = subscriptionOf(invoice)
      if (
        invoice.created > floor &&
        invoice.billing_reason === 'subscription_cycle' &&
        subscriptionId
      )
        renewals.push({invoice, subscriptionId})
    }
    // Several renewals of one subscription are one question.
    const subscriptions = [...new Set(renewals.map(({subscriptionId}) => subscriptionId))]
    const answers = await inBatches(subscriptions, 10, (subscriptionId) =>
      ownsSubscription(stripe, subscriptionId),
    )
    const ours = new Set(subscriptions.filter((_, index) => answers[index]))
    for (const {invoice, subscriptionId} of renewals)
      if (ours.has(subscriptionId))
        found.push({created: invoice.created, summary: renewalSummary(invoice)})

    return {found: found.toSorted((a, b) => b.created - a.created), floor}
  }

  async function orders(stripe: Stripe, cursor: number | undefined): Promise<OrdersReply> {
    let before = cursor
    for (let round = 1; ; round++) {
      // oxlint-disable-next-line no-await-in-loop -- each stretch starts where the last one ended
      const {found, floor} = await stretch(stripe, before)
      const edge = found[PAGE_SIZE - 1]?.created
      const shown =
        edge !== undefined && found.length > PAGE_SIZE
          ? found.filter(({created}) => created >= edge)
          : found
      let older: number | null = null
      if (shown.length < found.length && edge !== undefined) older = edge
      else if (Number.isFinite(floor)) older = floor + 1
      if (shown.length > 0 || older === null || round === MAX_ROUNDS)
        return {
          orders: shown.map(({summary}) => summary),
          next: older === null ? null : String(older),
        }
      before = older
    }
  }

  /** The session, with what was paid back when the key may read charges. */
  async function readSession(stripe: Stripe, id: string) {
    try {
      const session = await stripe.checkout.sessions.retrieve(id, {
        expand: ['payment_intent.latest_charge'],
      })
      const intent = session.payment_intent
      const charge = typeof intent === 'object' && intent ? intent.latest_charge : null
      let amountRefunded: number | null = null
      if (typeof charge === 'object' && charge) amountRefunded = charge.amount_refunded
      else if (!intent && session.amount_total === 0) amountRefunded = 0
      return {session, amountRefunded}
    } catch (error) {
      // A restricted key without Charges or PaymentIntents: the order is shown without refunds.
      if (statusOf(error) !== 403) throw error
      return {session: await stripe.checkout.sessions.retrieve(id), amountRefunded: null}
    }
  }

  async function order(stripe: Stripe, id: string): Promise<OrderReply> {
    if (id.startsWith('cs_')) {
      const {session, amountRefunded} = await readSession(stripe, id)
      if (!isOwn(session) || session.status !== 'complete') throw new RouteError('not-found')
      return {
        order: orderDetail(sessionSummary(session), await getOrder(stripe, session), {
          amountRefunded,
          handledAt: finishedAt(session.metadata, 'order'),
        }),
      }
    }
    const invoice = await stripe.invoices.retrieve(id)
    const subscriptionId = subscriptionOf(invoice)
    if (!subscriptionId || invoice.billing_reason !== 'subscription_cycle')
      throw new RouteError('not-found')
    const session = await startedBy(stripe, subscriptionId)
    if (!session) throw new RouteError('not-found')
    return {
      order: orderDetail(
        renewalSummary(invoice),
        await getRenewal(stripe, invoice, session, subscriptionId),
        {amountRefunded: null, handledAt: finishedAt(invoice.metadata, 'renewal')},
      ),
    }
  }

  async function handle(request: Request): Promise<Response> {
    const origin = request.headers.get('origin')
    const url = new URL(request.url)
    const own = origin === url.origin
    if (origin !== null && !own && !origins.has(origin))
      return reply(403, {error: 'forbidden-origin'} satisfies StudioRouteError, {vary: 'Origin'})
    const cors = corsHeaders(own ? null : origin)
    const fail = (code: StudioRouteErrorCode) =>
      reply(STATUS[code], {error: code} satisfies StudioRouteError, cors)

    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors})
    const match = /\/orders(?:\/([^/]+))?\/?$/.exec(url.pathname)
    if (!match || request.method !== 'GET') return fail('not-found')
    const [, id] = match
    const before = url.searchParams.get('before')
    if ((id !== undefined && !ORDER_ID.test(id)) || (before !== null && !/^\d{1,12}$/.test(before)))
      return fail('bad-request')

    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]
    if (!token) return fail('signed-out')

    try {
      const editor = await sanityEditor(options.projectId, token, fetcher)
      if (!editor) return fail('signed-out')
      if (editor.roles.length === 0) return fail('not-member')
      if (!editor.roles.some((role) => roles.has(role))) return fail('forbidden-role')
      if (editor.apiToken && !options.allowApiTokens) return fail('api-token')

      const {stripe} = options
      if (!stripe) {
        log('error', '[studio routes] There is no Stripe key. Set one in the environment.')
        return fail('no-stripe')
      }
      const body =
        id === undefined
          ? await orders(stripe, before === null ? undefined : Number(before))
          : await order(stripe, id)
      return reply(200, body, cors)
    } catch (error) {
      if (error instanceof RouteError) return fail(error.code)
      if (error instanceof SanityApiError) {
        log('error', `[studio routes] Sanity could not say who is asking: ${reason(error)}`)
        return fail('sanity-failed')
      }
      if (statusOf(error) === 404) return fail('not-found')
      log('error', `[studio routes] ${reason(error)}`)
      // A timeout asking Sanity is not Stripe's doing.
      return fail(
        error instanceof Error && error.name === 'TimeoutError' ? 'sanity-failed' : 'stripe-failed',
      )
    }
  }

  return {GET: handle, OPTIONS: handle}
}
