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

const list = (data: unknown[], url: string) => ({object: 'list', data, has_more: false, url})

const RECURRING = {interval: 'week', interval_count: 6}

/**
 * A subscription the test shop's checkout started: a magazine every 6 weeks, and the region's
 * delivery charge as a line of its own.
 */
export const SUBSCRIPTION = {
  id: 'sub_test_1',
  object: 'subscription',
  status: 'active',
  metadata: {region: 'eu', regionTitle: 'European Union'},
  items: list(
    [
      {
        id: 'si_1',
        object: 'subscription_item',
        quantity: 1,
        price: {
          id: 'price_sub_1',
          object: 'price',
          recurring: RECURRING,
          product: {
            id: 'prod_sub_1',
            object: 'product',
            name: 'Issue 16',
            metadata: {productId: 'magazine'},
          },
        },
      },
      {
        id: 'si_2',
        object: 'subscription_item',
        quantity: 1,
        price: {
          id: 'price_sub_2',
          object: 'price',
          recurring: RECURRING,
          product: {
            id: 'prod_sub_2',
            object: 'product',
            name: 'Delivery: European Union',
            metadata: {delivery: 'eu'},
          },
        },
      },
    ],
    '/v1/subscription_items',
  ),
}

const invoiceLine = (id: string, description: string, amount: number, product: string) => ({
  id,
  object: 'line_item',
  description,
  quantity: 1,
  amount,
  pricing: {
    type: 'price_details',
    price_details: {price: `price_${product}`, product: `prod_${product}`},
    unit_amount_decimal: String(amount),
  },
})

/** The paid invoice of that subscription's first renewal. The customer has moved since. */
export const RENEWAL_INVOICE = {
  id: 'in_test_1',
  object: 'invoice',
  status: 'paid',
  billing_reason: 'subscription_cycle',
  livemode: false,
  currency: 'eur',
  total: 3179,
  amount_paid: 3179,
  number: 'SHOP-0002',
  created: 1797900000,
  status_transitions: {
    finalized_at: 1797900000,
    marked_uncollectible_at: null,
    paid_at: 1797903600,
    voided_at: null,
  },
  customer_name: 'Ada Lovelace',
  customer_email: 'ada@example.com',
  customer_phone: null,
  customer_shipping: {
    name: 'Ada Lovelace',
    address: {
      line1: 'Engine Lane 2',
      line2: null,
      postal_code: '10115',
      city: 'Berlin',
      state: null,
      country: 'DE',
    },
  },
  parent: {
    type: 'subscription_details',
    quote_details: null,
    subscription_details: {subscription: SUBSCRIPTION.id, metadata: SUBSCRIPTION.metadata},
  },
  lines: list(
    [
      invoiceLine('il_1', '1 × Issue 16 (at €19.79 / every 6 weeks)', 1979, 'sub_1'),
      invoiceLine(
        'il_2',
        '1 × Delivery: European Union (at €12.00 / every 6 weeks)',
        1200,
        'sub_2',
      ),
    ],
    '/v1/invoices/in_test_1/lines',
  ),
}

export interface FakeStripeOptions {
  /** Fields to change on the session Stripe returns, such as `{payment_status: 'unpaid'}`. */
  session?: Record<string, unknown>
  lineItems?: unknown[]
  /** Fields to change on the renewal invoice, such as `{status: 'open'}`. */
  invoice?: Record<string, unknown>
  /**
   * The account's customer portal configurations, each with the address of its login page (null
   * when the link isn't switched on) and whether it is the Dashboard's default one. None unless
   * given.
   */
  portal?: Array<{url: string | null; isDefault: boolean}>
}

/**
 * The real stripe-node client, as `createStripe` makes it, talking to a stand-in for Stripe's
 * API. Requests are built and replies are read by the SDK itself; only the network is replaced.
 */
export function fakeStripe(options: FakeStripeOptions = {}) {
  const calls: StripeCall[] = []
  /** The session's metadata, where finished fulfilment steps are recorded. */
  const metadata: Record<string, string> = {...PAID_SESSION.metadata}
  const session: Record<string, unknown> & {id: string} = {
    ...PAID_SESSION,
    ...options.session,
    metadata,
  }
  /** The invoice's metadata, where a handled renewal is recorded. */
  const invoiceMetadata: Record<string, string> = {}
  const invoice = {...RENEWAL_INVOICE, ...options.invoice, metadata: invoiceMetadata}
  const merge = (into: Record<string, string>, body: URLSearchParams) => {
    // An update: Stripe merges the metadata it is sent into what the object has.
    for (const [key, value] of body) {
      const field = /^metadata\[(.+)\]$/.exec(key)?.[1]
      if (field) into[field] = value
    }
  }

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
      merge(metadata, body)
      return reply(session)
    }
    // The session that started a subscription, as the webhook asks for it.
    if (method === 'GET' && url.pathname === '/v1/checkout/sessions')
      return reply(
        list(
          session.subscription === url.searchParams.get('subscription') ? [session] : [],
          url.pathname,
        ),
      )
    if (url.pathname === `/v1/invoices/${invoice.id}`) {
      merge(invoiceMetadata, body)
      return reply(invoice)
    }
    if (method === 'GET' && url.pathname === `/v1/subscriptions/${SUBSCRIPTION.id}`)
      return reply(SUBSCRIPTION)
    if (method === 'GET' && url.pathname === '/v1/billing_portal/configurations')
      return reply(
        list(
          (options.portal ?? []).map((configuration, index) => ({
            id: `bpc_test_${index + 1}`,
            object: 'billing_portal.configuration',
            active: true,
            is_default: configuration.isDefault,
            login_page: {enabled: Boolean(configuration.url), url: configuration.url},
          })),
          url.pathname,
        ),
      )
    if (method === 'GET' && url.pathname === `/v1/checkout/sessions/${session.id}/line_items`)
      return reply(list(options.lineItems ?? LINE_ITEMS, url.pathname))
    return reply(
      {error: {type: 'invalid_request_error', message: `No route for ${url.pathname}`}},
      404,
    )
  }

  const stripe = createStripe('sk_test_fake', {
    httpClient: Stripe.createFetchHttpClient(fetchFn),
    maxNetworkRetries: 0,
  })
  return {stripe, calls, metadata, invoiceMetadata}
}

export const WEBHOOK_SECRET = 'whsec_test_secret'

/** A webhook delivery, signed the way Stripe signs them. */
export function webhookRequest(
  stripe: Stripe,
  type: string,
  object: Record<string, unknown> = PAID_SESSION,
  secret = WEBHOOK_SECRET,
): Request {
  const payload = JSON.stringify({
    id: 'evt_test_1',
    object: 'event',
    type,
    data: {object},
  })
  return new Request('https://shop.example/api/stripe/webhook', {
    method: 'POST',
    body: payload,
    headers: {'stripe-signature': stripe.webhooks.generateTestHeaderString({payload, secret})},
  })
}
