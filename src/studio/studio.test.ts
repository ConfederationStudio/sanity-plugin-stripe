import {describe, expect, it} from 'vitest'

import {fakeDataset} from '../__fixtures__/sanity'
import {EU_COUNTRIES} from '../core/countries'
import {COMMERCE_TYPE, SHOP_SETTINGS_TYPE, stockId} from '../core/ids'
import {moneyTitle, resolveConfig} from './config'
import {settingsActions, withoutSettingsTemplate} from './plugin'
import {createCommerceType, createVariantType} from './schema/commerce'
import {createShippingRegionType, createShopSettingsType, initialRegions} from './schema/settings'
import {loadStock, parseCount, saveStock} from './stock'

const fieldNames = (type: {fields: ReadonlyArray<{name: string}>}) =>
  type.fields.map((field) => field.name)
const field = <T extends {name: string}>(type: {fields: readonly T[]}, name: string) =>
  type.fields.find((candidate) => candidate.name === name)

const VAT = [
  {title: 'Printed matter (9%)', value: 'reduced'},
  {title: 'Standard (21%)', value: 'standard'},
]

describe('resolveConfig', () => {
  it('needs a currency, and has no country’s defaults', () => {
    expect(resolveConfig({currency: 'EUR'})).toEqual({
      currency: 'eur',
      currencyLabel: 'EUR',
      priceDecimals: 2,
      tax: {label: 'tax', included: true, classes: []},
      shop: {shippingRegions: []},
    })
    expect(() => resolveConfig({currency: 'euro'})).toThrow('three-letter code')
    // @ts-expect-error A Studio configured from JavaScript can leave it out.
    expect(() => resolveConfig()).toThrow('three-letter code')
  })

  it('labels prices with the shop’s word for tax', () => {
    const vat = resolveConfig({currency: 'eur', tax: {label: 'VAT'}})
    expect(moneyTitle('Price', vat)).toBe('Price (EUR, including VAT)')
    const usd = resolveConfig({currency: 'usd', tax: {included: false}})
    expect(moneyTitle('Shipping', usd)).toBe('Shipping (USD)')
  })
})

describe('the price-and-stock field', () => {
  it('has a tax class only when the shop has tax classes', () => {
    const plain = createCommerceType(resolveConfig({currency: 'eur'}))
    expect(plain.name).toBe(COMMERCE_TYPE)
    expect(fieldNames(plain)).toEqual(['availability', 'price', 'variants'])

    const taxed = createCommerceType(
      resolveConfig({currency: 'eur', tax: {label: 'VAT', classes: VAT}}),
    )
    expect(fieldNames(taxed)).toEqual(['availability', 'price', 'taxClass', 'variants'])
    expect(field(taxed, 'taxClass')).toMatchObject({
      title: 'VAT',
      initialValue: 'reduced',
      options: {list: VAT},
    })
    expect(field(taxed, 'price')).toMatchObject({title: 'Price (EUR, including VAT)'})
  })

  it('draws the stock boxes with its own input', () => {
    const commerce = createCommerceType(resolveConfig({currency: 'eur'}))
    expect(commerce.components?.input).toBeTypeOf('function')
  })
})

describe('what the plugin puts in public documents', () => {
  const config = resolveConfig({currency: 'eur', tax: {label: 'VAT', classes: VAT}})
  const types = [
    createCommerceType(config),
    createVariantType(),
    createShippingRegionType(config),
    createShopSettingsType(config),
  ]

  it('holds no stock count, no email address and no key', () => {
    const names = types.flatMap((type) => fieldNames(type))
    expect(names.toSorted()).toEqual([
      'autoSoldOut',
      'availability',
      'availability',
      'countries',
      'everywhereElse',
      'label',
      'price',
      'rate',
      'shippingRegions',
      'taxClass',
      'title',
      'variants',
    ])
  })
})

