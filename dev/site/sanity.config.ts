'use client'

/** The test Studio, inside the test site at /studio (app/studio/[[...tool]]/page.tsx). */

import {defineConfig} from 'sanity'
import {EU_COUNTRIES, shopSettingsListItem, stripeCommerce} from 'sanity-plugin-stripe'
import {structureTool} from 'sanity/structure'

import {CURRENCY, dataset, projectId} from './lib/env'
import {product} from './schema/product'

export default defineConfig({
  name: 'default',
  title: 'Stripe plugin test',
  basePath: '/studio',
  projectId,
  dataset,
  plugins: [
    structureTool({
      structure: (S) =>
        S.list()
          .title('Shop')
          .items([S.documentTypeListItem('product').title('Products'), shopSettingsListItem(S)]),
    }),
    stripeCommerce({
      currency: CURRENCY,
      // The Orders tab asks this site, which asks Stripe: app/api/shop/[...path]/route.ts.
      api: '/api/shop',
      tax: {
        label: 'VAT',
        classes: [
          {title: 'Printed matter (9%)', value: 'reduced'},
          {title: 'Standard (21%)', value: 'standard'},
        ],
      },
      shop: {
        shippingRegions: [
          {title: 'Netherlands', countries: ['NL'], rate: 5},
          {
            title: 'European Union',
            countries: EU_COUNTRIES.filter((country) => country !== 'NL'),
            rate: 12,
          },
          {title: 'Rest of the world', everywhereElse: true, rate: 18},
        ],
      },
    }),
  ],
  schema: {types: [product]},
})
