import {describe, expect, it, vi} from 'vitest'

import {fakeDataset, SHOP} from '../__fixtures__/sanity'
import {fakeStripe, PAID_SESSION, WEBHOOK_SECRET, webhookRequest} from '../__fixtures__/stripe'
import {readCartProducts} from '../core/cart'
import {stockRecordId} from '../core/ids'
import {readShopSettings, regionsFromSettings} from '../core/regions'
import {VERSION} from '../version'
import {buildCheckoutSession} from './checkout'
import {orderEmail} from './email'
import {classifyEvent, verifyEvent} from './events'
import {getOrder, type Order} from './order'
import {checkoutRoute, webhookRoute, type OrderContext} from './routes'
import {decrementStock} from './stock'
import {STRIPE_API_VERSION} from './stripe'

const products = readCartProducts(SHOP)
const regions = regionsFromSettings(readShopSettings(SHOP.at(-1)))
const quiet = () => {}

const cart = [
  {productId: 'magazine', quantity: 2},
  {productId: 'shirt', variantKey: 'm', quantity: 1},
]

const checkoutInput = {
  lines: cart,
  regionId: 'eu',
  products,
  regions,
  currency: 'eur',
  successUrl: 'https://shop.example/thanks?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://shop.example/cart',
}

const checkoutRequest = (body: unknown) =>
  new Request('https://shop.example/api/checkout', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('buildCheckoutSession', () => {
  it('prices the cart from Sanity, never from the browser', () => {
    const result = buildCheckoutSession({
      ...checkoutInput,
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
            images: ['https://cdn.sanity.io/images/p/d/magazine.jpg'],
            metadata: {productId: 'magazine'},
          },
        },
      },
    ])
  })

  it('names the variant, and says which product and variant the webhook will read back', () => {
    const result = buildCheckoutSession(checkoutInput)
    expect(result.ok && result.params.line_items?.[1]).toMatchObject({
      quantity: 1,
      price_data: {
        unit_amount: 2950,
        product_data: {name: 'Shirt – M', metadata: {productId: 'shirt', variantKey: 'm'}},
      },
    })
  })

  it('ships to the chosen region only, at its flat rate', () => {
    const result = buildCheckoutSession(checkoutInput)
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
    })
  })

  it('leaves payment methods to the Dashboard', () => {
    const result = buildCheckoutSession(checkoutInput)
    expect(result.ok && Object.keys(result.params)).not.toContain('payment_method_types')
  })

  it('adds the tax rate of each product’s tax class, the tag and the expiry when given', () => {
    const result = buildCheckoutSession({
      ...checkoutInput,
      taxRates: {reduced: 'txr_reduced'},
      integrationIdentifier: 'shop_abcdefgh',
      expiresAt: 1794301800,
    })
    expect(result.ok && result.params.line_items?.[0]?.tax_rates).toEqual(['txr_reduced'])
    // No rate is mapped for the shirt's class.
    expect(result.ok && result.params.line_items?.[1]?.tax_rates).toBeUndefined()
    expect(result.ok && result.params).toMatchObject({
      integration_identifier: 'shop_abcdefgh',
      expires_at: 1794301800,
    })
  })

  it('turns down what can’t be bought, line by line', () => {
    expect(
      buildCheckoutSession({
        ...checkoutInput,
        lines: [
          {productId: 'magazine', quantity: 5},
          {productId: 'shirt', variantKey: 'l', quantity: 1},
          {productId: 'gone', quantity: 1},
        ],
      }),
    ).toEqual({
      ok: false,
      error: 'unavailable',
      problems: [
        {productId: 'magazine', name: 'Issue 16', reason: 'tooMany', maxQuantity: 3},
        {productId: 'shirt', variantKey: 'l', name: 'Shirt', reason: 'soldOut'},
        {productId: 'gone', reason: 'missing'},
      ],
    })
  })

  it('needs something in the cart and a region that exists', () => {
    expect(buildCheckoutSession({...checkoutInput, lines: []})).toMatchObject({error: 'empty'})
    expect(buildCheckoutSession({...checkoutInput, regionId: 'mars'})).toMatchObject({
      error: 'region',
    })
  })
})

