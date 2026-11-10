import {describe, expect, it, vi} from 'vitest'

import {fakeDataset, SHOP, type Doc} from '../__fixtures__/sanity'
import {
  fakeStripe,
  PAID_SESSION,
  SHOP_TAG,
  WEBHOOK_SECRET,
  webhookRequest,
} from '../__fixtures__/stripe'
import {readCartProducts} from '../core/cart'
import {STOCK_CHANGE_TYPE, stockChangeId, stockId} from '../core/ids'
import {checkoutProductsQuery, SHOP_SETTINGS_QUERY} from '../core/queries'
import {readShopSettings, regionsFromSettings} from '../core/regions'
import {VERSION} from '../version'
import {buildCheckoutSession} from './checkout'
import {orderEmail} from './email'
import {classifyEvent, verifyEvent} from './events'
import {getOrder, type Order} from './order'
import {checkoutRoute, webhookRoute, type OrderContext} from './routes'
import {decrementStock, readStock} from './stock'
import {STRIPE_API_VERSION} from './stripe'

const quiet = () => {}

const cart = [
  {productId: 'magazine', quantity: 2},
  {productId: 'shirt', variantKey: 'm', quantity: 1},
]

/** What the checkout route reads before it builds a session, through the plugin's own GROQ. */
async function shopInput(dataset = fakeDataset()) {
  const ids = ['magazine', 'shirt', 'poster']
  return {
    lines: cart,
    regionId: 'eu',
    products: readCartProducts(await dataset.reader.fetch(checkoutProductsQuery(), {ids})),
    regions: regionsFromSettings(readShopSettings(await dataset.reader.fetch(SHOP_SETTINGS_QUERY))),
    stock: await readStock(dataset.writer, ids),
    currency: 'eur',
    successUrl: 'https://shop.example/thanks?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://shop.example/cart',
    integrationIdentifier: SHOP_TAG,
  }
}

