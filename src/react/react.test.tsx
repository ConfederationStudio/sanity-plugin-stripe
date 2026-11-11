// @vitest-environment jsdom
import {act, cleanup, render, renderHook} from '@testing-library/react'
import type {ReactNode} from 'react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import type {CartProduct} from '../core/cart'
import {CartProvider, useCart} from './cart'
import {ClearCartOnReturn} from './ClearCartOnReturn'
import {useBuyBox} from './useBuyBox'
import {useCheckout} from './useCheckout'

const wrapper = ({children}: {children: ReactNode}) => (
  <CartProvider storageKey="test-cart">{children}</CartProvider>
)

const stored = (): unknown => JSON.parse(window.localStorage.getItem('test-cart') ?? 'null')

const shirt: CartProduct = {
  _id: 'shirt',
  title: 'Shirt',
  commerce: {
    availability: 'onSale',
    price: 29.5,
    variants: [
      {_key: 's', label: 'S', availability: 'soldOut'},
      {_key: 'm', label: 'M'},
      {_key: 'l', label: 'L'},
    ],
  },
}

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useCart', () => {
  it('adds, merges, changes and removes lines, and keeps them in localStorage', () => {
    const {result} = renderHook(() => useCart(), {wrapper})
    expect(result.current.ready).toBe(true)
    expect(result.current.lines).toEqual([])

    act(() => result.current.add({productId: 'magazine', quantity: 1}))
    act(() => result.current.add({productId: 'magazine', quantity: 2}))
    act(() => result.current.add({productId: 'shirt', variantKey: 'm', quantity: 1}))
    expect(result.current.lines).toEqual([
      {productId: 'magazine', quantity: 3},
      {productId: 'shirt', variantKey: 'm', quantity: 1},
    ])
    expect(result.current.count).toBe(4)
    expect(stored()).toEqual(result.current.lines)

    act(() => result.current.setQuantity({productId: 'magazine'}, 1))
    act(() => result.current.remove({productId: 'shirt', variantKey: 'm'}))
    expect(result.current.lines).toEqual([{productId: 'magazine', quantity: 1}])

    act(() => result.current.setQuantity({productId: 'magazine'}, 0))
    expect(result.current.lines).toEqual([])
  })

  it('never holds more of a line than the limit, the stock or 10', () => {
    const {result} = renderHook(() => useCart(), {wrapper})
    act(() => result.current.add({productId: 'magazine', quantity: 5}, 3))
    expect(result.current.lines).toEqual([{productId: 'magazine', quantity: 3}])
    act(() => result.current.setQuantity({productId: 'magazine'}, 50))
    expect(result.current.lines).toEqual([{productId: 'magazine', quantity: 10}])
  })

  it('starts from what an earlier visit stored, and drops what it can’t read', () => {
    window.localStorage.setItem(
      'test-cart',
      JSON.stringify([{productId: 'magazine', quantity: 2}, {productId: 5}, 'junk']),
    )
    const {result} = renderHook(() => useCart(), {wrapper})
    expect(result.current.lines).toEqual([{productId: 'magazine', quantity: 2}])
  })

  it('follows a change made in another tab', () => {
    const {result} = renderHook(() => useCart(), {wrapper})
    act(() => {
      window.localStorage.setItem('test-cart', JSON.stringify([{productId: 'print', quantity: 1}]))
      window.dispatchEvent(new StorageEvent('storage', {key: 'test-cart'}))
    })
    expect(result.current.lines).toEqual([{productId: 'print', quantity: 1}])
  })

  it('needs a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useCart())).toThrow('CartProvider')
  })
})