describe('checkoutRoute', () => {
  const route = (stripe: ReturnType<typeof fakeStripe>['stripe'] | null, extra = {}) =>
    checkoutRoute({
      stripe,
      client: fakeDataset().client,
      currency: 'eur',
      successUrl: '/thanks?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: '/cart',
      integrationIdentifier: 'shop_abcdefgh',
      log: quiet,
      ...extra,
    })

  it('creates the session with the pinned API version and answers where to go', async () => {
    const {stripe, calls} = fakeStripe()
    const response = await route(stripe)(checkoutRequest({lines: cart, regionId: 'eu'}))
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
    expect(call?.body.get('integration_identifier')).toBe('shop_abcdefgh')
    expect(call?.body.get('line_items[0][price_data][unit_amount]')).toBe('2500')
    expect([...(call?.body.keys() ?? [])].filter((key) => key.includes('payment_method'))).toEqual(
      [],
    )
  })

  it('lets the site change the session before it is created', async () => {
    const {stripe, calls} = fakeStripe()
    const extend = vi.fn((params: object) => ({...params, allow_promotion_codes: true}))
    await route(stripe, {extend})(checkoutRequest({lines: cart, regionId: 'nl'}))
    expect(extend).toHaveBeenCalledOnce()
    expect(calls[0]?.body.get('allow_promotion_codes')).toBe('true')
  })

  it('says what changed in the cart, without calling Stripe', async () => {
    const {stripe, calls} = fakeStripe()
    const response = await route(stripe)(
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
    const plain = await route(null)(request())
    expect(plain.status).toBe(503)
    expect(Object.keys(Object(await plain.json()))).toEqual(['error', 'message'])
    const debugging = await route(null, {debug: true})(request())
    expect(await debugging.json()).toMatchObject({detail: expect.stringContaining('Stripe key')})
  })

  it('answers 503 until the shop settings are published', async () => {
    const {stripe} = fakeStripe()
    const client = fakeDataset(SHOP.slice(0, 3)).client
    const response = await route(stripe, {client})(checkoutRequest({lines: cart, regionId: 'eu'}))
    expect(response.status).toBe(503)
  })

  it('refuses a body that isn’t a cart', async () => {
    const {stripe} = fakeStripe()
    expect((await route(stripe)(checkoutRequest('not json'))).status).toBe(400)
    expect((await route(stripe)(checkoutRequest([1, 2]))).status).toBe(400)
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

  it('lowers the published document and its draft, and sells out at 0', async () => {
    const dataset = fakeDataset()
    const result = await decrementStock(dataset.client, order)
    expect(result.status).toBe('lowered')
    expect(dataset.perspectives).toEqual(['raw'])
    expect(dataset.value('magazine', 'commerce.stockCount')).toBe(2)
    expect(dataset.value('drafts.magazine', 'commerce.stockCount')).toBe(2)
    expect(dataset.value('magazine', 'commerce.availability')).toBe('onSale')
    expect(dataset.value('shirt', 'commerce.variants[_key=="m"].stockCount')).toBe(0)
    expect(dataset.value('shirt', 'commerce.variants[_key=="m"].availability')).toBe('soldOut')
  })

  it('leaves the switch alone when the shop doesn’t sell out automatically', async () => {
    const dataset = fakeDataset()
    await decrementStock(dataset.client, order, {autoSoldOut: false})
    expect(dataset.value('shirt', 'commerce.variants[_key=="m"].stockCount')).toBe(0)
    expect(dataset.value('shirt', 'commerce.variants[_key=="m"].availability')).toBeUndefined()
  })

  it('lowers stock once per session, however often it is asked', async () => {
    const dataset = fakeDataset()
    const first = await decrementStock(dataset.client, order)
    const second = await decrementStock(dataset.client, order)
    expect(second).toEqual({status: 'already', changes: first.changes})
    expect(dataset.value('magazine', 'commerce.stockCount')).toBe(2)
  })

  it('lowers stock once when two deliveries arrive in the same moment', async () => {
    const dataset = fakeDataset()
    const results = await Promise.all([
      decrementStock(dataset.client, order),
      decrementStock(dataset.client, order),
    ])
    expect(results.map((result) => result.status).toSorted()).toEqual(['already', 'lowered'])
    expect(dataset.value('magazine', 'commerce.stockCount')).toBe(2)
    expect(dataset.value('shirt', 'commerce.variants[_key=="m"].stockCount')).toBe(0)
  })

  it('records the session under an id only a token can read, with nothing about the buyer', async () => {
    const dataset = fakeDataset()
    await decrementStock(dataset.client, order)
    const record = dataset.get(stockRecordId('cs_test_1'))
    expect(record?._id).toContain('.')
    expect(Object.keys(record ?? {}).toSorted()).toEqual([
      '_id',
      '_type',
      'changes',
      'loweredAt',
      'sessionId',
    ])
  })

  it('says when more was sold than was in stock', async () => {
    const dataset = fakeDataset()
    const three = {
      sessionId: 'cs_test_2',
      items: [{...order.items[1], name: 'Shirt – M', quantity: 3, amountTotal: 8850}],
    }
    const result = await decrementStock(dataset.client, three)
    expect(result.changes).toEqual([
      {documentId: 'shirt', productId: 'shirt', variantKey: 'm', from: 1, to: -2},
    ])
  })

  it('writes nothing when nothing ordered has a stock count', async () => {
    const dataset = fakeDataset()
    const before = dataset.ids()
    const result = await decrementStock(dataset.client, {
      sessionId: 'cs_test_3',
      items: [
        {productId: 'shirt', variantKey: 'l', name: 'Shirt – L', quantity: 1, amountTotal: 2950},
      ],
    })
    expect(result).toEqual({status: 'untracked', changes: []})
    expect(dataset.ids()).toEqual(before)
  })
})

describe('webhookRoute', () => {
  const setup = (
    options: {onOrder?: (order: Order, context: OrderContext) => Promise<void>} = {},
  ) => {
    const stripeSide = fakeStripe()
    const dataset = fakeDataset()
    const orders: Array<{order: Order; context: OrderContext}> = []
    const onOrder = vi.fn(async (order: Order, context: OrderContext) => {
      orders.push({order, context})
      await options.onOrder?.(order, context)
    })
    const handler = webhookRoute({
      stripe: stripeSide.stripe,
      webhookSecret: WEBHOOK_SECRET,
      client: dataset.client,
      writeClient: dataset.client,
      onOrder,
      log: quiet,
    })
    const deliver = (type = 'checkout.session.completed', session = PAID_SESSION) =>
      handler(webhookRequest(stripeSide.stripe, type, session))
    return {...stripeSide, dataset, orders, onOrder, deliver}
  }

  it('lowers stock and hands the order over when a payment lands', async () => {
    const {deliver, dataset, orders, intentMetadata} = setup()
    const response = await deliver()
    expect(response.status).toBe(200)
    expect(dataset.value('magazine', 'commerce.stockCount')).toBe(2)
    expect(orders).toHaveLength(1)
    expect(orders[0]?.order.customer.email).toBe('ada@example.com')
    expect(orders[0]?.context.settings?.orderEmail).toBe('orders@example.com')
    expect(orders[0]?.context.stock.map((change) => change.documentId)).toEqual([
      'magazine',
      'drafts.magazine',
      'shirt',
    ])
    expect(Object.keys(intentMetadata)).toEqual(['fulfilled_order'])
  })

  it('does each step once when Stripe delivers the event again', async () => {
    const {deliver, dataset, onOrder} = setup()
    await deliver()
    const again = await deliver('checkout.session.async_payment_succeeded')
    expect(again.status).toBe(200)
    expect(dataset.value('magazine', 'commerce.stockCount')).toBe(2)
    expect(onOrder).toHaveBeenCalledOnce()
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
    expect(dataset.value('magazine', 'commerce.stockCount')).toBe(2)
    // The second try still knows what the first one did to stock.
    expect(orders).toHaveLength(2)
    expect(orders[1]?.context.stock).toEqual(orders[0]?.context.stock)
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
    expect(dataset.value('magazine', 'commerce.stockCount')).toBe(3)
  })

  it('trusts the session Stripe’s API returns over the one in the event', async () => {
    const stripeSide = fakeStripe({session: {payment_status: 'unpaid'}})
    const dataset = fakeDataset()
    const onOrder = vi.fn()
    const handler = webhookRoute({
      stripe: stripeSide.stripe,
      webhookSecret: WEBHOOK_SECRET,
      client: dataset.client,
      writeClient: dataset.client,
      onOrder,
      log: quiet,
    })
    // The event says paid; the API says the session is still unpaid.
    await handler(webhookRequest(stripeSide.stripe, 'checkout.session.completed'))
    expect(onOrder).not.toHaveBeenCalled()
    expect(dataset.value('magazine', 'commerce.stockCount')).toBe(3)
  })

  it('refuses a delivery that Stripe didn’t sign', async () => {
    const {stripe, dataset, onOrder} = setup()
    const handler = webhookRoute({
      stripe,
      webhookSecret: WEBHOOK_SECRET,
      client: dataset.client,
      onOrder,
      log: quiet,
    })
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
    const request = () => webhookRequest(stripe, 'checkout.session.completed')
    const noSecret = webhookRoute({
      stripe,
      webhookSecret: undefined,
      client: dataset.client,
      log: quiet,
    })
    const noKey = webhookRoute({
      stripe: null,
      webhookSecret: WEBHOOK_SECRET,
      client: dataset.client,
      log: quiet,
    })
    expect((await noSecret(request())).status).toBe(503)
    expect((await noKey(request())).status).toBe(503)
  })

  it('leaves stock alone without a client that can write', async () => {
    const {stripe, dataset} = setup()
    const onOrder = vi.fn()
    const handler = webhookRoute({
      stripe,
      webhookSecret: WEBHOOK_SECRET,
      client: dataset.client,
      onOrder,
      log: quiet,
    })
    await handler(webhookRequest(stripe, 'checkout.session.completed'))
    expect(dataset.value('magazine', 'commerce.stockCount')).toBe(3)
    expect(onOrder).toHaveBeenCalledOnce()
  })

  it('tells the site when a delayed payment fails', async () => {
    const {stripe, dataset} = setup()
    const onPaymentFailed = vi.fn()
    const handler = webhookRoute({
      stripe,
      webhookSecret: WEBHOOK_SECRET,
      client: dataset.client,
      onPaymentFailed,
      log: quiet,
    })
    await handler(webhookRequest(stripe, 'checkout.session.async_payment_failed'))
    expect(onPaymentFailed).toHaveBeenCalledOnce()
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

  it('calls out anything sold below 0, once', () => {
    const stock = [
      {documentId: 'shirt', productId: 'shirt', variantKey: 'm', from: 0, to: -1},
      {documentId: 'drafts.shirt', productId: 'shirt', variantKey: 'm', from: 0, to: -1},
      {documentId: 'magazine', productId: 'magazine', from: 3, to: 2},
    ]
    const email = orderEmail(order, {shopName: 'Example', stock})
    expect(email.text).toContain(
      'Check your stock: more was sold than was counted in stock for Shirt – M.',
    )
    expect(orderEmail(order, {shopName: 'Example'}).text).not.toContain('Check your stock')
  })
})
