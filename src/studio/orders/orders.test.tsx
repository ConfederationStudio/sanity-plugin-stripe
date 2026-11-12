// @vitest-environment jsdom
import {ThemeProvider} from '@sanity/ui'
import {buildTheme} from '@sanity/ui/theme'
import {ToastProvider} from '@sanity/ui/toast'
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react'
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest'

import type {OrderDetail, OrderSummary} from '../../core/orders'
import {addOlder, buyerLabel, countryName, formatWhen, orderBadges, refundLabel} from './format'
import {OrdersView} from './OrdersView'
import {failureText, routeClient, RouteError, type RouteClient} from './route'

const API = 'https://shop.example/api/shop'

const summary = (fields: Partial<OrderSummary> = {}): OrderSummary => ({
  id: 'cs_test_1',
  kind: 'order',
  createdAt: '2026-11-10T08:40:00.000Z',
  status: 'paid',
  currency: 'eur',
  amountTotal: 6650,
  customer: {name: 'Ada Lovelace', email: 'ada@example.com'},
  country: 'NL',
  subscription: false,
  livemode: true,
  ...fields,
})

const detail = (fields: Partial<OrderDetail> = {}): OrderDetail => ({
  ...summary(),
  items: [
    {name: 'Issue 16', quantity: 2, amountTotal: 5000, productId: 'magazine'},
    {name: 'Coffee', quantity: 1, amountTotal: 450, subscription: true},
  ],
  amountShipping: 1200,
  regionTitle: 'European Union',
  phone: '+31 20 123 4567',
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
  interval: 'every 6 weeks',
  amountRefunded: 0,
  handledAt: null,
  stripeUrl: 'https://dashboard.stripe.com/payments/pi_1',
  ...fields,
})

describe('what the list says about an order', () => {
  it('writes the time in the editor’s language and time zone', () => {
    expect(formatWhen('2026-11-10T08:40:00.000Z', 'en-GB', 'Europe/Amsterdam')).toBe(
      '10 Nov 2026, 09:40',
    )
    expect(formatWhen('not a date')).toBe('')
  })

  it('names the country, and falls back on what it was given', () => {
    expect(countryName('NL')).toBe('Netherlands')
    expect(countryName('de', 'nl')).toBe('Duitsland')
    expect(countryName('not a code')).toBe('not a code')
    expect(countryName(null)).toBeNull()
  })

  it('shows an order under the buyer’s name, else their email address', () => {
    expect(buyerLabel(summary())).toBe('Ada Lovelace')
    expect(buyerLabel(summary({customer: {name: null, email: 'ada@example.com'}}))).toBe(
      'ada@example.com',
    )
    expect(buyerLabel(summary({customer: {name: '', email: null}}))).toBe('A customer')
  })

  it('marks only what sets an order apart', () => {
    const texts = (fields: Partial<OrderSummary>) =>
      orderBadges(summary(fields)).map(({text}) => text)
    expect(texts({})).toEqual([])
    expect(texts({status: 'unpaid', livemode: false})).toEqual(['Not paid', 'Test'])
    expect(texts({subscription: true})).toEqual(['New subscription'])
    expect(texts({kind: 'renewal', subscription: true})).toEqual(['Renewal'])
  })

  it('says how much of an order was paid back', () => {
    expect(refundLabel({amountRefunded: 0, amountTotal: 6650})).toBeNull()
    expect(refundLabel({amountRefunded: null, amountTotal: 6650})).toBeNull()
    expect(refundLabel({amountRefunded: 2500, amountTotal: 6650})).toBe('Partly refunded')
    expect(refundLabel({amountRefunded: 6650, amountTotal: 6650})).toBe('Fully refunded')
  })

  it('adds older orders without showing one twice', () => {
    const shown = [summary({id: 'cs_3'}), summary({id: 'cs_2'})]
    expect(
      addOlder(shown, [summary({id: 'cs_2'}), summary({id: 'cs_1'})]).map(({id}) => id),
    ).toEqual(['cs_3', 'cs_2', 'cs_1'])
  })
})