const checkoutRequest = (body: unknown) =>
  new Request('https://shop.example/api/checkout', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('the line between public and private', () => {
  it('shows anyone the shop, and no stock, drafts or records', async () => {
    const {reader} = fakeDataset()
    const everything = JSON.stringify(await reader.fetch('*[]'))
    expect(everything).toContain('Issue 16')
    expect(everything).not.toContain('stockCount')
    expect(everything).not.toContain('(draft)')
    expect(await reader.fetch('*[_type in ["stripe.stock", "stripe.stockChange"]]')).toEqual([])
  })

  it('reads stock only with a token', async () => {
    const {reader, writer} = fakeDataset()
    expect(await readStock(reader, ['magazine', 'shirt'])).toEqual(new Map())
    expect(await readStock(writer, ['magazine', 'shirt', 'poster'])).toEqual(
      new Map([
        ['magazine', {stockCount: 3, variants: []}],
        ['shirt', {stockCount: null, variants: [{_key: 'm', stockCount: 1}]}],
      ]),
    )
  })
})

describe('buildCheckoutSession', () => {
  it('prices the cart from the published product, never from the browser or a draft', async () => {
    const result = buildCheckoutSession({
      ...(await shopInput()),
      lines: [{productId: 'magazine', quantity: 2, price: 0.01}],
    })
    expect(result.ok && result.params.line_items).toEqual([
      {
        quantity: 2,
        price_data: {
          currency: 'eur',
          unit_amount: 2500,
          product_data: {
            name: 'Issue 16',
            images: ['https://cdn.sanity.io/magazine.jpg'],
            metadata: {productId: 'magazine'},
          },
        },
      },
    ])
  })

  it('names the variant, and says which product and variant the webhook will read back', async () => {
    const result = buildCheckoutSession(await shopInput())
    expect(result.ok && result.params.line_items?.[1]).toMatchObject({
      quantity: 1,
      price_data: {
        unit_amount: 2950,
        product_data: {name: 'Shirt – M', metadata: {productId: 'shirt', variantKey: 'm'}},
      },
    })
  })

  it('ships to the chosen region only, at its flat rate, and marks the session as the shop’s', async () => {
    const result = buildCheckoutSession(await shopInput())
    expect(result.ok && result.params).toMatchObject({
      mode: 'payment',
      shipping_address_collection: {allowed_countries: ['DE', 'FR']},
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            display_name: 'European Union',
            fixed_amount: {amount: 1200, currency: 'eur'},
          },
        },
      ],
      metadata: {region: 'eu', regionTitle: 'European Union'},
      integration_identifier: SHOP_TAG,
    })
  })

  it('leaves payment methods to the Dashboard', async () => {
    const result = buildCheckoutSession(await shopInput())
    expect(result.ok && Object.keys(result.params)).not.toContain('payment_method_types')
  })

  it('adds the tax rate of each product’s tax class, and the expiry when given', async () => {
    const result = buildCheckoutSession({
      ...(await shopInput()),
      taxRates: {reduced: 'txr_reduced'},
      expiresAt: 1794301800,
    })
    expect(result.ok && result.params.line_items?.[0]?.tax_rates).toEqual(['txr_reduced'])
    // No rate is mapped for the shirt's class.
    expect(result.ok && result.params.line_items?.[1]?.tax_rates).toBeUndefined()
    expect(result.ok && result.params.expires_at).toBe(1794301800)
  })

  it('refuses more than is left, and says how many there are', async () => {
    expect(
      buildCheckoutSession({
        ...(await shopInput()),
        lines: [
          {productId: 'magazine', quantity: 5},
          {productId: 'shirt', variantKey: 'm', quantity: 2},
          {productId: 'poster', quantity: 10},
        ],
      }),
    ).toEqual({
      ok: false,
      error: 'unavailable',
      problems: [
        {productId: 'magazine', name: 'Issue 16', reason: 'tooMany', maxQuantity: 3},
        {productId: 'shirt', variantKey: 'm', name: 'Shirt – M', reason: 'tooMany', maxQuantity: 1},
      ],
    })
  })

  it('keeps the number to itself when the shop hides what is left', async () => {
    const result = buildCheckoutSession({
      ...(await shopInput()),
      lines: [{productId: 'magazine', quantity: 5}],
      hideRemaining: true,
    })
    expect(result).toMatchObject({ok: false, error: 'unavailable'})
    expect(!result.ok && result.problems).toEqual([
      {productId: 'magazine', name: 'Issue 16', reason: 'tooMany'},
    ])
  })

  it('treats a count of 0 as sold out, whatever the switch says', async () => {
    const dataset = fakeDataset()
    await dataset.writer
      .transaction()
      .patch(stockId('magazine'), {set: {stockCount: 0}})
      .commit()
    const result = buildCheckoutSession({
      ...(await shopInput(dataset)),
      lines: [{productId: 'magazine', quantity: 1}],
    })
    expect(!result.ok && result.problems).toEqual([
      {productId: 'magazine', name: 'Issue 16', reason: 'soldOut'},
    ])
  })

  it('counts nothing without stock: the shop sells by the switch alone', async () => {
    const {stock: _, ...uncounted} = await shopInput()
    const result = buildCheckoutSession({
      ...uncounted,
      lines: [{productId: 'magazine', quantity: 9}],
    })
    expect(result.ok).toBe(true)
  })

  it('turns down what can’t be bought, line by line', async () => {
    expect(
      buildCheckoutSession({
        ...(await shopInput()),
        lines: [
          {productId: 'shirt', variantKey: 'l', quantity: 1},
          {productId: 'gone', quantity: 1},
        ],
      }),
    ).toEqual({
      ok: false,
      error: 'unavailable',
      problems: [
        {productId: 'shirt', variantKey: 'l', name: 'Shirt', reason: 'soldOut'},
        {productId: 'gone', reason: 'missing'},
      ],
    })
  })

  it('needs something in the cart and a region that exists', async () => {
    const input = await shopInput()
    expect(buildCheckoutSession({...input, lines: []})).toMatchObject({error: 'empty'})
    expect(buildCheckoutSession({...input, regionId: 'mars'})).toMatchObject({error: 'region'})
  })
})