describe('useBuyBox', () => {
  it('starts on the first variant on sale, and stops at the most one order can hold', () => {
    const upToTwo = ({children}: {children: ReactNode}) => (
      <CartProvider storageKey="test-cart" maxQuantity={2}>
        {children}
      </CartProvider>
    )
    const {result} = renderHook(() => useBuyBox(shirt), {wrapper: upToTwo})
    expect(result.current.variants.map(({_key, available}) => [_key, available])).toEqual([
      ['s', false],
      ['m', true],
      ['l', true],
    ])
    expect(result.current.variantKey).toBe('m')
    expect(result.current.soldOut).toBe(false)

    act(() => result.current.add())
    expect(result.current.added).toBe(true)
    expect(result.current.inCart).toBe(1)
    act(() => result.current.add())
    act(() => result.current.add())
    expect(result.current.inCart).toBe(2)
    expect(result.current.full).toBe(true)

    act(() => result.current.chooseVariant('l'))
    expect(result.current.added).toBe(false)
    expect(result.current.inCart).toBe(0)
    expect(result.current.full).toBe(false)
  })

  it('says when nothing of a product can be bought', () => {
    const gone = {...shirt, commerce: {...shirt.commerce, availability: 'soldOut' as const}}
    const {result} = renderHook(() => useBuyBox(gone), {wrapper})
    expect(result.current.soldOut).toBe(true)
    act(() => result.current.add())
    expect(result.current.inCart).toBe(0)
  })

  it('lets the buyer subscribe, on a cart line of its own', () => {
    const serum: CartProduct = {
      _id: 'serum',
      title: 'Serum',
      commerce: {
        availability: 'onSale',
        price: 21.99,
        subscription: {enabled: true, price: 19.79, every: 6, unit: 'week'},
      },
    }
    const {result} = renderHook(() => useBuyBox(serum), {wrapper})
    expect(result.current.subscription).toEqual({price: 19.79, interval: {unit: 'week', every: 6}})
    expect(result.current.plan).toBe('once')
    expect(result.current.status).toMatchObject({available: true, price: 21.99})

    act(() => result.current.add())
    act(() => result.current.choosePlan('subscribe'))
    expect(result.current.added).toBe(false)
    expect(result.current.status).toMatchObject({price: 19.79, interval: {unit: 'week', every: 6}})
    expect(result.current.inCart).toBe(0)
    act(() => result.current.add())
    expect(result.current.inCart).toBe(1)
    expect(stored()).toEqual([
      {productId: 'serum', quantity: 1},
      {productId: 'serum', plan: 'subscribe', quantity: 1},
    ])
  })

  it('offers no subscription on a product without one', () => {
    const {result} = renderHook(() => useBuyBox(shirt), {wrapper})
    expect(result.current.subscription).toBeNull()
    act(() => result.current.choosePlan('subscribe'))
    expect(result.current.plan).toBe('once')
    expect(result.current.status).toMatchObject({available: true, price: 29.5})
  })
})

describe('ClearCartOnReturn', () => {
  const Count = () => <output>{useCart().count}</output>
  const page = () =>
    render(
      <CartProvider storageKey="test-cart">
        <ClearCartOnReturn />
        <Count />
      </CartProvider>,
    )

  beforeEach(() => {
    window.localStorage.setItem('test-cart', JSON.stringify([{productId: 'magazine', quantity: 2}]))
  })

  it('empties the cart when Stripe sends the buyer back with a session id', () => {
    window.history.replaceState(null, '', '/thanks?session_id=cs_test_1')
    expect(page().container.textContent).toBe('0')
    expect(stored()).toEqual([])
  })

  it('leaves the cart alone on any other visit', () => {
    window.history.replaceState(null, '', '/thanks')
    expect(page().container.textContent).toBe('2')
  })
})

describe('useCheckout', () => {
  const reply = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), {status}))

  it('asks for a region before calling the site', async () => {
    const fetchMock = reply({})
    vi.stubGlobal('fetch', fetchMock)
    const {result} = renderHook(() => useCheckout(), {wrapper})
    await act(() => result.current.start(undefined))
    expect(result.current.state).toMatchObject({status: 'error', error: 'region'})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts the cart’s references and the region, never a price', async () => {
    const fetchMock = reply({error: 'unavailable', message: 'Later', problems: []}, 503)
    vi.stubGlobal('fetch', fetchMock)
    const {result} = renderHook(() => ({cart: useCart(), checkout: useCheckout()}), {wrapper})
    act(() => result.current.cart.add({productId: 'magazine', quantity: 2}))
    await act(() => result.current.checkout.start('eu'))
    expect(fetchMock).toHaveBeenCalledWith('/api/checkout', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({lines: [{productId: 'magazine', quantity: 2}], regionId: 'eu'}),
    })
    expect(result.current.checkout.state).toMatchObject({status: 'error', message: 'Later'})
  })

  it('passes on which lines the checkout turned down', async () => {
    const problems = [{productId: 'shirt', variantKey: 'm', reason: 'soldOut'}]
    vi.stubGlobal('fetch', reply({error: 'unavailable', message: 'Changed', problems}, 409))
    const {result} = renderHook(() => useCheckout(), {wrapper})
    await act(() => result.current.start('eu'))
    expect(result.current.state).toEqual({
      status: 'error',
      error: 'unavailable',
      message: 'Changed',
      problems,
    })
    act(() => result.current.reset())
    expect(result.current.state).toEqual({status: 'idle'})
  })

  it('is ready again when the buyer comes back from Stripe with the Back button', async () => {
    // The fetch never answers, as when the browser has already left for Stripe's page.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
    const {result} = renderHook(() => useCheckout(), {wrapper})
    act(() => void result.current.start('eu'))
    expect(result.current.state).toEqual({status: 'loading'})
    // The browser restores the page from its back cache, exactly as it was left.
    act(() => {
      window.dispatchEvent(Object.assign(new Event('pageshow'), {persisted: true}))
    })
    expect(result.current.state).toEqual({status: 'idle'})
  })

  it('says so when the site can’t be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const {result} = renderHook(() => useCheckout(), {wrapper})
    await act(() => result.current.start('eu'))
    expect(result.current.state).toMatchObject({status: 'error', error: 'offline'})
  })
})
