import {describe, expect, it} from 'vitest'

import {
  cartRows,
  cartSubtotal,
  lineStatus,
  readCartProducts,
  sanitizeLines,
  type CartProduct,
} from './cart'
import {EU_COUNTRIES, STRIPE_SHIPPING_COUNTRIES} from './countries'
import {stockRecordId} from './ids'
import {formatMoney, priceDecimals, toMinorUnits} from './money'
import {
  cartProductProjection,
  cartProductsQuery,
  checkoutProductsQuery,
  SHOP_SETTINGS_QUERY,
  stockQuery,
} from './queries'
import {readShopSettings, regionOptions, regionsFromSettings, resolveRegions} from './regions'

const magazine: CartProduct = {
  _id: 'magazine',
  title: 'Issue 16',
  commerce: {availability: 'onSale', price: 25, stockCount: 3},
}
const shirt: CartProduct = {
  _id: 'shirt',
  title: 'Shirt',
  commerce: {
    availability: 'onSale',
    price: 29.5,
    variants: [
      {_key: 'm', label: 'M', stockCount: 2},
      {_key: 'l', label: 'L', availability: 'soldOut'},
      {_key: 'xl', label: 'XL'},
    ],
  },
}

describe('sanitizeLines', () => {
  it('keeps valid lines, merges duplicates and caps quantities', () => {
    expect(
      sanitizeLines([
        {productId: 'a', quantity: 2},
        {productId: 'a', quantity: 3},
        {productId: 'b', variantKey: 'm', quantity: 99},
      ]),
    ).toEqual([
      {productId: 'a', quantity: 5},
      {productId: 'b', variantKey: 'm', quantity: 10},
    ])
  })

  it('drops what a browser should never send', () => {
    expect(sanitizeLines('nothing')).toEqual([])
    expect(
      sanitizeLines([
        null,
        'a',
        {productId: '', quantity: 1},
        {productId: 'a', quantity: '2'},
        {productId: 'a', quantity: Number.NaN},
        {productId: 'a', quantity: 0},
        {productId: 'a', variantKey: 5, quantity: 1},
        {productId: 'a'.repeat(201), quantity: 1},
      ]),
    ).toEqual([])
  })

  it('never passes a price along', () => {
    expect(sanitizeLines([{productId: 'a', quantity: 1, price: 0.01}])).toEqual([
      {productId: 'a', quantity: 1},
    ])
  })
})

describe('lineStatus', () => {
  it('caps the quantity at the stock count', () => {
    expect(lineStatus(magazine)).toEqual({
      available: true,
      maxQuantity: 3,
      price: 25,
      variant: undefined,
    })
  })

  it('counts a stock of 0 as sold out, whatever the switch says', () => {
    const empty = {...magazine, commerce: {...magazine.commerce, stockCount: 0}}
    expect(lineStatus(empty)).toEqual({available: false, reason: 'soldOut'})
  })

  it('asks for a variant when the product has them', () => {
    expect(lineStatus(shirt)).toEqual({available: false, reason: 'chooseVariant'})
    expect(lineStatus(shirt, 'l')).toEqual({available: false, reason: 'soldOut'})
    expect(lineStatus(shirt, 'xs')).toEqual({available: false, reason: 'variantMissing'})
    expect(lineStatus(shirt, 'm')).toMatchObject({available: true, maxQuantity: 2, price: 29.5})
    expect(lineStatus(shirt, 'xl')).toMatchObject({available: true, maxQuantity: 10})
  })

  it('turns down what is missing, unpriced or not a variant', () => {
    expect(lineStatus(undefined)).toEqual({available: false, reason: 'missing'})
    expect(lineStatus({_id: 'a', commerce: {availability: 'onSale'}})).toEqual({
      available: false,
      reason: 'noPrice',
    })
    expect(lineStatus(magazine, 'm')).toEqual({available: false, reason: 'variantMissing'})
  })
})

describe('cartRows', () => {
  it('names, caps and totals each line', () => {
    const rows = cartRows(
      [
        {productId: 'magazine', quantity: 5},
        {productId: 'shirt', variantKey: 'm', quantity: 1},
        {productId: 'gone', quantity: 1},
      ],
      [magazine, shirt],
    )
    expect(rows.map(({name, quantity, total}) => ({name, quantity, total}))).toEqual([
      {name: 'Issue 16', quantity: 3, total: 75},
      {name: 'Shirt – M', quantity: 1, total: 29.5},
      {name: 'Item', quantity: 0, total: 0},
    ])
    expect(cartSubtotal(rows)).toBe(104.5)
  })
})