describe('checkoutRoute', () => {
  const setup = (extra: Record<string, unknown> = {}, docs?: Doc[]) => {
    const stripeSide = fakeStripe()
    const dataset = fakeDataset(docs)
    const log = vi.fn()
    const route = checkoutRoute({
      stripe: stripeSide.stripe,
      client: dataset.reader,
      stockClient: dataset.writer,
      currency: 'eur',
      successUrl: '/thanks?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: '/cart',
      integrationIdentifier: SHOP_TAG,
      log,
      ...extra,
    })
    return {...stripeSide, dataset, log, route}
  }

  it('creates the session with the pinned API version and answers where to go', async () => {
    const {route, calls} = setup()
    const response = await route(checkoutRequest({lines: cart, regionId: 'eu'}))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({url: 'https://checkout.stripe.com/c/pay/cs_test_1'})

    const [call] = calls
    expect(call?.path).toBe('/v1/checkout/sessions')
    expect(call?.headers.get('Stripe-Version')).toBe(STRIPE_API_VERSION)
    expect(call?.headers.get('User-Agent')).toContain(`sanity-plugin-stripe/${VERSION}`)
    // Stripe fills in the session id itself, so the placeholder goes out as written.
    expect(call?.body.get('success_url')).toBe(
      'https://shop.example/thanks?session_id={CHECKOUT_SESSION_ID}',
    )
    expect(call?.body.get('cancel_url')).toBe('https://shop.example/cart')
    expect(call?.body.get('integration_identifier')).toBe(SHOP_TAG)
    // The published price, not the draft's 1 or the release's 20.
    expect(call?.body.get('line_items[0][price_data][unit_amount]')).toBe('2500')
    expect([...(call?.body.keys() ?? [])].filter((key) => key.includes('payment_method'))).toEqual(
      [],
    )
  })

  it('never sells a draft, whatever id the browser sends', async () => {
    const {route, calls} = setup()
    const response = await route(
      checkoutRequest({lines: [{productId: 'drafts.magazine', quantity: 1}], regionId: 'eu'}),
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({error: 'empty'})
    expect(calls).toEqual([])
  })

  it('refuses a cart that asks for more than is left, without calling Stripe', async () => {
    const {route, calls} = setup()
    const response = await route(
      checkoutRequest({lines: [{productId: 'magazine', quantity: 4}], regionId: 'eu'}),
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: 'unavailable',
      problems: [{productId: 'magazine', reason: 'tooMany', maxQuantity: 3}],
    })
    expect(calls).toEqual([])

    const hidden = setup({hideRemaining: true})
    const again = await hidden.route(
      checkoutRequest({lines: [{productId: 'magazine', quantity: 4}], regionId: 'eu'}),
    )
    expect(JSON.stringify(await again.json())).not.toContain('maxQuantity')
  })

  it('counts nothing without a client that can read stock, and says so once', async () => {
    const {route, log, calls} = setup({stockClient: null})
    const order = () =>
      checkoutRequest({lines: [{productId: 'magazine', quantity: 9}], regionId: 'eu'})
    expect((await route(order())).status).toBe(200)
    expect((await route(order())).status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(
      log.mock.calls.filter(([, message]) => String(message).includes('stockClient')),
    ).toHaveLength(1)
  })

  it('lets the site change the session before it is created', async () => {
    const extend = vi.fn((params: object) => ({...params, allow_promotion_codes: true}))
    const {route, calls} = setup({extend})
    await route(checkoutRequest({lines: cart, regionId: 'nl'}))
    expect(extend).toHaveBeenCalledOnce()
    expect(calls[0]?.body.get('allow_promotion_codes')).toBe('true')
  })

  it('gives Stripe a minute more than its shortest expiry', async () => {
    const {route, calls} = setup({expiresInMinutes: 30})
    const before = Math.floor(Date.now() / 1000)
    await route(checkoutRequest({lines: cart, regionId: 'eu'}))
    const expires = Number(calls[0]?.body.get('expires_at'))
    expect(expires).toBeGreaterThanOrEqual(before + 31 * 60)
    expect(expires).toBeLessThanOrEqual(before + 32 * 60)
  })

  it('says what changed in the cart, without calling Stripe', async () => {
    const {route, calls} = setup()
    const response = await route(
      checkoutRequest({
        lines: [{productId: 'shirt', variantKey: 'l', quantity: 1}],
        regionId: 'eu',
      }),
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: 'unavailable',
      problems: [{productId: 'shirt', variantKey: 'l', reason: 'soldOut'}],
    })
    expect(calls).toEqual([])
  })

  it('answers 503 before the site has a Stripe key, with the reason only when debugging', async () => {
    const request = () => checkoutRequest({lines: cart, regionId: 'eu'})
    const plain = await setup({stripe: null}).route(request())
    expect(plain.status).toBe(503)
    expect(Object.keys(Object(await plain.json()))).toEqual(['error', 'message'])
    const debugging = await setup({stripe: null, debug: true}).route(request())
    expect(await debugging.json()).toMatchObject({detail: expect.stringContaining('Stripe key')})
  })

  it('answers 503 until the shop settings are published', async () => {
    const {route} = setup(
      {},
      SHOP.filter((doc) => doc._type !== 'stripeShopSettings'),
    )
    expect((await route(checkoutRequest({lines: cart, regionId: 'eu'}))).status).toBe(503)
  })

  it('answers 502 when Sanity can’t be read', async () => {
    const broken = {fetch: () => Promise.reject(new Error('Sanity is down'))}
    const {route, calls} = setup({client: broken})
    expect((await route(checkoutRequest({lines: cart, regionId: 'eu'}))).status).toBe(502)
    expect(calls).toEqual([])
  })

  it('refuses a body that isn’t a cart', async () => {
    const {route} = setup()
    expect((await route(checkoutRequest('not json'))).status).toBe(400)
    expect((await route(checkoutRequest([1, 2]))).status).toBe(400)
  })
})

