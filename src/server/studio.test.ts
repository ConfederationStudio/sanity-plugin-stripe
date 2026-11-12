import {Stripe} from 'stripe'
import {beforeEach, describe, expect, it} from 'vitest'

import {
  LINE_ITEMS,
  PAID_SESSION,
  RENEWAL_INVOICE,
  SHOP_TAG,
  SUBSCRIPTION,
} from '../__fixtures__/stripe'
import type {OrderReply, OrdersReply} from '../core/orders'
import {clearEditorCache} from './editor'
import {createStripe} from './stripe'
import {studioRoutes, type StudioRoutesOptions} from './studio'

const PROJECT = 'abc12345'
const STUDIO = 'https://shop.sanity.studio'
const API = 'https://shop.example/api/shop'

type Fake = Record<string, unknown> & {id: string; created: number}

const session = (id: string, created: number, fields: Record<string, unknown> = {}): Fake => ({
  ...PAID_SESSION,
  status: 'complete',
  metadata: {...PAID_SESSION.metadata},
  ...fields,
  id,
  created,
})

const renewal = (id: string, created: number, fields: Record<string, unknown> = {}): Fake => ({
  ...RENEWAL_INVOICE,
  metadata: {},
  ...fields,
  id,
  created,
})

/** A Stripe account holding these sessions and invoices, behind the real stripe-node client. */
function account(sessions: Fake[], invoices: Fake[] = [], forbidCharges = false) {
  const calls: string[] = []
  const reply = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {'Content-Type': 'application/json', 'Request-Id': 'req_test'},
    })
  const page = (all: Fake[], query: URLSearchParams) => {
    const before = query.get('created[lt]')
    const limit = Number(query.get('limit') ?? 10)
    const matching = all
      .filter((item) => before === null || item.created < Number(before))
      .toSorted((a, b) => b.created - a.created)
    return reply({
      object: 'list',
      data: matching.slice(0, limit),
      has_more: matching.length > limit,
      url: '/v1/list',
    })
  }

  const fetchFn: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input)
    calls.push(`${url.pathname}${url.search}`)
    const {pathname, searchParams} = url
    if (pathname === '/v1/checkout/sessions') {
      const subscription = searchParams.get('subscription')
      return page(
        subscription ? sessions.filter((item) => item.subscription === subscription) : sessions,
        searchParams,
      )
    }
    if (pathname === '/v1/invoices') return page(invoices, searchParams)
    if (pathname.endsWith('/line_items'))
      return reply({object: 'list', data: LINE_ITEMS, has_more: false, url: pathname})
    if (pathname === `/v1/subscriptions/${SUBSCRIPTION.id}`) return reply(SUBSCRIPTION)
    const id = pathname.split('/').at(-1)
    const found = [...sessions, ...invoices].find((item) => item.id === id)
    if (!found)
      return reply({error: {type: 'invalid_request_error', message: `No such object: ${id}`}}, 404)
    if (searchParams.has('expand[0]')) {
      if (forbidCharges)
        return reply({error: {type: 'invalid_request_error', message: 'No permission'}}, 403)
      return reply({
        ...found,
        payment_intent: {
          id: 'pi_1',
          object: 'payment_intent',
          latest_charge: {id: 'ch_1', object: 'charge', amount_refunded: 2500},
        },
      })
    }
    return reply(found)
  }

  const stripe = createStripe('sk_test_fake', {
    httpClient: Stripe.createFetchHttpClient(fetchFn),
    maxNetworkRetries: 0,
  })
  return {stripe, calls}
}

/** Sanity's `/users/me`, for a few tokens. */
function sanity() {
  const asked: string[] = []
  const users: Record<string, unknown> = {
    'editor-token': {id: 'u1', roles: [{name: 'editor'}]},
    'viewer-token': {id: 'u2', roles: [{name: 'viewer'}]},
    'stranger-token': {id: 'u3', roles: []},
  }
  const fetchFn: typeof fetch = async (input, init) => {
    asked.push(input instanceof Request ? input.url : input.toString())
    const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? ''
    if (token === 'sanity-is-down') return new Response('', {status: 503})
    const user = users[token]
    return user ? Response.json(user) : new Response('{}', {status: 401})
  }
  return {fetch: fetchFn, asked}
}

