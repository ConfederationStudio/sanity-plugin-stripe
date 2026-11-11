# Changelog

Until 1.0, a minor version may change the API. Each change that needs work on a site or Studio says what to do.

## Unreleased

Subscriptions, the customer portal, free delivery from an amount and promotion codes. Nothing has to change on a site that sells one-off only.

- **Subscriptions.** A product can offer a subscription: a price per delivery, every so many weeks or months. A cart line can subscribe (`plan: 'subscribe'`), `useBuyBox` gives `subscription`, `plan` and `choosePlan`, and a cart with a subscription becomes a subscription checkout that also charges what is bought once.
- **Renewals.** `webhookRoute` takes `onRenewal`, called once per paid renewal with the order to send again and the address the customer has now; stock is lowered once per renewal. `onRenewalFailed`, `onSubscriptionEnded` and `onEvent` cover the rest. Add `invoice.paid`, `invoice.payment_failed` and `customer.subscription.deleted` to the webhook endpoint; `WEBHOOK_EVENTS` lists them.
- **Delivery on a subscription.** Stripe has no shipping options for subscriptions. The Shop settings choose: free, or the region's rate as a line that repeats with the subscription.
- **`portalRoute()`** sends a subscriber to Stripe's customer portal. Switch its login link on in the Stripe Dashboard.
- **Free delivery from an amount.** A shipping region can have a "Free from" amount. `shippingQuote()` gives the cart page what will be charged and how much is missing.
- **`promotionCodes: true`** on `checkoutRoute` shows the code field on Stripe's page.
- `Order` gains `subscription` and `invoiceId`, and its items `subscription`. `orderEmail` words a renewal as one and links to its invoice.
- A webhook endpoint that also receives subscription checkouts made outside the shop still leaves them alone; one made by the shop is now fulfilled, where 0.1 ignored every subscription.

Tried on 11 November 2026 in a Stripe sandbox against the public test dataset: a subscription bought in one cart with a one-off item, its delivery as a repeating line, the order email, stock, and free delivery over the amount. On a Stripe test clock, six weeks on: the renewal lowered stock once and its email went to the address the customer had changed in between; the same event delivered again changed nothing; a renewal whose card was declined fulfilled nothing and reached `onRenewalFailed`, and was fulfilled once it was paid; cancelling reached `onSubscriptionEnded`. A promotion code took 10% off the goods, not the delivery. With the portal's login link switched on, `portalRoute` redirected to Stripe's login page; signing in there was not tried. The Studio's new fields were opened in a browser: the subscription's fields appear when it is switched on and block publishing until they are filled in, a region shows its "free from" amount, and the shop settings show the choice for subscription delivery.

## 0.1.1 (2026-11-11)

A packaging fix. Nothing a site or Studio uses has changed, and nothing needs doing beyond updating.

- 0.1.0 went out with an export map that also named the package's source files, which the package doesn't hold. A site whose bundler or `tsconfig` turns on the `source` condition could not find the package. 0.1.1 names the built files alone.

## 0.1.0 (2026-11-11)

The first release.

- **Studio:** the `stripeCommerce()` plugin, with the `stripeCommerce` field (on sale or sold out, price, tax class, variants, and stock boxes that save counts outside the product document), the Shop settings document (shipping regions with flat rates, selling out at 0) kept as a singleton, and `shopSettingsListItem` for the structure.
- **Site, `/react`:** `<CartProvider>` and `useCart` (a cart in localStorage holding references only), `useBuyBox`, `useCheckout` and `<ClearCartOnReturn>`.
- **Site, `/server`:** `checkoutRoute()` and `webhookRoute()` on web `Request` and `Response`, `createStripe` pinned to the tested API version, `orderEmail`, `readStock`, and the GROQ the cart reads products with.
- **Made for a public dataset:** no buyer, address or order is written to Sanity; stock counts live in private `stripe.stock.<product id>` documents; the order email address and every key stay in the site's environment.
- Stock is lowered once per Checkout Session even when two deliveries of an event arrive together, and the webhook fulfils only sessions that carry the shop's `integrationIdentifier`.
- The Studio's stock boxes follow a count as an order lowers it, without a reload.

Tried on 10 November 2026 in a Stripe sandbox against a real, public Sanity dataset: payments, a resent event, the same event delivered twice at once, a declined card, a payment made outside the shop, the shipping regions' country lists, selling the last copies of a product that also had a draft and a copy in a release, and reading the dataset without a token. In the Studio: the price and stock field on new and existing products, the stock boxes (saving, emptying, refusing what isn't a whole number, the note when something sold out has stock again, following a count changed from outside), and the Shop settings (starting regions, no duplicate or delete, not offered as a new document).

Not tried yet: a delayed payment method such as a bank debit, a Sanity token that may only read, three-decimal currencies, and the smallest set of permissions a restricted Stripe key needs.