describe('webhook events', () => {
  const {stripe} = fakeStripe()

  it('takes an event Stripe signed, and nothing else', async () => {
    const request = webhookRequest(stripe, 'checkout.session.completed')
    const payload = await request.text()
    const signature = request.headers.get('stripe-signature')
    expect(verifyEvent(stripe, payload, signature, WEBHOOK_SECRET).type).toBe(
      'checkout.session.completed',
    )
    expect(() => verifyEvent(stripe, payload, signature, 'whsec_another')).toThrow()
    expect(() => verifyEvent(stripe, `${payload} `, signature, WEBHOOK_SECRET)).toThrow()
    expect(() => verifyEvent(stripe, payload, null, WEBHOOK_SECRET)).toThrow()
  })

  it('fulfils on payment, not on completion', async () => {
    const read = async (type: string, session: Record<string, unknown>) => {
      const request = webhookRequest(stripe, type, session)
      const event = verifyEvent(
        stripe,
        await request.text(),
        request.headers.get('stripe-signature'),
        WEBHOOK_SECRET,
      )
      return classifyEvent(event).type
    }
    const unpaid = {...PAID_SESSION, payment_status: 'unpaid'}
    expect(await read('checkout.session.completed', PAID_SESSION)).toBe('paid')
    expect(await read('checkout.session.completed', unpaid)).toBe('pending')
    expect(await read('checkout.session.async_payment_succeeded', PAID_SESSION)).toBe('paid')
    expect(await read('checkout.session.async_payment_failed', unpaid)).toBe('failed')
    expect(await read('checkout.session.expired', unpaid)).toBe('ignored')
  })
})

describe('getOrder', () => {
  it('reads who paid, where it goes and what was bought', async () => {
    const {stripe} = fakeStripe()
    const session = await stripe.checkout.sessions.retrieve('cs_test_1')
    expect(await getOrder(stripe, session)).toMatchObject({
      sessionId: 'cs_test_1',
      paymentIntentId: 'pi_1',
      livemode: false,
      currency: 'eur',
      amountTotal: 6650,
      amountShipping: 1200,
      regionId: 'eu',
      customer: {name: 'Ada Lovelace', email: 'ada@example.com'},
      shipping: {name: 'Ada Lovelace', address: {city: 'Amsterdam', country: 'NL'}},
      items: [
        {productId: 'magazine', name: 'Issue 16', quantity: 1, amountTotal: 2500},
        {productId: 'shirt', variantKey: 'm', name: 'Shirt – M', quantity: 1, amountTotal: 2950},
      ],
    })
  })
})