describe('the shop settings', () => {
  const config = resolveConfig({
    currency: 'eur',
    shop: {
      shippingRegions: [
        {title: 'Netherlands', countries: ['NL'], rate: 5},
        {
          title: 'European Union',
          countries: EU_COUNTRIES.filter((code) => code !== 'NL'),
          rate: 12,
        },
        {title: 'Rest of the world', everywhereElse: true, rate: 18},
      ],
    },
  })

  it('start with the regions from the plugin’s options', () => {
    const settings = createShopSettingsType(config)
    expect(settings.name).toBe(SHOP_SETTINGS_TYPE)
    expect(field(settings, 'shippingRegions')).toMatchObject({
      initialValue: initialRegions(config),
    })
    expect(initialRegions(config)).toMatchObject([
      {_key: 'region-1', _type: 'stripeShippingRegion', title: 'Netherlands', countries: ['NL']},
      {_key: 'region-2', title: 'European Union', rate: 12},
      {_key: 'region-3', title: 'Rest of the world', everywhereElse: true, rate: 18},
    ])
    expect(initialRegions(config)[1]?.countries).toHaveLength(26)
    expect(initialRegions(config)[2]).not.toHaveProperty('countries')
  })

  it('start empty when the options name no regions', () => {
    const settings = createShopSettingsType(resolveConfig({currency: 'usd'}))
    expect(field(settings, 'shippingRegions')).not.toHaveProperty('initialValue')
  })

  it('stay one document: no "new", no duplicate, no delete', () => {
    const templates = [{templateId: SHOP_SETTINGS_TYPE}, {templateId: 'product'}]
    expect(withoutSettingsTemplate(templates)).toEqual([{templateId: 'product'}])

    const actions = ['publish', 'duplicate', 'delete', 'discardChanges', 'restore', undefined].map(
      (action) => (action ? {action} : {}),
    )
    expect(settingsActions(actions, SHOP_SETTINGS_TYPE)).toEqual([
      {action: 'publish'},
      {action: 'discardChanges'},
      {action: 'restore'},
    ])
    expect(settingsActions(actions, 'product')).toEqual(actions)
  })
})

describe('stock boxes', () => {
  it('take a whole number from 0 up, or nothing', () => {
    expect(parseCount('')).toBeNull()
    expect(parseCount('  ')).toBeNull()
    expect(parseCount('0')).toBe(0)
    expect(parseCount(' 12 ')).toBe(12)
    expect(parseCount('-1')).toBe('invalid')
    expect(parseCount('1.5')).toBe('invalid')
    expect(parseCount('ten')).toBe('invalid')
  })

  it('read a product’s counts, or none before there are any', async () => {
    const {writer} = fakeDataset()
    expect(await loadStock(writer, 'magazine')).toEqual({stockCount: 3, variants: []})
    expect(await loadStock(writer, 'poster')).toEqual({stockCount: null, variants: []})
  })

  it('can’t be read without a token', async () => {
    const {reader, writer} = fakeDataset()
    const tokenless = {
      fetch: (query: string, params?: Record<string, unknown>) => reader.fetch(query, params),
      transaction: () => writer.transaction(),
    }
    expect(await loadStock(tokenless, 'magazine')).toEqual({stockCount: null, variants: []})
  })

  it('write to the private stock document, never to the product', async () => {
    const dataset = fakeDataset()
    const {writer} = dataset
    const product = structuredClone(dataset.get('poster'))

    await saveStock(writer, 'poster', await loadStock(writer, 'poster'), {count: 20})
    expect(dataset.get(stockId('poster'))).toEqual({
      _id: 'stripe.stock.poster',
      _type: 'stripe.stock',
      stockCount: 20,
    })
    expect(dataset.get('poster')).toEqual(product)

    await saveStock(writer, 'poster', await loadStock(writer, 'poster'), {count: null})
    expect(await loadStock(writer, 'poster')).toEqual({stockCount: null, variants: []})
  })

  it('set one variant’s count and leave the others as they are', async () => {
    const dataset = fakeDataset()
    const {writer} = dataset
    const save = async (variantKey: string, count: number | null) =>
      saveStock(writer, 'shirt', await loadStock(writer, 'shirt'), {variantKey, count})

    await save('l', 4)
    await save('m', 7)
    expect(await loadStock(writer, 'shirt')).toEqual({
      stockCount: null,
      variants: [
        {_key: 'm', stockCount: 7},
        {_key: 'l', stockCount: 4},
      ],
    })

    await save('m', null)
    await save('xl', null)
    expect((await loadStock(writer, 'shirt')).variants).toEqual([{_key: 'l', stockCount: 4}])
    await expect(save('m"] || true || [x=="', 1)).rejects.toThrow('not a variant key')
  })

  it('keep an order’s change when an editor saves another count at the same moment', async () => {
    const dataset = fakeDataset()
    const {writer} = dataset
    const seen = await loadStock(writer, 'shirt')
    // An order lowers M after the editor's form read the counts.
    await writer
      .transaction()
      .patch(stockId('shirt'), {dec: {'variants[_key=="m"].stockCount': 1}})
      .commit()
    await saveStock(writer, 'shirt', seen, {variantKey: 'l', count: 4})
    expect(dataset.value(stockId('shirt'), 'variants[_key=="m"].stockCount')).toBe(0)
  })
})
