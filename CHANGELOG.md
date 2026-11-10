# Changelog

Until 1.0, a minor version may change the API. Each change that needs work on a site or Studio says what to do.

## Unreleased

Not on npm yet. What is in the repository:

- **Studio:** the `stripeCommerce()` plugin, with the `stripeCommerce` field (availability, price, tax class, stock count, variants), the Shop settings document (shipping regions with flat rates, the order email, selling out at 0) kept as a singleton, and `shopSettingsListItem` for the structure.
- **Site, `/react`:** `<CartProvider>` and `useCart` (a cart in localStorage holding references only), `useBuyBox`, `useCheckout` and `<ClearCartOnReturn>`.
- **Site, `/server`:** `checkoutRoute()` and `webhookRoute()` on web `Request` and `Response`, `createStripe` pinned to the tested API version, and the pieces they are made of: `buildCheckoutSession`, `verifyEvent`, `classifyEvent`, `getOrder`, `decrementStock`, `runOnce`, `orderEmail`, and the GROQ the cart and checkout read products with.
- Stock is lowered once per Checkout Session even when two deliveries of an event arrive together.

Tried on 10 November 2026 in a Stripe sandbox, with the test site's sample products: two payments, a resent event, a declined card and the shipping regions' country lists.

Before 0.1.0: the same run against a real Sanity dataset, a delayed payment method, and the smallest set of permissions a restricted key needs.
