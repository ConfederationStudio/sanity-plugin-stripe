import {describe, expect, it} from 'vitest'

import {
  cartRows,
  cartSubtotal,
  describeInterval,
  lineKey,
  lineStatus,
  readCartProducts,
  readSubscription,
  sanitizeLines,
  type CartProduct,
} from './cart'
import {EU_COUNTRIES, STRIPE_SHIPPING_COUNTRIES} from './countries'
import {publishedId, SHOP_SETTINGS_ID, stockChangeId, stockId} from './ids'
import {formatMoney, priceDecimals, toMinorUnits} from './money'
import {
  cartProductProjection,
  cartProductsQuery,
  checkoutProductsQuery,
  COMMERCE_PROJECTION,
  productVersionsQuery,
  SHOP_SETTINGS_QUERY,
} from './queries'
import {
  readShopSettings,
  regionOptions,
  regionsFromSettings,
  resolveRegions,
  shippingQuote,
} from './regions'
import {readStockDocuments, STOCK_QUERY, stockLeft} from './stock'

const magazine: CartProduct = {
  _id: 'magazine',
  title: 'Issue 16',
  commerce: {availability: 'onSale', price: 25},
}
const shirt: CartProduct = {
  _id: 'shirt',
  title: 'Shirt',
  commerce: {
    availability: 'onSale',
    price: 29.5,
    variants: [
      {_key: 'm', label: 'M'},
      {_key: 'l', label: 'L', availability: 'soldOut'},
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

  it('takes published products only: no draft, no copy in a release, nothing private', () => {
    expect(
      sanitizeLines([
        {productId: 'drafts.magazine', quantity: 1},
        {productId: 'versions.rSummer.magazine', quantity: 1},
        {productId: 'stripe.stock.magazine', quantity: 1},
        {productId: 'magazine', quantity: 1},
      ]),
    ).toEqual([{productId: 'magazine', quantity: 1}])
  })
})

describe('lineStatus', () => {
  it('goes by the on-sale switch, up to the most one order can hold', () => {
    expect(lineStatus(magazine)).toEqual({
      available: true,
      maxQuantity: 10,
      price: 25,
      variant: undefined,
    })
    const gone = {...magazine, commerce: {...magazine.commerce, availability: 'soldOut' as const}}
    expect(lineStatus(gone)).toEqual({available: false, reason: 'soldOut'})
  })

  it('asks for a variant when the product has them', () => {
    expect(lineStatus(shirt)).toEqual({available: false, reason: 'chooseVariant'})
    expect(lineStatus(shirt, 'l')).toEqual({available: false, reason: 'soldOut'})
    expect(lineStatus(shirt, 'xs')).toEqual({available: false, reason: 'variantMissing'})
    expect(lineStatus(shirt, 'm')).toMatchObject({available: true, maxQuantity: 10, price: 29.5})
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
  it('names and totals each line', () => {
    const rows = cartRows(
      [
        {productId: 'magazine', quantity: 3},
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
    autoSoldOut: false,
  })

  it('reads the settings and leaves out regions that aren’t filled in', () => {
    expect(readShopSettings(null)).toBeNull()
    expect(settings?.autoSoldOut).toBe(false)
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
      `*[_type in ["book", "print"] && _id in $ids]{_id, "title": name, "slug": slug.current, "imageUrl": cover.asset->url, "commerce": shop{availability, price, taxClass, variants[]{_key, label, availability}, subscription{enabled, price, every, unit}}}`,
    )
  })

  it('asks for every version of the products it marks sold out', () => {
    expect(productVersionsQuery(['magazine', 'shirt'], {field: 'shop'})).toEqual({
      query: `*[_type in ["product"] && defined(shop) && (sanity::versionOf($product0) || sanity::versionOf($product1))]{_id, "variants": shop.variants[]._key}`,
      params: {product0: 'magazine', product1: 'shirt'},
    })
  })

  it('refuses names that would change the query', () => {
    expect(() => cartProductsQuery({types: ['product"] || true || _type in ["x']})).toThrow()
    expect(() => checkoutProductsQuery({field: 'commerce.price'})).toThrow()
  })

  it('never asks the public documents for a stock count or an email address', () => {
    const publicQueries = [
      COMMERCE_PROJECTION,
      cartProductProjection(),
      cartProductsQuery(),
      checkoutProductsQuery(),
      SHOP_SETTINGS_QUERY,
    ]
    for (const query of publicQueries) {
      expect(query).not.toMatch(/stockCount/i)
      expect(query).not.toMatch(/email/i)
    }
  })
})

describe('ids', () => {
  it('keeps the shop settings readable without a token', () => {
    expect(SHOP_SETTINGS_ID).toBe('stripeShopSettings')
    expect(SHOP_SETTINGS_ID).not.toContain('.')
    expect(SHOP_SETTINGS_QUERY).toContain(
      '_type == "stripeShopSettings" && _id == "stripeShopSettings"',
    )
  })

  it('keeps stock and its records out of reach without a token', () => {
    expect(stockId('magazine')).toBe('stripe.stock.magazine')
    expect(stockChangeId('cs_test_a1B2')).toBe('stripe.stockChange.cs_test_a1B2')
    expect(stockChangeId('cs/../x')).toBe('stripe.stockChange.cs----x')
  })

  it('finds the product a form is editing, whichever version it has open', () => {
    expect(publishedId('magazine')).toBe('magazine')
    expect(publishedId('drafts.magazine')).toBe('magazine')
    expect(publishedId('versions.rSummer.magazine')).toBe('magazine')
  })
})

describe('stock', () => {
  const stock = readStockDocuments([
    {_id: 'stripe.stock.magazine', stockCount: 3},
    {_id: 'stripe.stock.shirt', variants: [{_key: 'm', stockCount: 1}, {_key: 'l'}, 'junk']},
    {_id: 'magazine', stockCount: 99},
    null,
  ])

  it('reads stock documents by product, and nothing else', () => {
    expect([...stock.keys()]).toEqual(['magazine', 'shirt'])
    expect(STOCK_QUERY).toContain('_type == "stripe.stock" && _id in $ids')
  })

  it('says how many are left, or null when it isn’t counted', () => {
    expect(stockLeft(stock.get('magazine'))).toBe(3)
    expect(stockLeft(stock.get('shirt'), 'm')).toBe(1)
    expect(stockLeft(stock.get('shirt'), 'l')).toBeNull()
    expect(stockLeft(stock.get('shirt'))).toBeNull()
    expect(stockLeft(stock.get('poster'))).toBeNull()
    expect(stockLeft(undefined, 'm')).toBeNull()
  })
})

describe('readers', () => {
  it('drops what isn’t a product document', () => {
    expect(readCartProducts([magazine, null, {title: 'No id'}])).toEqual([magazine])
    expect(readCartProducts(undefined)).toEqual([])
  })
})

describe('subscriptions in the cart', () => {
  const serum: CartProduct = {
    _id: 'serum',
    title: 'Serum',
    commerce: {
      availability: 'onSale',
      price: 21.99,
      subscription: {enabled: true, price: 19.79, every: 6, unit: 'week'},
    },
  }

  it('reads a subscription only when it is switched on and filled in', () => {
    expect(readSubscription(serum.commerce?.subscription)).toEqual({
      price: 19.79,
      interval: {unit: 'week', every: 6},
    })
    const broken = [
      undefined,
      null,
      {enabled: false, price: 19.79, every: 6, unit: 'week'},
      {enabled: true, every: 6, unit: 'week'},
      {enabled: true, price: 19.79, every: 0, unit: 'week'},
      {enabled: true, price: 19.79, every: 1.5, unit: 'week'},
      {enabled: true, price: 19.79, every: 6, unit: 'day'},
      // Stripe charges at least once every three years.
      {enabled: true, price: 19.79, every: 157, unit: 'week'},
      {enabled: true, price: 19.79, every: 37, unit: 'month'},
    ]
    for (const subscription of broken) expect(readSubscription(subscription)).toBeNull()
  })

  it('says how often in plain words', () => {
    expect(describeInterval({unit: 'week', every: 6})).toBe('every 6 weeks')
    expect(describeInterval({unit: 'month', every: 1})).toBe('every month')
  })

  it('keeps a product bought once and subscribed to on two lines', () => {
    const once = {productId: 'serum', quantity: 1}
    const subscribed = {productId: 'serum', plan: 'subscribe', quantity: 1}
    expect(lineKey(once)).toBe('serum:')
    expect(lineKey({productId: 'serum', plan: 'subscribe'})).toBe('serum::subscribe')
    expect(sanitizeLines([once, subscribed, subscribed, {...once, plan: 'gift'}])).toEqual([
      {productId: 'serum', quantity: 2},
      {productId: 'serum', plan: 'subscribe', quantity: 2},
    ])
  })

  it('prices a subscribed line per delivery, and says how often', () => {
    expect(lineStatus(serum)).toMatchObject({available: true, price: 21.99})
    expect(lineStatus(serum)).not.toHaveProperty('interval')
    expect(lineStatus(serum, undefined, 10, 'subscribe')).toMatchObject({
      available: true,
      price: 19.79,
      interval: {unit: 'week', every: 6},
    })
    expect(lineStatus(magazine, undefined, 10, 'subscribe')).toEqual({
      available: false,
      reason: 'noSubscription',
    })
    const rows = cartRows(
      [
        {productId: 'serum', quantity: 1},
        {productId: 'serum', plan: 'subscribe', quantity: 2},
      ],
      [serum],
    )
    expect(rows.map((row) => row.total)).toEqual([21.99, 39.58])
    expect(cartSubtotal(rows)).toBeCloseTo(61.57)
  })

  it('reads the subscription with the product, and no stock with it', () => {
    expect(COMMERCE_PROJECTION).toContain('subscription{enabled, price, every, unit}')
    expect(COMMERCE_PROJECTION).not.toContain('stockCount')
  })
})

describe('free delivery from an amount', () => {
  const settings = readShopSettings({
    shippingRegions: [
      {_key: 'uk', title: 'United Kingdom', countries: ['GB'], rate: 3.95, freeFrom: 25},
      {_key: 'ie', title: 'Ireland', countries: ['IE'], rate: 6, freeFrom: 0},
      {_key: 'world', title: 'Rest of the world', everywhereElse: true, rate: 18},
    ],
    subscriptionDelivery: 'rate',
  })

  it('reads the amount with the region, and the rule for subscriptions with the settings', () => {
    expect(SHOP_SETTINGS_QUERY).toContain('freeFrom')
    expect(SHOP_SETTINGS_QUERY).toContain('subscriptionDelivery')
    expect(settings?.subscriptionDelivery).toBe('rate')
    expect(readShopSettings({subscriptionDelivery: 'sometimes'})?.subscriptionDelivery).toBeNull()
    expect(regionOptions(settings)).toEqual([
      {id: 'uk', title: 'United Kingdom', rate: 3.95, freeFrom: 25},
      // An amount of 0 is no amount: a region that is always free has a rate of 0.
      {id: 'ie', title: 'Ireland', rate: 6},
      {id: 'world', title: 'Rest of the world', rate: 18},
    ])
  })

  it('tells the cart what delivery costs and how much more makes it free', () => {
    const [uk, , world] = regionOptions(settings)
    if (!uk || !world) throw new Error('The regions are missing')
    expect(shippingQuote(uk, 21.99)).toEqual({amount: 3.95, missing: 3.01})
    expect(shippingQuote(uk, 25)).toEqual({amount: 0, missing: 0})
    // 19.99 + 5.01 is a hair over or under 25 in floating point: it still counts.
    expect(shippingQuote(uk, 19.99 + 5.01)).toEqual({amount: 0, missing: 0})
    expect(shippingQuote(uk, 43.98)).toEqual({amount: 0, missing: 0})
    expect(shippingQuote(world, 500)).toEqual({amount: 18, missing: null})
  })
})
