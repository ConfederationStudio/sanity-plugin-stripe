# Changelog

Until 1.0, a minor version may change the API. Each change that needs work on a site or Studio says what to do.

## Unreleased

Not on npm yet. What is in the repository:

- **Studio:** the `stripeCommerce()` plugin, with the `stripeCommerce` field (on sale or sold out, price, tax class, variants, and stock boxes that save counts outside the product document), the Shop settings document (shipping regions with flat rates, selling out at 0) kept as a singleton, and `shopSettingsListItem` for the structure.
- **Site, `/react`:** `<CartProvider>` and `useCart` (a cart in localStorage holding references only), `useBuyBox`, `useCheckout` and `<ClearCartOnReturn>`.
- **Site, `/server`:** `checkoutRoute()` and `webhookRoute()` on web `Request` and `Response`, `createStripe` pinned to the tested API version, `orderEmail`, `readStock`, and the GROQ the cart reads products with.
- **Made for a public dataset:** no buyer, address or order is written to Sanity; stock counts live in private `stripe.stock.<product id>` documents; the order email address and every key stay in the site's environment.
- Stock is lowered once per Checkout Session even when two deliveries of an event arrive together, and the webhook fulfils only sessions that carry the shop's `integrationIdentifier`.

Tried on 10 November 2026 in a Stripe sandbox against a real, public Sanity dataset: payments, a resent event, the same event delivered twice at once, a declined card, a payment made outside the shop, the shipping regions' country lists, selling the last copies of a product that also had a draft and a copy in a release, and reading the dataset without a token.

Before 0.1.0: the Studio's stock boxes in a browser, a delayed payment method, and the smallest set of permissions a restricted key needs.
