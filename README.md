# sanity-plugin-stripe

Sell from a Sanity site with Stripe Checkout, without a shop platform in between. Editors set price, stock and variants on their own documents in the Studio; the site keeps a cart in the browser and sends buyers to Stripe's payment page; a webhook lowers stock and hands the paid order to your code. Made by Eurico Sá Fernandes at [Confederation Studio](https://github.com/ConfederationStudio). It isn't affiliated with or endorsed by Stripe or Sanity.

> **Status:** not released yet. The test site has taken payments in a Stripe sandbox, from the cart to Stripe's page and back through the webhook: stock went down once, a resent event changed nothing, and a declined card fulfilled nothing. That run used the test site's sample products, so reading from and writing to a real Sanity dataset is still to be tried, as are delayed payment methods. Treat everything below as a draft until 0.1.0. It targets Sanity Studio 6, React 19.2 and stripe-node 23.

- **In the Studio.** A `stripeCommerce` field for any document type: on sale or sold out, price, tax class, an optional stock count, and variants that each sell out on their own. A Shop settings document holds the shipping regions with one flat rate each, the address orders go to, and whether stock sells out by itself at 0.
- **In the browser.** A cart in localStorage that holds product references and quantities, never prices, with hooks for the buy button and the checkout. The markup is yours.
- **On the server.** A checkout route that reads prices, stock and shipping fresh from Sanity and creates the Checkout Session, and a webhook route that lowers stock and calls your `onOrder`, each once per payment however often Stripe delivers the event.
- **Customer data stays in Stripe.** Names, addresses and orders are never written to Sanity, where a public dataset would show them to anyone.

## How it fits together

```
Studio ── products, prices, stock, shop settings ──▶ Sanity
                                                       ▲   │ read fresh at checkout
browser cart ──(product ids, quantities, region)──▶ your site's /api/checkout ──▶ Stripe Checkout
                                                       │                              │ buyer pays
your onOrder (send the email) ◀── your site's /api/stripe/webhook ◀──(signed event)───┘
                                       └─ lowers stock in Sanity, once per payment
```

## Install

```bash
npm i sanity-plugin-stripe stripe
```

The Studio and the site install the same package. The site imports `sanity-plugin-stripe/react` and `sanity-plugin-stripe/server`, which never import Sanity; the Studio's entry never imports Stripe.

## Quick start

### 1. The Studio

```ts
// sanity.config.ts
import {defineConfig} from 'sanity'
import {EU_COUNTRIES, shopSettingsListItem, stripeCommerce} from 'sanity-plugin-stripe'
import {structureTool} from 'sanity/structure'

export default defineConfig({
  // …
  plugins: [
    structureTool({
      structure: (S) =>
        S.list()
          .title('Content')
          .items([S.documentTypeListItem('product'), shopSettingsListItem(S)]),
    }),
    stripeCommerce({
      currency: 'eur',
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
          {title: 'European Union', countries: EU_COUNTRIES.filter((c) => c !== 'NL'), rate: 12},
          {title: 'Rest of the world', everywhereElse: true, rate: 18},
        ],
      },
    }),
  ],
})
```

Give the documents you sell the field:

```ts
defineField({name: 'commerce', title: 'Price and stock', type: 'stripeCommerce'})
```

There is one Shop settings document. `shopSettingsListItem(S)` opens it from the structure, and the plugin keeps it out of the "new document" menu and takes away duplicate and delete. Open it and publish it: the checkout answers 503 until it has at least one shipping region.

### 2. The routes

```ts
// lib/shop.ts
import {createClient} from '@sanity/client'
import {createStripe} from 'sanity-plugin-stripe/server'

// Fresh reads: the checkout must see today's price and stock, not a cached one.
export const client = createClient({projectId, dataset, apiVersion: '2025-02-19', useCdn: false})
export const writeClient = process.env.SANITY_API_WRITE_TOKEN
  ? client.withConfig({token: process.env.SANITY_API_WRITE_TOKEN})
  : null
export const stripe = process.env.STRIPE_SECRET_KEY
  ? createStripe(process.env.STRIPE_SECRET_KEY)
  : null
```

```ts
// app/api/checkout/route.ts
import {checkoutRoute} from 'sanity-plugin-stripe/server'

export const POST = checkoutRoute({
  stripe,
  client,
  currency: 'eur',
  successUrl: '/shop/thanks?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: '/cart',
  integrationIdentifier: 'myshop_qhzvmkpt',
})
```