describe('decrementStock', () => {
  const order = {
    sessionId: 'cs_test_1',
    items: [
      {productId: 'magazine', name: 'Issue 16', quantity: 1, amountTotal: 2500},
      {productId: 'shirt', variantKey: 'm', name: 'Shirt – M', quantity: 1, amountTotal: 2950},
    ],
  }
  const lastMagazines = {
    sessionId: 'cs_test_2',
    items: [{productId: 'magazine', name: 'Issue 16', quantity: 3, amountTotal: 7500}],
  }
  const VERSIONS = ['magazine', 'drafts.magazine', 'versions.rSummer.magazine']

  it('lowers the private counts and leaves the product documents alone', async () => {
    const dataset = fakeDataset()
    const product = structuredClone(dataset.get('magazine'))
    const result = await decrementStock(dataset.writer, order)
    expect(result).toEqual({
      status: 'lowered',
      changes: [
        {productId: 'magazine', from: 3, to: 2},
        {productId: 'shirt', variantKey: 'm', from: 1, to: 0},
      ],
    })
    expect(dataset.value(stockId('magazine'), 'stockCount')).toBe(2)
    expect(dataset.value(stockId('shirt'), 'variants[_key=="m"].stockCount')).toBe(0)
    expect(dataset.get('magazine')).toEqual(product)
    // Stock and every version of a product are only visible raw, on a release-aware API version.
    expect(dataset.raw).toContainEqual({
      perspective: 'raw',
      useCdn: false,
      apiVersion: '2025-02-19',
    })
  })

  it('marks what reaches 0 sold out in every version, so nothing puts it back on sale', async () => {
    const dataset = fakeDataset()
    await decrementStock(dataset.writer, order)
    // The variant, in the published shirt and its draft.
    for (const id of ['shirt', 'drafts.shirt'])
      expect(dataset.value(id, 'commerce.variants[_key=="m"].availability')).toBe('soldOut')
    expect(dataset.value('shirt', 'commerce.availability')).toBe('onSale')
    // The magazine still has 2.
    for (const id of VERSIONS) expect(dataset.value(id, 'commerce.availability')).toBe('onSale')

    await decrementStock(dataset.writer, {
      sessionId: 'cs_test_2',
      items: [{productId: 'magazine', name: 'Issue 16', quantity: 2, amountTotal: 5000}],
    })
    for (const id of VERSIONS) expect(dataset.value(id, 'commerce.availability')).toBe('soldOut')
  })

  it('leaves the switch alone when the shop doesn’t sell out automatically', async () => {
    const dataset = fakeDataset()
    await decrementStock(dataset.writer, lastMagazines, {autoSoldOut: false})
    expect(dataset.value(stockId('magazine'), 'stockCount')).toBe(0)
    for (const id of VERSIONS) expect(dataset.value(id, 'commerce.availability')).toBe('onSale')
  })

  it('lowers stock once per session, however often it is asked', async () => {
    const dataset = fakeDataset()
    const first = await decrementStock(dataset.writer, order)
    const second = await decrementStock(dataset.writer, order)
    expect(second).toEqual({status: 'already', changes: first.changes})
    expect(dataset.value(stockId('magazine'), 'stockCount')).toBe(2)
  })

  it('lowers stock once when two deliveries arrive in the same moment', async () => {
    const dataset = fakeDataset()
    const results = await Promise.all([
      decrementStock(dataset.writer, order),
      decrementStock(dataset.writer, order),
    ])
    expect(results.map((result) => result.status).toSorted()).toEqual(['already', 'lowered'])
    expect(dataset.value(stockId('magazine'), 'stockCount')).toBe(2)
    expect(dataset.value(stockId('shirt'), 'variants[_key=="m"].stockCount')).toBe(0)
  })

  it('writes down product ids and counts, and nothing else', async () => {
    const dataset = fakeDataset()
    await decrementStock(dataset.writer, order, {now: new Date('2026-11-10T12:00:00Z')})
    expect(dataset.get(stockChangeId('cs_test_1'))).toEqual({
      _id: 'stripe.stockChange.cs_test_1',
      _type: STOCK_CHANGE_TYPE,
      sessionId: 'cs_test_1',
      loweredAt: '2026-11-10T12:00:00.000Z',
      changes: [
        {_key: 'change-0', productId: 'magazine', from: 3, to: 2},
        {_key: 'change-1', productId: 'shirt', variantKey: 'm', from: 1, to: 0},
      ],
    })
  })

  it('forgets what a payment did to stock after a month', async () => {
    const dataset = fakeDataset()
    const record = (sessionId: string, loweredAt: string): Doc => ({
      _id: stockChangeId(sessionId),
      _type: STOCK_CHANGE_TYPE,
      sessionId,
      loweredAt,
      changes: [],
    })
    dataset.add(record('cs_old', '2026-09-30T12:00:00.000Z'))
    dataset.add(record('cs_recent', '2026-10-20T12:00:00.000Z'))
    await decrementStock(dataset.writer, order, {now: new Date('2026-11-10T12:00:00Z')})
    const left = dataset.ids().filter((id) => id.startsWith('stripe.stockChange.'))
    expect(left.toSorted()).toEqual([
      'stripe.stockChange.cs_recent',
      'stripe.stockChange.cs_test_1',
    ])
  })

  it('says when more was sold than was in stock', async () => {
    const dataset = fakeDataset()
    const result = await decrementStock(dataset.writer, {
      sessionId: 'cs_test_3',
      items: [
        {productId: 'shirt', variantKey: 'm', name: 'Shirt – M', quantity: 3, amountTotal: 8850},
      ],
    })
    expect(result.changes).toEqual([{productId: 'shirt', variantKey: 'm', from: 1, to: -2}])
  })

  it('writes nothing when nothing ordered is counted', async () => {
    const dataset = fakeDataset()
    const before = dataset.ids()
    const result = await decrementStock(dataset.writer, {
      sessionId: 'cs_test_4',
      items: [
        {productId: 'poster', name: 'Poster', quantity: 1, amountTotal: 1200},
        {productId: 'drafts.magazine', name: 'Not a product id', quantity: 1, amountTotal: 100},
      ],
    })
    expect(result).toEqual({status: 'untracked', changes: []})
    expect(dataset.ids()).toEqual(before)
  })

  it('passes on a failure that isn’t a second delivery', async () => {
    const dataset = fakeDataset()
    dataset.failing.commit = Object.assign(new Error('Insufficient permissions'), {statusCode: 403})
    await expect(decrementStock(dataset.writer, order)).rejects.toThrow('Insufficient permissions')
    // A conflict with no record behind it is not "already done" either.
    dataset.failing.commit = Object.assign(new Error('Conflict'), {statusCode: 409})
    await expect(decrementStock(dataset.writer, order)).rejects.toThrow('Conflict')
    expect(dataset.value(stockId('magazine'), 'stockCount')).toBe(3)
  })
})