describe('money', () => {
  it('sends two-decimal currencies in cents', () => {
    expect(toMinorUnits(25, 'eur')).toBe(2500)
    expect(toMinorUnits(19.99, 'USD')).toBe(1999)
    expect(toMinorUnits(29.5, 'gbp')).toBe(2950)
  })

  it('sends zero-decimal currencies as they are', () => {
    expect(toMinorUnits(500, 'jpy')).toBe(500)
    expect(priceDecimals('jpy')).toBe(0)
    expect(formatMoney(500, 'jpy', 'en')).toBe('¥500')
  })

  it('follows Stripe’s special cases', () => {
    // Three decimals, and the last one must be 0.
    expect(toMinorUnits(1.234, 'kwd')).toBe(1230)
    // Whole amounts, sent as if they had two decimals.
    expect(toMinorUnits(5, 'isk')).toBe(500)
    expect(priceDecimals('isk')).toBe(0)
  })

  it('formats Stripe’s amounts for people', () => {
    expect(formatMoney(2950, 'eur', 'en')).toBe('€29.50')
  })
})

describe('regions', () => {
  const settings = readShopSettings({
    shippingRegions: [
      {_key: 'nl', title: 'Netherlands', countries: ['NL'], rate: 5},
      {_key: 'eu', title: 'European Union', countries: ['DE', 'FR', 'XX'], rate: 12},
      {_key: 'world', title: 'Rest of the world', everywhereElse: true, rate: 18},
      {_key: 'draft', title: 'Half filled in'},
      'not a region',
    ],
    orderEmail: 'orders@example.com',
  })

  it('reads the settings and leaves out regions that aren’t filled in', () => {
    expect(readShopSettings(null)).toBeNull()
    expect(settings?.orderEmail).toBe('orders@example.com')
    expect(regionsFromSettings(settings).map((region) => region.id)).toEqual(['nl', 'eu', 'world'])
  })

  it('fills "everywhere else" with every country no other region lists', () => {
    const [nl, eu, world] = resolveRegions(regionsFromSettings(settings))
    expect(nl?.countries).toEqual(['NL'])
    // XX is not a country Stripe ships to.
    expect(eu?.countries).toEqual(['DE', 'FR'])
    expect(world?.countries).toHaveLength(STRIPE_SHIPPING_COUNTRIES.length - 3)
    expect(world?.countries).not.toContain('NL')
    expect(world?.countries).toContain('US')
  })

  it('gives the cart the regions without their country lists', () => {
    expect(regionOptions(settings)).toEqual([
      {id: 'nl', title: 'Netherlands', rate: 5},
      {id: 'eu', title: 'European Union', rate: 12},
      {id: 'world', title: 'Rest of the world', rate: 18},
    ])
  })

  it('knows the EU’s countries, all of which Stripe ships to', () => {
    expect(EU_COUNTRIES).toHaveLength(27)
    const supported = new Set<string>(STRIPE_SHIPPING_COUNTRIES)
    expect(EU_COUNTRIES.filter((country) => !supported.has(country))).toEqual([])
  })
})

describe('queries', () => {
  it('reads products where the site keeps them', () => {
    expect(cartProductsQuery()).toBe(
      `*[_type in ["product"] && defined(commerce)]{${cartProductProjection()}}`,
    )
    const options = {
      types: ['book', 'print'],
      field: 'shop',
      title: 'name',
      image: 'cover.asset->url',
    }
    expect(checkoutProductsQuery(options)).toBe(
      `*[_type in ["book", "print"] && _id in $ids]{_id, "title": name, "slug": slug.current, "imageUrl": cover.asset->url, "commerce": shop{availability, price, taxClass, stockCount, variants[]{_key, label, availability, stockCount}}}`,
    )
    expect(stockQuery(options)).toContain('"commerce": shop{stockCount')
  })

  it('refuses names that would change the query', () => {
    expect(() => cartProductsQuery({types: ['product"] || true || _type in ["x']})).toThrow()
    expect(() => stockQuery({field: 'commerce.price'})).toThrow()
  })

  it('reads the one shop settings document', () => {
    expect(SHOP_SETTINGS_QUERY).toContain('_type == "stripeShopSettings" && _id == "shopSettings"')
  })
})

describe('readers', () => {
  it('drops what isn’t a product document', () => {
    expect(readCartProducts([magazine, null, {title: 'No id'}])).toEqual([magazine])
    expect(readCartProducts(undefined)).toEqual([])
  })

  it('keeps stock records out of reach without a token', () => {
    expect(stockRecordId('cs_test_a1B2')).toBe('stripe.stock.cs_test_a1B2')
    expect(stockRecordId('cs/../x')).toBe('stripe.stock.cs----x')
  })
})