```ts
// app/api/stripe/webhook/route.ts
import {orderEmail, webhookRoute} from 'sanity-plugin-stripe/server'

export const POST = webhookRoute({
  stripe,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  client,
  writeClient,
  async onOrder(order, {settings, stock}) {
    const email = orderEmail(order, {shopName: 'My shop', stock})
    await sendEmail({to: settings?.orderEmail, replyTo: order.customer.email, ...email})
  },
})
```

Both take a web `Request` and return a `Response`, so the same handlers fit Remix, Astro, SvelteKit or Hono. `createStripe` pins the Stripe API version the plugin is tested against. The plugin never reads the environment itself: you pass the values in.

The webhook is not optional. It is the only place an order is fulfilled, because a buyer who pays and closes the tab never reaches the thank-you page.

### 3. Stripe

Use a [sandbox](https://docs.stripe.com/sandboxes) while building, and a restricted key (`rk_…`) rather than a secret key. The key needs Checkout Sessions: Write and Payment Intents: Write. Reading back which products were bought may also need Products: Read; the smallest set that works is still to be confirmed before 0.1.0.

Locally, forward events to the site and copy the `whsec_…` secret it prints into `STRIPE_WEBHOOK_SECRET`:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed
```

In production, add a webhook endpoint for `https://<your domain>/api/stripe/webhook` in the Stripe Dashboard with the same three events (`WEBHOOK_EVENTS` lists them).

Payment methods are chosen in the Stripe Dashboard, not in code: the plugin never sends `payment_method_types`.

### 4. The cart

Wrap the site in the provider, once:

```tsx
import {CartProvider} from 'sanity-plugin-stripe/react'

;<CartProvider storageKey="myshop-cart">{children}</CartProvider>
```

Read products with the plugin's projection, so the cart and the checkout get what they need:

```ts
import {cartProductProjection} from 'sanity-plugin-stripe/server'

const query = `*[_type == "product" && slug.current == $slug][0]{${cartProductProjection()}, description}`
```

The buy button, in your markup:

```tsx
'use client'
import {useBuyBox} from 'sanity-plugin-stripe/react'

export function BuyBox({product}) {
  const box = useBuyBox(product)
  if (box.soldOut) return <p>Sold out</p>
  return (
    <>
      {box.variants.map((variant) => (
        <label key={variant._key}>
          <input
            type="radio"
            checked={box.variantKey === variant._key}
            disabled={!variant.available}
            onChange={() => box.chooseVariant(variant._key)}
          />
          {variant.label}
        </label>
      ))}
      <button disabled={!box.status.available || box.full} onClick={() => box.add()}>
        Add to cart
      </button>
    </>
  )
}
```

The cart page reads every product and the shop settings on the server (`cartProductsQuery()`, `SHOP_SETTINGS_QUERY`, `regionOptions(settings)`), and a client component draws it with `useCart()`, `cartRows(lines, products)`, `cartSubtotal(rows)` and `useCheckout()`, whose `start(regionId)` posts the cart to the checkout route and goes to Stripe. On the page Stripe returns to, `<ClearCartOnReturn />` empties the cart.

`dev/site` in this repository is a complete, small example of all of it.

## Data structure

The field saves this on your document:

```json
{
  "_type": "stripeCommerce",
  "availability": "onSale",
  "price": 29.5,
  "taxClass": "standard",
  "variants": [
    {"_key": "a1", "_type": "stripeVariant", "label": "M", "stockCount": 2},
    {"_key": "b2", "_type": "stripeVariant", "label": "L", "availability": "soldOut"}
  ]
}
```

Prices are in currency units, as editors type them (29.5 is €29.50), and are converted to Stripe's minor units at checkout, zero-decimal currencies included. A product without variants has its own `stockCount`. A stock count of 0 counts as sold out whatever the switch says; no stock count means unlimited.

The shop settings are a `stripeShopSettings` document with the id `shopSettings`, readable without a token like the rest of a public dataset.

When a paid order lowers stock, the webhook writes one `stripe.stockRecord` document per Checkout Session, with the product ids and the counts before and after. That record is what stops a second delivery of the same event from lowering stock again. Its id has a dot, so Sanity only serves it with a token, and it holds nothing about the buyer.

## Options

### `stripeCommerce()` in the Studio

| Option                 |                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `currency`             | ISO 4217 code every price is in, such as `eur`. Required.                               |
| `tax.label`            | What tax is called where the shop is: `VAT`, `GST`, `sales tax`. Default `tax`.         |
| `tax.included`         | Whether entered prices include tax. It only changes the labels. Default true.           |
| `tax.classes`          | `{title, value}` choices for a product's tax class. Without any, the field is left out. |
| `shop.orderEmail`      | Starting value for the order email.                                                     |
| `shop.shippingRegions` | Starting regions: `{title, countries, rate}` or `{title, everywhereElse: true, rate}`.  |

### `checkoutRoute()`

| Option                  |                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `stripe`                | From `createStripe`. Without one the route answers 503. Required.                               |
| `client`                | A Sanity client that skips the CDN. Required.                                                   |
| `currency`              | The same code the Studio plugin has. Required.                                                  |
| `successUrl`            | A path or address, with `{CHECKOUT_SESSION_ID}` in it. Required.                                |
| `cancelUrl`             | Where Stripe's back link goes. Required.                                                        |
| `products`              | Where products live: `{types, field, title, slug, image}`. Default `product` with `commerce`.   |
| `integrationIdentifier` | Tags the shop's sessions in the Stripe Dashboard. End it with 8 random letters.                 |
| `taxRates`              | Stripe tax rate ids (`txr_…`) by tax class, so receipts show the tax.                           |
| `maxQuantity`           | Most of one item per order. Default 10.                                                         |
| `expiresInMinutes`      | Minutes until an unpaid session expires, 30 at least. Stripe's default is 24 hours.             |
| `extend`                | Changes the session's parameters before it is created: promotion codes, phone numbers, consent. |
| `messages`              | What buyers read when the checkout can't start.                                                 |
| `debug`                 | Adds the reason to error replies. For development.                                              |

### `webhookRoute()`

| Option            |                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `stripe`          | From `createStripe`. Required.                                                           |
| `webhookSecret`   | The endpoint's signing secret (`whsec_…`). Required.                                     |
| `client`          | A Sanity client that skips the CDN. Required.                                            |
| `writeClient`     | A client with a token that can write. Without it, stock is left alone.                   |
| `products`        | The same as the checkout route's.                                                        |
| `onOrder`         | Called once per paid order with the order, the shop settings and what happened to stock. |
| `onPaymentFailed` | Called when a delayed payment fails.                                                     |

## What it doesn't do

- **Tax compliance.** Prices are what editors enter. A tax class can attach a Stripe tax rate you created, so the receipt shows the tax, and that is all. It does not use Stripe Tax and does not work out the VAT of the buyer's country for cross-border sales. Ask your accountant what your shop needs.
- **Hold stock during checkout.** Stock is checked when Checkout starts and lowered when the payment lands. Two buyers can both pay for the last copy; the order email then says so. `expiresInMinutes` narrows the window.
- **Show orders in the Studio.** Orders are in the Stripe Dashboard and in the email your `onOrder` sends.
- **Send email.** `orderEmail()` writes the order email; sending it is your `onOrder`, with your email service.
- **Subscriptions, discount logic, shipping by weight.** One-off payments with a flat rate per region. `extend` can switch on Stripe's promotion codes.

## Security

- The browser sends product ids, quantities and a region id. Prices, names and shipping rates are read from Sanity on the server, and anything else in the request is dropped.
- Every webhook delivery's signature is checked against the raw body before it is parsed. The route then reads the session again from Stripe's API and goes by that copy's payment status.
- Keys come from your environment and are passed in. Use a restricted key, and a separate one for each environment.
- Names inside the plugin's GROQ (document types, the field name) are checked when the routes are made. Ids travel as query parameters.
- The order email escapes everything a buyer typed.

## Developing

```bash
pnpm install
pnpm build
pnpm check
```

`pnpm check` typechecks, lints and runs the tests. The tests use the real stripe-node client with its network replaced, so requests are built and webhook signatures are checked by the SDK itself. One test fails if `/react` or `/server` reaches Sanity, or the Studio's entry reaches Stripe. Build first: the lint reads `dev/site`, which imports the built package.

### The test site

`dev/site` is a Next.js shop with the Studio inside it at `/studio`. Without a Sanity project it sells sample products kept in memory, answered with groq-js, so the cart, the checkout and the webhook can be tried with a Stripe key alone; stock goes back to the sample values when the server restarts. Copy `dev/site/.env.example` to `dev/site/.env.local` and fill it in, then:

```bash
pnpm watch                  # rebuilds dist as you edit
pnpm --dir dev/site dev
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Without a Stripe key the routes answer 503 and the rest of the site works.

## License

MIT © Confederation Studio
