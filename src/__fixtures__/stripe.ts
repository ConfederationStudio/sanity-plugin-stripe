import {Stripe} from 'stripe'

import {createStripe} from '../server/stripe'

/** One request the plugin made to Stripe's API. */
export interface StripeCall {
  method: string
  path: string
  query: URLSearchParams
  body: URLSearchParams
  headers: Headers
}

/** What the test shop marks its Checkout Sessions with. */
export const SHOP_TAG = 'shop_abcdefgh'

/** A paid Checkout Session of the test shop, as Stripe's API returns it. */
export const PAID_SESSION = {
  id: 'cs_test_1',
  object: 'checkout.session',
  mode: 'payment',
  integration_identifier: SHOP_TAG,
  payment_status: 'paid',
  payment_intent: 'pi_1',
  livemode: false,
  currency: 'eur',
  amount_total: 6650,
  shipping_cost: {amount_total: 1200},
  metadata: {region: 'eu', regionTitle: 'European Union'},
  customer_details: {name: 'Ada Lovelace', email: 'ada@example.com', phone: null},
  collected_information: {
    shipping_details: {
      name: 'Ada Lovelace',
      address: {
        line1: 'Analytical Street 1',
        line2: null,
        postal_code: '1011 AB',
        city: 'Amsterdam',
        state: null,
        country: 'NL',
      },
    },
  },
  created: 1794300000,
}

const lineItem = (
  id: string,
  description: string,
  quantity: number,
  amount: number,
  metadata: Record<string, string>,
) => ({
  id,
  object: 'item',
  description,
  quantity,
  amount_total: amount,
  price: {
    id: `price_${id}`,
    object: 'price',
    product: {id: `prod_${id}`, object: 'product', metadata},
  },
})

/** One magazine and one shirt in M: products of the fake dataset. */
export const LINE_ITEMS = [
  lineItem('li_1', 'Issue 16', 1, 2500, {productId: 'magazine'}),
  lineItem('li_2', 'Shirt – M', 1, 2950, {productId: 'shirt', variantKey: 'm'}),
]

export interface FakeStripeOptions {
  /** Fields to change on the session Stripe returns, such as `{payment_status: 'unpaid'}`. */
  session?: Record<string, unknown>
  lineItems?: unknown[]
}

/**
 * The real stripe-node client, as `createStripe` makes it, talking to a stand-in for Stripe's
 * API. Requests are built and replies are read by the SDK itself; only the network is replaced.
 */
export function fakeStripe(options: FakeStripeOptions = {}) {
  const calls: StripeCall[] = []
  /** The session's metadata, where finished fulfilment steps are recorded. */
  const metadata: Record<string, string> = {...PAID_SESSION.metadata}
  const session = {...PAID_SESSION, ...options.session, metadata}

  const reply = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {'Content-Type': 'application/json', 'Request-Id': 'req_test'},
    })

  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
    calls.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      body,
      headers: new Headers(init?.headers),
    })

    if (method === 'POST' && url.pathname === '/v1/checkout/sessions')
      return reply({
        id: session.id,
        object: 'checkout.session',
        url: `https://checkout.stripe.com/c/pay/${session.id}`,
      })
    if (url.pathname === `/v1/checkout/sessions/${session.id}`) {
      // An update: Stripe merges the metadata it is sent into what the session has.
      for (const [key, value] of body) {
        const field = /^metadata\[(.+)\]$/.exec(key)?.[1]
        if (field) metadata[field] = value
      }
      return reply(session)
    }
    if (method === 'GET' && url.pathname === `/v1/checkout/sessions/${session.id}/line_items`)
      return reply({
        object: 'list',
        data: options.lineItems ?? LINE_ITEMS,
        has_more: false,
        url: url.pathname,
      })
    return reply(
      {error: {type: 'invalid_request_error', message: `No route for ${url.pathname}`}},
      404,
    )
  }

  const stripe = createStripe('sk_test_fake', {
    httpClient: Stripe.createFetchHttpClient(fetchFn),
    maxNetworkRetries: 0,
  })
  return {stripe, calls, metadata}
}

export const WEBHOOK_SECRET = 'whsec_test_secret'

/** A webhook delivery, signed the way Stripe signs them. */
export function webhookRequest(
  stripe: Stripe,
  type: string,
  session: Record<string, unknown> = PAID_SESSION,
  secret = WEBHOOK_SECRET,
): Request {
  const payload = JSON.stringify({
    id: 'evt_test_1',
    object: 'event',
    type,
    data: {object: session},
  })
  return new Request('https://shop.example/api/stripe/webhook', {
    method: 'POST',
    body: payload,
    headers: {'stripe-signature': stripe.webhooks.generateTestHeaderString({payload, secret})},
  })
}