describe('webhookRoute', () => {
  const setup = (
    options: {
      session?: Record<string, unknown>
      onOrder?: (order: Order, context: OrderContext) => Promise<void>
      counted?: boolean
    } = {},
  ) => {
    const stripeSide = fakeStripe(options.session ? {session: options.session} : {})
    const dataset = fakeDataset()
    const orders: Array<{order: Order; context: OrderContext}> = []
    const onOrder = vi.fn(async (order: Order, context: OrderContext) => {
      orders.push({order, context})
      await options.onOrder?.(order, context)
    })
    const onPaymentFailed = vi.fn()
    const log = vi.fn()
    const handler = webhookRoute({
      stripe: stripeSide.stripe,
      webhookSecret: WEBHOOK_SECRET,
      integrationIdentifier: SHOP_TAG,
      client: dataset.reader,
      stockClient: options.counted === false ? null : dataset.writer,
      onOrder,
      onPaymentFailed,
      log,
    })
    const deliver = (type = 'checkout.session.completed', session = PAID_SESSION) =>
      handler(webhookRequest(stripeSide.stripe, type, session))
    return {...stripeSide, dataset, orders, onOrder, onPaymentFailed, log, deliver, handler}
  }
  const magazines = (dataset: ReturnType<typeof fakeDataset>) =>
    dataset.value(stockId('magazine'), 'stockCount')

  it('lowers stock and hands the order over when a payment lands', async () => {
    const {deliver, dataset, orders, metadata} = setup()
    const response = await deliver()
    expect(response.status).toBe(200)
    expect(magazines(dataset)).toBe(2)
    expect(orders).toHaveLength(1)
    expect(orders[0]?.order.customer.email).toBe('ada@example.com')
    expect(orders[0]?.context.settings?.autoSoldOut).toBe(true)
    expect(orders[0]?.context.stock).toEqual([
      {productId: 'magazine', from: 3, to: 2},
      {productId: 'shirt', variantKey: 'm', from: 1, to: 0},
    ])
    // The finished step is written on the session itself.
    expect(Object.keys(metadata)).toContain('fulfilled_order')
  })

  it('does each step once when Stripe delivers the event again', async () => {
    const {deliver, dataset, onOrder} = setup()
    await deliver()
    const again = await deliver('checkout.session.async_payment_succeeded')
    expect(again.status).toBe(200)
    expect(magazines(dataset)).toBe(2)
    expect(onOrder).toHaveBeenCalledOnce()
  })

  it('fulfils a free order once too, though it has no payment to mark', async () => {
    const {deliver, onOrder} = setup({
      session: {payment_intent: null, payment_status: 'no_payment_required', amount_total: 0},
    })
    await deliver()
    await deliver()
    expect(onOrder).toHaveBeenCalledOnce()
  })

  it.each([
    ['a Payment Link, which carries no mark', {integration_identifier: null}],
    ['another site on the account', {integration_identifier: 'othershop_zyxwvuts'}],
    ['a subscription', {mode: 'subscription'}],
  ])('leaves alone a payment made any other way: %s', async (_, session) => {
    const {deliver, dataset, onOrder, metadata} = setup({session})
    expect((await deliver()).status).toBe(200)
    expect(onOrder).not.toHaveBeenCalled()
    expect(magazines(dataset)).toBe(3)
    expect(Object.keys(metadata)).not.toContain('fulfilled_order')
  })

  it('answers 500 when the order can’t be handed over, and tries that step alone next time', async () => {
    let failing = true
    const {deliver, dataset, orders} = setup({
      onOrder: async () => {
        if (failing) throw new Error('The email service is down')
      },
    })
    expect((await deliver()).status).toBe(500)
    failing = false
    expect((await deliver()).status).toBe(200)
    expect(magazines(dataset)).toBe(2)
    // The second try still knows what the first one did to stock.
    expect(orders).toHaveLength(2)
    expect(orders[1]?.context.stock).toEqual(orders[0]?.context.stock)
  })

  it('still hands the order over when stock can’t be lowered, and asks Stripe to come back', async () => {
    const {deliver, dataset, orders, onOrder} = setup()
    dataset.failing.commit = Object.assign(new Error('Insufficient permissions'), {statusCode: 403})
    expect((await deliver()).status).toBe(500)
    expect(orders[0]?.context).toMatchObject({stock: [], stockError: 'Insufficient permissions'})
    expect(magazines(dataset)).toBe(3)

    // The token is fixed: the next delivery lowers stock and doesn't send the order twice.
    dataset.failing.commit = null
    expect((await deliver()).status).toBe(200)
    expect(magazines(dataset)).toBe(2)
    expect(onOrder).toHaveBeenCalledOnce()
  })

  it('waits for a delayed payment before doing anything', async () => {
    const {deliver, dataset, onOrder, calls} = setup()
    const response = await deliver('checkout.session.completed', {
      ...PAID_SESSION,
      payment_status: 'unpaid',
    })
    expect(response.status).toBe(200)
    expect(calls).toEqual([])
    expect(onOrder).not.toHaveBeenCalled()
    expect(magazines(dataset)).toBe(3)
  })

  it('trusts the session Stripe’s API returns over the one in the event', async () => {
    const {deliver, dataset, onOrder} = setup({session: {payment_status: 'unpaid'}})
    // The event says paid; the API says the session is still unpaid.
    await deliver()
    expect(onOrder).not.toHaveBeenCalled()
    expect(magazines(dataset)).toBe(3)
  })

  it('refuses a delivery that Stripe didn’t sign', async () => {
    const {stripe, handler, onOrder} = setup()
    const forged = webhookRequest(
      stripe,
      'checkout.session.completed',
      PAID_SESSION,
      'whsec_forged',
    )
    expect((await handler(forged)).status).toBe(400)
    expect(onOrder).not.toHaveBeenCalled()
  })

  it('answers 503 until the site has a key and a signing secret', async () => {
    const {stripe, dataset} = setup()
    const base = {integrationIdentifier: SHOP_TAG, client: dataset.reader, log: quiet}
    const request = () => webhookRequest(stripe, 'checkout.session.completed')
    const noSecret = webhookRoute({...base, stripe, webhookSecret: undefined})
    const noKey = webhookRoute({...base, stripe: null, webhookSecret: WEBHOOK_SECRET})
    expect((await noSecret(request())).status).toBe(503)
    expect((await noKey(request())).status).toBe(503)
  })

  it('leaves stock alone without a client that can write, and says so once', async () => {
    const {deliver, dataset, onOrder, log} = setup({counted: false})
    await deliver()
    await deliver()
    expect(magazines(dataset)).toBe(3)
    expect(onOrder).toHaveBeenCalledOnce()
    expect(
      log.mock.calls.filter(([, message]) => String(message).includes('stockClient')),
    ).toHaveLength(1)
  })

  it('tells the site when a delayed payment of the shop fails, and only then', async () => {
    const own = setup()
    await own.deliver('checkout.session.async_payment_failed')
    expect(own.onPaymentFailed).toHaveBeenCalledOnce()

    const other = setup({session: {integration_identifier: null}})
    await other.deliver('checkout.session.async_payment_failed')
    expect(other.onPaymentFailed).not.toHaveBeenCalled()
  })
})