describe('routeClient', () => {
  it('asks the site as the editor, and for older orders with the answer’s `next`', async () => {
    const asked: Array<{url: string; authorization: string | null}> = []
    const route = routeClient(API, 'editor-token', async (input, init) => {
      asked.push({
        url: input instanceof Request ? input.url : input.toString(),
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return Response.json({orders: [], next: null})
    })
    await route.orders()
    await route.orders('1035')
    await route.order('cs_test_1')
    expect(asked).toEqual([
      {url: `${API}/orders`, authorization: 'Bearer editor-token'},
      {url: `${API}/orders?before=1035`, authorization: 'Bearer editor-token'},
      {url: `${API}/orders/cs_test_1`, authorization: 'Bearer editor-token'},
    ])
  })

  it('asks no one without a token', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(routeClient(API, undefined, fetcher).orders()).rejects.toMatchObject({
      code: 'no-token',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('tells a site that is down from one that refuses', async () => {
    const down = routeClient(API, 'token', async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(down.orders()).rejects.toMatchObject({code: 'unreachable'})

    const refusing = routeClient(API, 'token', async () =>
      Response.json({error: 'forbidden-role'}, {status: 403}),
    )
    await expect(refusing.orders()).rejects.toMatchObject({code: 'forbidden-role'})

    const broken = routeClient(API, 'token', async () => new Response('<html>', {status: 500}))
    await expect(broken.orders()).rejects.toMatchObject({code: 'stripe-failed'})
  })

  it('has something to say about every failure', () => {
    expect(failureText(new RouteError('unreachable'), API)).toContain(API)
    expect(failureText(new RouteError('forbidden-role'), API)).toContain('role')
    expect(failureText(new RouteError('no-token'), API)).toContain('sign in again')
    expect(failureText(new Error('anything else'), API)).toBe(
      'Stripe didn’t answer the site. Try again.',
    )
  })
})

const THEME = buildTheme()

describe('OrdersView', () => {
  // jsdom has no media queries, which the UI library asks about.
  beforeAll(() => {
    Object.assign(window, {
      matchMedia: (media: string) => ({
        media,
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    })
  })
  afterEach(cleanup)

  const show = (route: RouteClient) =>
    render(
      <ThemeProvider theme={THEME}>
        <ToastProvider>
          <OrdersView route={route} api={API} locale="en-GB" />
        </ToastProvider>
      </ThemeProvider>,
    )

  it('lists the orders, and opens one to show what to pack and where to send it', async () => {
    const order = vi.fn<RouteClient['order']>(async () => ({order: detail({amountRefunded: 2500})}))
    const route: RouteClient = {
      orders: async () => ({
        orders: [summary(), summary({id: 'in_test_1', kind: 'renewal', subscription: true})],
        next: null,
      }),
      order,
    }
    show(route)
    const rows = await screen.findAllByRole('button', {name: /Ada Lovelace/})
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('€66.50')
    expect(rows[0]?.textContent).toContain('Netherlands')
    expect(rows[1]?.textContent).toContain('Renewal')
    expect(order).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', {name: 'Show older orders'})).toBeNull()

    const [first] = rows
    if (!first) throw new Error('no row')
    fireEvent.click(first)
    expect(await screen.findByText('2 × Issue 16')).toBeTruthy()
    expect(order).toHaveBeenCalledExactlyOnceWith('cs_test_1')
    expect(screen.getByText('Subscription, every 6 weeks')).toBeTruthy()
    expect(screen.getByText('Delivery: European Union')).toBeTruthy()
    expect(screen.getByText('Analytical Street 1')).toBeTruthy()
    expect(screen.getByText('1011 AB Amsterdam')).toBeTruthy()
    expect(screen.getByText(/Partly refunded: €25.00/)).toBeTruthy()
    expect(screen.getByRole('link', {name: /Open in Stripe/}).getAttribute('href')).toBe(
      'https://dashboard.stripe.com/payments/pi_1',
    )
  })

  it('adds older orders when asked, and asks again on Refresh', async () => {
    const orders = vi.fn<RouteClient['orders']>(async (before) =>
      before
        ? {
            orders: [summary({id: 'cs_old', customer: {name: 'Grace Hopper', email: null}})],
            next: null,
          }
        : {orders: [summary()], next: '1035'},
    )
    show({orders, order: vi.fn<RouteClient['order']>()})
    fireEvent.click(await screen.findByRole('button', {name: 'Show older orders'}))
    expect(await screen.findByText('Grace Hopper')).toBeTruthy()
    expect(orders).toHaveBeenLastCalledWith('1035')
    expect(screen.getByText('Ada Lovelace')).toBeTruthy()
    expect(screen.queryByRole('button', {name: 'Show older orders'})).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', {name: 'Refresh'}))
    })
    await waitFor(() => expect(orders).toHaveBeenCalledTimes(3))
    expect(orders).toHaveBeenLastCalledWith()
    await waitFor(() => expect(screen.queryByText('Grace Hopper')).toBeNull())
  })

  it('says there are none yet, and why when the site refuses', async () => {
    const empty = show({
      orders: async () => ({orders: [], next: null}),
      order: vi.fn<RouteClient['order']>(),
    })
    expect(await screen.findByText(/No orders yet/)).toBeTruthy()
    empty.unmount()

    show({
      orders: async () => {
        throw new RouteError('forbidden-role')
      },
      order: vi.fn<RouteClient['order']>(),
    })
    expect(await screen.findByText(/may not see orders/)).toBeTruthy()
  })

  it('warns before an unpaid order is sent', async () => {
    show({
      orders: async () => ({orders: [summary({status: 'unpaid'})], next: null}),
      order: async () => ({order: detail({status: 'unpaid'})}),
    })
    fireEvent.click(await screen.findByRole('button', {name: /Ada Lovelace/}))
    expect(await screen.findByText(/Don’t send this order/)).toBeTruthy()
  })
})