function routes(stripe: Stripe | null, options: Partial<StudioRoutesOptions> = {}) {
  const {fetch: fetchFn, asked} = sanity()
  const logged: string[] = []
  const handlers = studioRoutes({
    stripe,
    integrationIdentifier: SHOP_TAG,
    projectId: PROJECT,
    studioOrigins: [STUDIO],
    fetch: fetchFn,
    log: (_level, message) => logged.push(message),
    ...options,
  })
  const get = (
    path: string,
    token: string | null = 'editor-token',
    origin: string | null = STUDIO,
  ) =>
    handlers.GET(
      new Request(`${API}${path}`, {
        headers: {
          ...(token ? {authorization: `Bearer ${token}`} : {}),
          ...(origin ? {origin} : {}),
        },
      }),
    )
  return {handlers, get, asked, logged}
}

async function read<T>(response: Response): Promise<T> {
  // oxlint-disable-next-line no-unsafe-type-assertion -- the route's replies are typed in core/orders
  return (await response.json()) as T
}

beforeEach(() => clearEditorCache())

describe('studioRoutes: who may ask', () => {
  const {stripe, calls} = account([session('cs_test_1', 1000)])

  it('refuses another website, and gives it no CORS headers', async () => {
    const response = await routes(stripe).get('/orders', 'editor-token', 'https://evil.example')
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({error: 'forbidden-origin'})
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers the Studio’s address with CORS headers, and never lets the answer be cached', async () => {
    const response = await routes(stripe).get('/orders')
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(STUDIO)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('answers a Studio on the site’s own address without an entry for it', async () => {
    const response = await routes(stripe, {studioOrigins: []}).get(
      '/orders',
      'editor-token',
      'https://shop.example',
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers the browser’s preflight without asking anyone', async () => {
    const {handlers, asked} = routes(stripe)
    const response = await handlers.OPTIONS(
      new Request(`${API}/orders`, {method: 'OPTIONS', headers: {origin: STUDIO}}),
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization')
    expect(asked).toEqual([])
  })

  it('wants a sign-in, and one Sanity knows', async () => {
    const {get} = routes(stripe)
    expect((await get('/orders', null)).status).toBe(401)
    const unknown = await get('/orders', 'made-up-token')
    expect(unknown.status).toBe(401)
    expect(await unknown.json()).toEqual({error: 'signed-out'})
  })

  it('refuses someone who isn’t a member of the project', async () => {
    const response = await routes(stripe).get('/orders', 'stranger-token')
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({error: 'not-member'})
  })

  it('keeps buyers from viewers unless the site names their role', async () => {
    const before = calls.length
    const refused = await routes(stripe).get('/orders', 'viewer-token')
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({error: 'forbidden-role'})
    expect(calls).toHaveLength(before)

    const allowed = await routes(stripe, {roles: ['viewer']}).get('/orders', 'viewer-token')
    expect(allowed.status).toBe(200)
  })

  it('asks Sanity on the project’s own host, once a minute at most for one sign-in', async () => {
    const {get, asked} = routes(stripe)
    await get('/orders')
    await get('/orders')
    expect(asked).toEqual([`https://${PROJECT}.api.sanity.io/v2025-02-19/users/me`])
  })

  it('says so when Sanity can’t be asked, or the site has no Stripe key', async () => {
    const down = await routes(stripe).get('/orders', 'sanity-is-down')
    expect(down.status).toBe(502)
    expect(await down.json()).toEqual({error: 'sanity-failed'})

    const keyless = await routes(null).get('/orders')
    expect(keyless.status).toBe(503)
    expect(await keyless.json()).toEqual({error: 'no-stripe'})
  })

  it('knows two addresses only, and reads no other method', async () => {
    const {get, handlers} = routes(stripe)
    expect((await get('/customers')).status).toBe(404)
    expect((await get('/orders/pi_123456')).status).toBe(400)
    expect((await get('/orders?before=yesterday')).status).toBe(400)
    const post = await handlers.GET(
      new Request(`${API}/orders`, {method: 'POST', headers: {origin: STUDIO}}),
    )
    expect(post.status).toBe(404)
  })

  it('refuses a project id or an origin that isn’t one', () => {
    expect(() => routes(stripe, {projectId: 'Not A Project'})).toThrow(/projectId/)
    expect(() => routes(stripe, {studioOrigins: ['shop.sanity.studio']})).toThrow(/origin/)
    expect(() => routes(stripe, {integrationIdentifier: ''})).toThrow(/integrationIdentifier/)
  })
})

describe('studioRoutes: the list of orders', () => {
  it('shows this shop’s completed checkouts, newest first, and nobody else’s', async () => {
    const {stripe, calls} = account([
      session('cs_test_old', 1000),
      session('cs_test_new', 3000, {payment_status: 'unpaid'}),
      session('cs_test_other_site', 2000, {integration_identifier: 'another_site'}),
      session('cs_test_payment_link', 2500, {integration_identifier: null}),
      session('cs_test_card_only', 2600, {mode: 'setup'}),
    ])
    const reply = await read<OrdersReply>(await routes(stripe).get('/orders'))
    expect(reply.next).toBeNull()
    expect(reply.orders).toEqual([
      {
        id: 'cs_test_new',
        kind: 'order',
        createdAt: '1970-01-01T00:50:00.000Z',
        status: 'unpaid',
        currency: 'eur',
        amountTotal: 6650,
        customer: {name: 'Ada Lovelace', email: 'ada@example.com'},
        country: 'NL',
        subscription: false,
        livemode: false,
      },
      expect.objectContaining({id: 'cs_test_old', status: 'paid'}),
    ])
    expect(calls[0]).toContain('status=complete')
  })

  it('adds a subscription’s renewals, and leaves out first invoices and other shops’', async () => {
    const {stripe, calls} = account(
      [
        session('cs_test_sub', 1000, {mode: 'subscription', subscription: SUBSCRIPTION.id}),
        session('cs_test_theirs', 900, {
          mode: 'subscription',
          subscription: 'sub_theirs',
          integration_identifier: 'another_site',
        }),
      ],
      [
        renewal('in_test_first', 1000, {billing_reason: 'subscription_create'}),
        renewal('in_test_second', 5000),
        renewal('in_test_third', 9000),
        renewal('in_test_theirs', 7000, {
          parent: {subscription_details: {subscription: 'sub_theirs', metadata: {}}},
        }),
        renewal('in_test_by_hand', 8000, {billing_reason: 'manual', parent: null}),
      ],
    )
    const {get} = routes(stripe)
    const reply = await read<OrdersReply>(await get('/orders'))
    expect(reply.orders.map(({id, kind}) => `${kind} ${id}`)).toEqual([
      'renewal in_test_third',
      'renewal in_test_second',
      'order cs_test_sub',
    ])
    expect(reply.orders[0]).toMatchObject({
      status: 'paid',
      amountTotal: 3179,
      country: 'DE',
      subscription: true,
    })
    expect(reply.orders[2]).toMatchObject({subscription: true})

    // Who started a subscription is asked once, then remembered.
    const lookups = () => calls.filter((call) => call.includes('subscription=')).length
    expect(lookups()).toBe(2)
    await get('/orders')
    expect(lookups()).toBe(2)
  })

  it('hands out 25 at a time, and the rest when asked', async () => {
    const {stripe} = account(
      Array.from({length: 60}, (_, index) => session(`cs_test_${index}`, 1000 + index)),
    )
    const {get} = routes(stripe)
    const first = await read<OrdersReply>(await get('/orders'))
    expect(first.orders).toHaveLength(25)
    expect(first.orders[0]?.id).toBe('cs_test_59')
    expect(first.next).toBe('1035')

    const seen = [...first.orders]
    let next = first.next
    while (next) {
      // oxlint-disable-next-line no-await-in-loop -- one page after the other, as the Studio asks
      const more = await read<OrdersReply>(await get(`/orders?before=${next}`))
      seen.push(...more.orders)
      next = more.next
    }
    expect(seen.map(({id}) => id)).toEqual(
      Array.from({length: 60}, (_, index) => `cs_test_${59 - index}`),
    )
  })

  it('never splits orders taken in the same second over two answers', async () => {
    const {stripe} = account(
      Array.from({length: 40}, (_, index) => session(`cs_test_${index}`, index < 30 ? 5000 : 4000)),
    )
    const {get} = routes(stripe)
    const first = await read<OrdersReply>(await get('/orders'))
    expect(first.orders).toHaveLength(30)
    const second = await read<OrdersReply>(await get(`/orders?before=${first.next}`))
    expect(second.orders).toHaveLength(10)
    expect(second.next).toBeNull()
  })

  it('reads past what Stripe returns in one go, missing nothing', async () => {
    // 150 checkouts on the account, every third one this shop's: Stripe hands out 100 at a time.
    const all = Array.from({length: 150}, (_, index) =>
      session(
        `cs_test_${index}`,
        1000 + index,
        index % 3 === 0 ? {} : {integration_identifier: 'x'},
      ),
    )
    const {stripe} = account(all, [renewal('in_test_old', 1010)])
    const {get} = routes(stripe)
    const seen: string[] = []
    let path = '/orders'
    for (let asked = 0; asked < 10; asked++) {
      // oxlint-disable-next-line no-await-in-loop -- one page after the other, as the Studio asks
      const reply = await read<OrdersReply>(await get(path))
      seen.push(...reply.orders.map(({id}) => id))
      if (!reply.next) break
      path = `/orders?before=${reply.next}`
    }
    expect(seen.filter((id) => id.startsWith('cs_'))).toHaveLength(50)
    expect(new Set(seen).size).toBe(seen.length)
    // The renewal has no checkout of this shop behind it here.
    expect(seen).not.toContain('in_test_old')
  })

  it('keeps looking through an account full of other payments, then lets the editor go on', async () => {
    const others = Array.from({length: 450}, (_, index) =>
      session(`cs_test_x${index}`, 10_000 + index, {integration_identifier: 'another_site'}),
    )
    const {stripe, calls} = account([session('cs_test_mine', 500), ...others])
    const {get} = routes(stripe)
    const first = await read<OrdersReply>(await get('/orders'))
    expect(first.orders).toEqual([])
    expect(first.next).not.toBeNull()
    expect(calls.filter((call) => call.startsWith('/v1/checkout/sessions'))).toHaveLength(4)

    const second = await read<OrdersReply>(await get(`/orders?before=${first.next}`))
    expect(second.orders.map(({id}) => id)).toEqual(['cs_test_mine'])
    expect(second.next).toBeNull()
  })

  it('says so when Stripe fails, without passing its words on', async () => {
    const stripe = createStripe('sk_test_fake', {
      httpClient: Stripe.createFetchHttpClient(async () =>
        Response.json({error: {type: 'api_error', message: 'secret detail'}}, {status: 500}),
      ),
      maxNetworkRetries: 0,
    })
    const {get, logged} = routes(stripe)
    const response = await get('/orders')
    expect(response.status).toBe(502)
    expect(await response.text()).toBe('{"error":"stripe-failed"}')
    expect(logged.join('\n')).toContain('secret detail')
  })
})

describe('studioRoutes: one order', () => {
  it('gives what to pack, where to send it, and what was paid back', async () => {
    const {stripe} = account([
      session('cs_test_1', 1794300000, {
        metadata: {...PAID_SESSION.metadata, fulfilled_order: '2026-11-09T10:00:05.000Z'},
      }),
    ])
    const response = await routes(stripe).get('/orders/cs_test_1')
    expect(response.status).toBe(200)
    expect((await read<OrderReply>(response)).order).toEqual({
      id: 'cs_test_1',
      kind: 'order',
      createdAt: '2026-11-10T08:40:00.000Z',
      status: 'paid',
      currency: 'eur',
      amountTotal: 6650,
      customer: {name: 'Ada Lovelace', email: 'ada@example.com'},
      country: 'NL',
      subscription: false,
      livemode: false,
      items: [
        {name: 'Issue 16', quantity: 1, amountTotal: 2500, productId: 'magazine'},
        {name: 'Shirt – M', quantity: 1, amountTotal: 2950, productId: 'shirt', variantKey: 'm'},
      ],
      amountShipping: 1200,
      regionTitle: 'European Union',
      phone: null,
      shipping: {
        name: 'Ada Lovelace',
        address: {
          line1: 'Analytical Street 1',
          line2: null,
          postalCode: '1011 AB',
          city: 'Amsterdam',
          state: null,
          country: 'NL',
        },
      },
      interval: null,
      stripeUrl: 'https://dashboard.stripe.com/test/payments/pi_1',
      amountRefunded: 2500,
      handledAt: '2026-11-09T10:00:05.000Z',
    })
  })

  it('still shows the order when the site’s key may not read charges', async () => {
    const {stripe} = account([session('cs_test_1', 1000)], [], true)
    const {order} = await read<OrderReply>(await routes(stripe).get('/orders/cs_test_1'))
    expect(order.amountRefunded).toBeNull()
    expect(order.items).toHaveLength(2)
    expect(order.handledAt).toBeNull()
  })

  it('gives a renewal with the address the customer has now', async () => {
    const {stripe} = account(
      [session('cs_test_sub', 1000, {mode: 'subscription', subscription: SUBSCRIPTION.id})],
      [renewal('in_test_1', 5000, {metadata: {fulfilled_renewal: '2027-01-01T00:00:00.000Z'}})],
    )
    const {order} = await read<OrderReply>(await routes(stripe).get('/orders/in_test_1'))
    expect(order).toMatchObject({
      id: 'in_test_1',
      kind: 'renewal',
      subscription: true,
      interval: 'every 6 weeks',
      amountTotal: 3179,
      amountShipping: 1200,
      shipping: {
        name: 'Ada Lovelace',
        address: {city: 'Berlin', postalCode: '10115', country: 'DE'},
      },
      stripeUrl: 'https://dashboard.stripe.com/test/invoices/in_test_1',
      amountRefunded: null,
      handledAt: '2027-01-01T00:00:00.000Z',
    })
    expect(order.items).toEqual([
      expect.objectContaining({productId: 'magazine', subscription: true}),
    ])
  })

  it('knows no order of another shop, no unfinished checkout and no other invoice', async () => {
    const {stripe} = account(
      [
        session('cs_test_theirs', 1000, {integration_identifier: 'another_site'}),
        session('cs_test_open', 1000, {status: 'open'}),
        session('cs_test_their_sub', 1000, {
          subscription: 'sub_theirs',
          integration_identifier: 'another_site',
        }),
      ],
      [
        renewal('in_test_first', 1000, {billing_reason: 'subscription_create'}),
        renewal('in_test_theirs', 1000, {
          parent: {subscription_details: {subscription: 'sub_theirs', metadata: {}}},
        }),
      ],
    )
    const {get} = routes(stripe)
    for (const id of [
      'cs_test_theirs',
      'cs_test_open',
      'cs_test_missing',
      'in_test_first',
      'in_test_theirs',
      'in_test_missing',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other reads better in a failure
      const response = await get(`/orders/${id}`)
      expect([id, response.status]).toEqual([id, 404])
      // oxlint-disable-next-line no-await-in-loop
      expect(await response.json()).toEqual({error: 'not-found'})
    }
  })
})