describe('orderEmail', () => {
  const order: Order = {
    sessionId: 'cs_test_1',
    paymentIntentId: 'pi_1',
    livemode: false,
    currency: 'eur',
    amountTotal: 6650,
    amountShipping: 1200,
    regionTitle: 'European Union',
    customer: {name: 'Ada Lovelace', email: 'ada@example.com', phone: null},
    shipping: {
      name: 'Ada <b>Lovelace</b>',
      address: {
        line1: 'Analytical Street 1',
        line2: null,
        postal_code: '1011 AB',
        city: 'Amsterdam',
        state: null,
        country: 'NL',
      },
    },
    items: [
      {productId: 'magazine', name: 'Issue 16', quantity: 1, amountTotal: 2500},
      {productId: 'shirt', variantKey: 'm', name: 'Shirt – M', quantity: 1, amountTotal: 2950},
    ],
    createdAt: new Date('2026-11-10T12:00:00Z'),
  }

  it('says what to pack, where to send it and who paid', () => {
    const email = orderEmail(order, {shopName: 'Example'})
    expect(email.subject).toBe('[Test] Example order from Ada <b>Lovelace</b>: 2 items, €66.50')
    expect(email.text).toContain('1 × Shirt – M  €29.50')
    expect(email.text).toContain('Shipping (European Union)  €12.00')
    expect(email.text).toContain('1011 AB Amsterdam')
    expect(email.text).toContain('https://dashboard.stripe.com/test/payments/pi_1')
  })

  it('keeps what a buyer typed from becoming HTML', () => {
    const email = orderEmail(order, {shopName: 'Example'})
    expect(email.html).toContain('Ada &lt;b&gt;Lovelace&lt;/b&gt;')
    expect(email.html).not.toContain('<b>Lovelace</b>')
  })

  it('formats amounts for the shop’s locale', () => {
    // Dutch puts a non-breaking space after the euro sign.
    expect(orderEmail(order, {shopName: 'Example', locale: 'nl-NL'}).text).toMatch(/€\s29,50/)
  })

  it('calls out anything sold below 0', () => {
    const stock = [
      {productId: 'shirt', variantKey: 'm', from: 0, to: -1},
      {productId: 'magazine', from: 3, to: 2},
    ]
    const email = orderEmail(order, {shopName: 'Example', stock})
    expect(email.text).toContain(
      'Check your stock: more was sold than was counted in stock for Shirt – M.',
    )
    expect(orderEmail(order, {shopName: 'Example'}).text).not.toContain('Check your stock')
  })

  it('says when stock was not lowered', () => {
    const email = orderEmail(order, {shopName: 'Example', stockError: 'Insufficient <permissions>'})
    expect(email.text).toContain(
      'Stock counts were not lowered for this order. Change them by hand.',
    )
    expect(email.html).toContain('Insufficient &lt;permissions&gt;')
  })
})
