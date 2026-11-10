import {describe, expect, it} from 'vitest'

import {EU_COUNTRIES} from '../core/countries'
import {COMMERCE_TYPE, SHOP_SETTINGS_TYPE} from '../core/ids'
import {moneyTitle, resolveConfig} from './config'
import {createCommerceType} from './schema/commerce'
import {createShopSettingsType, initialRegions} from './schema/settings'

const fieldNames = (type: {fields: ReadonlyArray<{name: string}>}) =>
  type.fields.map((field) => field.name)
const field = <T extends {name: string}>(type: {fields: readonly T[]}, name: string) =>
  type.fields.find((candidate) => candidate.name === name)

describe('resolveConfig', () => {
  it('needs a currency, and has no country’s defaults', () => {
    expect(resolveConfig({currency: 'EUR'})).toEqual({
      currency: 'eur',
      currencyLabel: 'EUR',
      priceDecimals: 2,
      tax: {label: 'tax', included: true, classes: []},
      shop: {orderEmail: undefined, shippingRegions: []},
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
    expect(fieldNames(plain)).toEqual(['availability', 'price', 'stockCount', 'variants'])

    const classes = [
      {title: 'Printed matter (9%)', value: 'reduced'},
      {title: 'Standard (21%)', value: 'standard'},
    ]
    const taxed = createCommerceType(resolveConfig({currency: 'eur', tax: {label: 'VAT', classes}}))
    expect(fieldNames(taxed)).toEqual([
      'availability',
      'price',
      'taxClass',
      'stockCount',
      'variants',
    ])
    expect(field(taxed, 'taxClass')).toMatchObject({
      title: 'VAT',
      initialValue: 'reduced',
      options: {list: classes},
    })
    expect(field(taxed, 'price')).toMatchObject({title: 'Price (EUR, including VAT)'})
  })
})

describe('the shop settings', () => {
  const config = resolveConfig({
    currency: 'eur',
    shop: {
      orderEmail: 'orders@example.com',
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

  it('start with the regions and email from the plugin’s options', () => {
    const settings = createShopSettingsType(config)
    expect(settings.name).toBe(SHOP_SETTINGS_TYPE)
    expect(field(settings, 'orderEmail')).toMatchObject({initialValue: 'orders@example.com'})
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
    expect(field(settings, 'orderEmail')).not.toHaveProperty('initialValue')
  })
})
