# sanity-plugin-stripe

Sell from a Sanity site with Stripe Checkout, without a shop platform in between: once, or as a subscription. Editors set price, stock and variants on their own documents in the Studio; the site keeps a cart in the browser and sends buyers to Stripe's payment page; a webhook lowers stock and hands the paid order to your code. Made by Eurico Sá Fernandes at [Confederation Studio](https://github.com/ConfederationStudio). It isn't affiliated with or endorsed by Stripe or Sanity.

> **Status:** 0.2, tried in a Stripe sandbox against a real, public Sanity dataset, from the cart to Stripe's page and back through the webhook, and in the Studio: stock went down once, also when the same event was delivered twice at the same moment; a resent event changed nothing; a declined card fulfilled nothing; a payment made outside the shop was left alone; a query without a token could read no stock, no draft and nothing about an order; and the Studio's stock boxes followed a count lowered from outside the Studio, as an order lowers it. A subscription was bought in one cart with a one-off item, with its delivery charged as a repeating line. On a Stripe test clock its renewal lowered stock once and went to the address the customer had changed in between; the same event delivered again changed nothing; a renewal whose card was declined fulfilled nothing until it was paid; and cancelling reached the site. A promotion code took its 10% off the goods. The portal route arrived at Stripe's login page for the customer portal, and an address changed inside the portal landed where renewals read it. A bank debit was waited for: nothing was fulfilled until the money arrived, and nothing at all when it failed. With a Sanity token that may only read, the order still reached the shop, marked as not counted, and stock was lowered on a later delivery. Not tried yet: the portal's sign-in by email, and three-decimal currencies (Stripe only opens those to accounts with a bank account in the currency). Until 1.0, a minor version may change the API; the [changelog](https://github.com/ConfederationStudio/sanity-plugin-stripe/blob/main/CHANGELOG.md) says how. It targets Sanity Studio 6, React 19.2 and stripe-node 23.

- **In the Studio.** A `stripeCommerce` field for any document type: on sale or sold out, price, tax class, an optional subscription, variants that each sell out on their own, and optional stock counts. A Shop settings document holds the shipping regions with one flat rate each, free from an amount if you like, and whether stock sells out by itself at 0.
- **In the browser.** A cart in localStorage that holds product references and quantities, never prices, with hooks for the buy button and the checkout. The markup is yours.
- **On the server.** A checkout route that reads prices, stock and shipping fresh from Sanity and creates the Checkout Session, a webhook route that lowers stock and calls your `onOrder`, each once per payment however often Stripe delivers the event, and the same for each renewal of a [subscription](#subscriptions). A third route sends subscribers to Stripe's customer portal.
- **Made for a public dataset.** Most Sanity datasets can be read by anyone. Buyers, addresses and orders are never written to Sanity; stock counts are kept where only a token can read them; keys stay in your site's environment. See [On a public dataset](#on-a-public-dataset).

## How it fits together

```
Studio ── prices, on sale / sold out, shop settings ──▶ Sanity (public)
   └──── stock counts ────────────────────────────────▶ Sanity (private documents)
                                                           ▲   │ read fresh at checkout
browser cart ──(product ids, quantities, region)──▶ your site's /api/checkout ──▶ Stripe Checkout
                                                           │                           │ buyer pays
your onOrder (send the email) ◀── your site's /api/stripe/webhook ◀──(signed event)────┘
                                       └─ lowers stock, once per payment
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

Under the field's own inputs are the "In stock" boxes. A count is saved as you leave its box, outside the product document, and is never published with it.

There is one Shop settings document. `shopSettingsListItem(S)` opens it from the structure, and the plugin keeps it out of the "new document" menu and takes away duplicate and delete, so you don't list it among your own single documents. While it has no shipping regions it offers the ones from the plugin's options. Open it and publish it: the checkout answers 503 until it has at least one region.

### 2. The routes

```ts
// lib/shop.ts
import {createClient} from '@sanity/client'
import {createStripe} from 'sanity-plugin-stripe/server'

// No token: it sees what anyone sees, so a draft can never be priced or sold.
// No CDN: the checkout must read today's price, not a cached one.
export const client = createClient({projectId, dataset, apiVersion: '2025-02-19', useCdn: false})

// A token, for stock alone. Only ever on the server.
export const stockClient = process.env.SANITY_API_WRITE_TOKEN
  ? client.withConfig({token: process.env.SANITY_API_WRITE_TOKEN})
  : null

export const stripe = process.env.STRIPE_SECRET_KEY
  ? createStripe(process.env.STRIPE_SECRET_KEY)
  : null

// Marks this shop's Checkout Sessions. End it with 8 random letters.
export const integrationIdentifier = 'myshop_qhzvmkpt'
```

```ts
// app/api/checkout/route.ts
import {checkoutRoute} from 'sanity-plugin-stripe/server'

export const POST = checkoutRoute({
  stripe,
  client,
  stockClient,
  currency: 'eur',
  successUrl: '/shop/thanks?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: '/cart',
  integrationIdentifier,
})
```

```ts
// app/api/stripe/webhook/route.ts
import {orderEmail, webhookRoute} from 'sanity-plugin-stripe/server'

export const POST = webhookRoute({
  stripe,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  integrationIdentifier,
  client,
  stockClient,
  async onOrder(order, {stock, stockError}) {
    const email = orderEmail(order, {shopName: 'My shop', stock, stockError})
    await sendEmail({to: process.env.ORDER_EMAIL_TO, replyTo: order.customer.email, ...email})
  },
})
```

Both take a web `Request` and return a `Response`, so the same handlers fit Remix, Astro, SvelteKit or Hono. `createStripe` pins the Stripe API version the plugin is tested against. The plugin never reads the environment itself: you pass the values in.

Give your email service `order.sessionId` as an idempotency key (`order.invoiceId` for a renewal). Stock is lowered once per payment whatever happens, but when Stripe delivers one event twice in the same moment, `onOrder` can run for both.

The webhook is not optional. It is the only place an order is fulfilled, because a buyer who pays and closes the tab never reaches the thank-you page. It fulfils only sessions that carry your `integrationIdentifier`: a Payment Link or another site on the same Stripe account is left alone.

Without `stockClient` nothing is counted: the shop sells by the on-sale switch alone, and the routes say so once in the log.

### 3. Stripe

Use a [sandbox](https://docs.stripe.com/sandboxes) while building, and a restricted key (`rk_…`) rather than a secret key. A restricted key with these permissions ran everything the plugin does, in a sandbox:

| Permission        | Level | For                                                             |
| ----------------- | ----- | --------------------------------------------------------------- |
| Checkout Sessions | Write | Starting a checkout, reading a paid one, marking it handled     |
| Products          | Read  | Reading back which products were bought                         |
| Prices            | Read  | The same                                                        |
| Subscriptions     | Read  | A renewal's lines. Only with subscriptions.                     |
| Invoices          | Write | Reading a renewal, marking it handled. Only with subscriptions. |
| Customer portal   | Read  | `portalRoute`. Only if you use it.                              |

Whether it also works without Products and Prices was not tried. A missing permission shows in the route's log, in Stripe's own words.

Locally, forward events to the site and copy the `whsec_…` secret it prints into `STRIPE_WEBHOOK_SECRET`:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed
```

In production, add a webhook endpoint for `https://<your domain>/api/stripe/webhook` in the Stripe Dashboard with the same three events. A shop with subscriptions adds `invoice.paid`, `invoice.payment_failed` and `customer.subscription.deleted`, there and to the command above. `WEBHOOK_EVENTS` lists all six.

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

The browser knows whether something is on sale, not how many are left. When a cart asks for more than there are, the checkout turns it down and says how many can be ordered (`problems[].maxQuantity`), or just that there aren't that many with `hideRemaining`.

`dev/site` in this repository is a complete, small example of all of it.

## Subscriptions

A product can be offered as a subscription next to its normal price. In the Studio, switch on **Subscribe and save** on the product, type the price per delivery and say how often: every so many weeks or months. On your product page the buyer chooses; `useBuyBox` gives you `subscription`, `plan` and `choosePlan` for that.

- **One cart, both kinds.** A cart with a subscription in it becomes a subscription checkout. What is bought once in the same cart is charged with the first payment. One checkout takes one interval: a cart that mixes "every 6 weeks" with "every month" is turned down, with `otherInterval` as the reason.
- **The first payment is an order.** It reaches `onOrder` like any other, with `order.subscription` set and the lines that repeat marked.
- **Each renewal reaches `onRenewal`,** once per paid invoice, with the lines to send again and the address the customer has now, so one changed in the customer portal is the one used. Stock is lowered once per renewal. A renewal is paid before your site hears of it, so it can take a count below 0; `orderEmail` says so.
- **A failed renewal is Stripe's to chase.** Stripe tries again and writes to the customer. `onRenewalFailed` and `onSubscriptionEnded` tell your site, for a mailing-list tag or the like.
- **A subscriber keeps their price.** Changing the price in the Studio changes it for new subscribers.

```ts
export const POST = webhookRoute({
  // …as above
  async onRenewal(order, {stock, stockError}) {
    const email = orderEmail(order, {shopName: 'My shop', stock, stockError})
    await sendEmail({to: process.env.ORDER_EMAIL_TO, idempotencyKey: order.invoiceId, ...email})
  },
})
```

### Delivery on a subscription

Stripe has no shipping options for a subscription, so the Shop settings ask how subscriptions pay for delivery:

- **Free** (the default): delivery is in the subscription's price, and nothing is added.
- **The region's rate with every delivery:** the checkout adds a line, "Delivery: Netherlands", that repeats with the subscription. It is left out when the lines that repeat reach the region's "free from" amount.

One-off items in a subscription cart travel with the first parcel at no extra charge.

### The customer portal

```ts
// app/account/route.ts
import {portalRoute} from 'sanity-plugin-stripe/server'

export const GET = portalRoute({stripe})
```

It sends the visitor to Stripe's customer portal, where a subscriber changes their card or address, pauses or cancels, and finds their invoices. There are no accounts to build: they type their email on Stripe's page and Stripe emails them a link in. Switch the portal's login link on once, in the Stripe Dashboard under Settings, Billing, Customer portal, and choose there what subscribers may change. Until then the route answers 503 and its log says what to do. A portal set up through Stripe's API with its login page enabled works as well.

## Free delivery and promotion codes

Each shipping region can have a **Free from** amount: an order whose goods add up to it or more is delivered free there. The checkout works it out on the server. For the cart page, `shippingQuote(region, subtotal)` gives what will be charged and how much is missing, for "€4.01 more for free delivery".

`promotionCodes: true` on the checkout route shows a field for a code on Stripe's page. Codes and their rules are made in the Stripe Dashboard, and a checkout takes one. Free delivery goes by the goods before the code: the code is typed on Stripe's page, after the delivery charge is set. On a subscription, the code's coupon says whether renewals are discounted too.

## On a public dataset

Sanity serves a public dataset to anyone, without a token, with one fixed exception: a document whose `_id` contains a dot (a draft, for one) is only served to signed-in project members and to API tokens. That is the only line Sanity draws below its Enterprise plan, so the plugin puts each thing on the right side of it, or outside Sanity altogether.

| What                                                                                         | Where it lives                                                      | Who can read it                                                   |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Prices, on sale or sold out, variants, the subscription a product offers                     | Your product documents                                              | Anyone. The shop shows them.                                      |
| Shipping regions, rates and "free from" amounts, "sell out at 0", delivery for subscriptions | The Shop settings document, id `stripeShopSettings`                 | Anyone. The cart shows them.                                      |
| Stock counts                                                                                 | `stripe.stock.<product id>`                                         | Project members and tokens.                                       |
| What each payment did to stock                                                               | `stripe.stockChange.<session or invoice id>`, deleted after 30 days | Project members and tokens. It holds product ids and counts only. |
| Buyers, addresses, orders, subscriptions, payments                                           | Stripe                                                              | Whoever has the Stripe account. Never written to Sanity.          |
| The address order emails go to                                                               | Your site's environment                                             | Your server.                                                      |
| The Stripe key, the webhook secret, the Sanity token                                         | Your site's environment                                             | Your server. Never in Sanity, never in the browser.               |

Why not keep orders in private documents too: a dot hides a document from the public, not from the rest of the project. Every member, including free Viewer seats, every API token that can read (the one many sites use for previews, for one), and every dataset export gets them, and Sanity keeps deleted content in history for 3 to 365 days depending on the plan. That is fine for stock. It is not fine for people's names and addresses.

What this asks of your site:

- **Never ship a Sanity token to the browser.** `stockClient` is for the two routes and for server components. Anything with `NEXT_PUBLIC_` in its name is public.
- **Read products without a token** in the checkout (`client`), as above. The plugin also refuses any product id with a dot, so a draft can't be sold even if a site gets this wrong.
- **Don't publish the order email address.** Forged "new order" emails are easy to write when the format is open source and the mailbox is known. Before shipping anything, open the payment in Stripe: the email links to it.

Counts can be shown by a server component with `readStock(stockClient, [id])`, for "only 2 left". Don't send all of them to the browser.

## Data structure

The field saves this on your document:

```json
{
  "_type": "stripeCommerce",
  "availability": "onSale",
  "price": 29.5,
  "taxClass": "standard",
  "subscription": {
    "_type": "stripeSubscription",
    "enabled": true,
    "price": 26.5,
    "every": 6,
    "unit": "week"
  },
  "variants": [
    {"_key": "a1", "_type": "stripeVariant", "label": "M"},
    {"_key": "b2", "_type": "stripeVariant", "label": "L", "availability": "soldOut"}
  ]
}
```

Prices are in currency units, as editors type them (29.5 is €29.50), and are converted to Stripe's minor units at checkout. Stripe's sandbox has accepted the plugin's amounts in euros and in zero-decimal currencies (yen, won). Three-decimal currencies such as the Kuwaiti dinar follow Stripe's rule but could not be tried: Stripe refuses them on an account without a bank account in that currency.

Stock is a document of its own per product, written by the stock boxes and the webhook:

```json
{
  "_id": "stripe.stock.4f6c1c2e",
  "_type": "stripe.stock",
  "variants": [{"_key": "a1", "stockCount": 2}]
}
```

A product without variants has `stockCount` at the top. No count means it isn't counted. When a count reaches 0 and "sell out automatically" is on, the webhook switches the product or variant to sold out in every version of the product document: published, draft, and copies inside a Content Release. A count of 0 is refused at checkout whatever the switch says.

## Options

### `stripeCommerce()` in the Studio

| Option                 |                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `currency`             | ISO 4217 code every price is in, such as `eur`. Required.                                                                |
| `tax.label`            | What tax is called where the shop is: `VAT`, `GST`, `sales tax`. Default `tax`.                                          |
| `tax.included`         | Whether entered prices include tax. It only changes the labels. Default true.                                            |
| `tax.classes`          | `{title, value}` choices for a product's tax class. Without any, the field is left out.                                  |
| `shop.shippingRegions` | Starting regions: `{title, countries, rate}` or `{title, everywhereElse: true, rate}`, each with an optional `freeFrom`. |

### `checkoutRoute()`

| Option                  |                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `stripe`                | From `createStripe`. Without one the route answers 503. Required.                             |
| `client`                | A Sanity client without a token that skips the CDN. Required.                                 |
| `stockClient`           | A Sanity client with a token, to read stock. Without it nothing is counted.                   |
| `currency`              | The same code the Studio plugin has. Required.                                                |
| `successUrl`            | A path or address, with `{CHECKOUT_SESSION_ID}` in it. Required.                              |
| `cancelUrl`             | Where Stripe's back link goes. Required.                                                      |
| `integrationIdentifier` | Marks the shop's sessions for the webhook and the Stripe Dashboard. Required.                 |
| `products`              | Where products live: `{types, field, title, slug, image}`. Default `product` with `commerce`. |
| `taxRates`              | Stripe tax rate ids (`txr_…`) by tax class, so receipts show the tax.                         |
| `maxQuantity`           | Most of one item per order. Default 10.                                                       |
| `hideRemaining`         | Don't say how many are left when a cart asks for too many.                                    |
| `expiresInMinutes`      | Minutes until an unpaid session expires, about 30 at least. Stripe's default is 24 hours.     |
| `promotionCodes`        | Shows a field for a promotion code on Stripe's page.                                          |
| `extend`                | Changes the session's parameters before it is created: phone numbers, consent, a customer.    |
| `messages`              | What buyers read when the checkout can't start.                                               |
| `debug`                 | Adds the reason to error replies. For development.                                            |

### `webhookRoute()`

| Option                  |                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `stripe`                | From `createStripe`. Required.                                                                                                    |
| `webhookSecret`         | The endpoint's signing secret (`whsec_…`). Required.                                                                              |
| `integrationIdentifier` | The same value the checkout route has. Required.                                                                                  |
| `client`                | A Sanity client without a token that skips the CDN. Required.                                                                     |
| `stockClient`           | A Sanity client with a token that can write, to lower stock. Without it stock is left alone.                                      |
| `products`              | The same as the checkout route's.                                                                                                 |
| `onOrder`               | Called once per paid order with the order, the shop settings and what happened to stock.                                          |
| `onPaymentFailed`       | Called when a delayed payment of the shop fails.                                                                                  |
| `onRenewal`             | Called once per paid renewal of a subscription, with the order to send again and what happened to stock.                          |
| `onRenewalFailed`       | Called when a renewal's payment fails. Stripe retries and writes to the customer itself.                                          |
| `onSubscriptionEnded`   | Called when a subscription of the shop ends.                                                                                      |
| `onEvent`               | Called for every other signed event the endpoint receives, such as a dispute. These are the Stripe account's, not sorted by shop. |

If stock can't be lowered (a token that may only read), `onOrder` still runs, with `stockError` saying why, and Stripe is asked to deliver the event again; only the stock is tried again.

### `portalRoute()`

| Option    |                                                                   |
| --------- | ----------------------------------------------------------------- |
| `stripe`  | From `createStripe`. Without one the route answers 503. Required. |
| `message` | What a visitor reads when the portal can't be opened.             |

## What it doesn't do

- **Tax compliance.** Prices are what editors enter. A tax class can attach a Stripe tax rate you created, so the receipt shows the tax, and that is all. It does not use Stripe Tax and does not work out the VAT of the buyer's country for cross-border sales. Ask your accountant what your shop needs.
- **Hold stock during checkout.** Stock is checked when Checkout starts and lowered when the payment lands. Two buyers can both pay for the last copy; the order email then says so. `expiresInMinutes` narrows the window.
- **Show orders in the Studio.** Orders are in the Stripe Dashboard and in the email your `onOrder` sends. An Orders tab that reads them live from Stripe is planned.
- **Send email.** `orderEmail()` writes the order email; sending it is your `onOrder`, with your email service.
- **Shipping by weight, discount logic of its own.** A flat rate per region, free from an amount if you like. Discounts are Stripe's promotion codes.
- **Trials, or switching a subscription to another product.** A subscriber can pause, cancel and change their card and address in Stripe's portal. Their subscription keeps the product and price it started with.

## Security

- The browser sends product ids, quantities and a region id. Prices, names and shipping rates are read from Sanity on the server, and anything else in the request is dropped.
- Every webhook delivery's signature is checked against the raw body before it is parsed. The route then reads the session again from Stripe's API, checks that it is this shop's, and goes by that copy's payment status. A renewal is checked the same way: its invoice is read again from Stripe, and it is the shop's only when the checkout that started the subscription carries the shop's mark.
- Keys come from your environment and are passed in. Use a restricted key, and a separate one for each environment.
- Names inside the plugin's GROQ (document types, the field name) are checked when the routes are made. Ids travel as query parameters.
- The order email escapes everything a buyer typed.

## Developing

```bash
pnpm install
pnpm build
pnpm check
```

`pnpm check` typechecks, lints and runs the tests. The tests use the real stripe-node client with its network replaced, so requests are built and webhook signatures are checked by the SDK itself, and run the plugin's real GROQ with groq-js against a stand-in dataset that hides dotted ids from a tokenless reader, as Sanity does. One test fails if `/react` or `/server` reaches Sanity, or the Studio's entry reaches Stripe. Build first: the lint reads `dev/site`, which imports the built package.

### The test site

`dev/site` is a Next.js shop with the Studio inside it at `/studio`. Without a Sanity project it sells sample products kept in memory, so the cart, the checkout and the webhook can be tried with a Stripe key alone; stock goes back to the sample values when the server restarts. Copy `dev/site/.env.example` to `dev/site/.env.local` and fill it in, then:

```bash
pnpm watch                  # rebuilds dist as you edit
pnpm --dir dev/site dev
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Without a Stripe key the routes answer 503 and the rest of the site works.

## License

MIT © Confederation Studio
