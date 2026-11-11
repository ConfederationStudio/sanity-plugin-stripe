import type Stripe from 'stripe'

import {describeInterval} from '../core/cart'
import {formatMoney} from '../core/money'
import type {Order} from './order'
import type {StockChange} from './stock'

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[char] ?? char,
  )

function addressLines(name: string | null, address: Stripe.Address | null): string[] {
  if (!address) return name ? [name] : []
  const city = [address.postal_code, address.city].filter(Boolean).join(' ')
  return [name, address.line1, address.line2, city, address.state, address.country].filter(
    (line): line is string => Boolean(line),
  )
}

/** Where the payment is in the Stripe Dashboard: a renewal's invoice, a subscription, a payment. */
export function dashboardUrl(
  order: Pick<Order, 'livemode' | 'paymentIntentId' | 'sessionId' | 'invoiceId' | 'subscription'>,
): string {
  const base = `https://dashboard.stripe.com/${order.livemode ? '' : 'test/'}`
  if (order.invoiceId) return `${base}invoices/${order.invoiceId}`
  if (order.subscription) return `${base}subscriptions/${order.subscription.id}`
  return order.paymentIntentId
    ? `${base}payments/${order.paymentIntentId}`
    : `${base}checkout/sessions/${order.sessionId}`
}

export interface OrderEmailOptions {
  /** Starts the subject line. */
  shopName: string
  /** For amounts: a BCP 47 tag such as `en`, `nl-NL`. Default `en`. */
  locale?: string
  /** What the order did to stock counts. Anything sold below 0 is called out. */
  stock?: readonly StockChange[]
  /** Why stock could not be lowered, from the webhook's context. The email says to check it. */
  stockError?: string
}

export interface OrderEmail {
  subject: string
  text: string
  html: string
}

/**
 * A plain order email for the shop: what to pack, where to send it and who paid. It serves a
 * subscription's renewal too, from `onRenewal`.
 */
export function orderEmail(order: Order, options: OrderEmailOptions): OrderEmail {
  const {shopName, locale = 'en', stock = [], stockError} = options
  const money = (minor: number) => formatMoney(minor, order.currency, locale)
  const count = order.items.reduce((sum, item) => sum + item.quantity, 0)
  const who = order.shipping.name ?? order.customer.name ?? order.customer.email ?? 'a customer'
  const renewal = Boolean(order.invoiceId)
  const subject = `${order.livemode ? '' : '[Test] '}${shopName} ${renewal ? 'renewal for' : 'order from'} ${who}: ${count} ${count === 1 ? 'item' : 'items'}, ${money(order.amountTotal)}`
  const heading = renewal ? 'Subscription renewal' : 'New order'
  const repeats = order.subscription?.interval
    ? `subscription, ${describeInterval(order.subscription.interval)}`
    : 'subscription'
  // On a renewal every line repeats, so only a first order says which lines do.
  const nameOf = (item: Order['items'][number]) =>
    item.subscription && !renewal ? `${item.name} (${repeats})` : item.name
  const address = addressLines(order.shipping.name, order.shipping.address)
  const contact = [order.customer.email, order.customer.phone].filter((line): line is string =>
    Boolean(line),
  )
  const shippingLabel = order.regionTitle ? `Shipping (${order.regionTitle})` : 'Shipping'
  const link = dashboardUrl(order)
  const date = order.createdAt.toISOString().slice(0, 10)

  const oversold = stock
    .filter((change) => change.to < 0)
    .map((change) => {
      const item = order.items.find(
        (candidate) =>
          candidate.productId === change.productId &&
          (candidate.variantKey ?? '') === (change.variantKey ?? ''),
      )
      return item?.name ?? change.productId
    })
  const warnings = [
    ...(oversold.length
      ? [`Check your stock: more was sold than was counted in stock for ${oversold.join(', ')}.`]
      : []),
    ...(stockError
      ? [`Stock counts were not lowered for this order. Change them by hand. (${stockError})`]
      : []),
  ]

  const text = [
    `${heading} on ${date}${order.livemode ? '' : ' (test mode, no money moved)'}`,
    '',
    ...warnings.flatMap((warning) => [warning, '']),
    ...order.items.map((item) => `${item.quantity} × ${nameOf(item)}  ${money(item.amountTotal)}`),
    `${shippingLabel}  ${money(order.amountShipping)}`,
    `Total  ${money(order.amountTotal)}`,
    '',
    'Ship to:',
    ...address,
    '',
    'Contact:',
    ...contact,
    '',
    `In Stripe: ${link}`,
  ].join('\n')

  const rows = order.items
    .map(
      (item) =>
        `<tr><td style="padding:4px 12px 4px 0">${item.quantity} ×</td><td style="padding:4px 12px 4px 0">${escapeHtml(nameOf(item))}</td><td style="padding:4px 0;text-align:right">${money(item.amountTotal)}</td></tr>`,
    )
    .join('')
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.45;color:#191919">
<p>${heading} on ${date}${order.livemode ? '' : ' <strong>(test mode, no money moved)</strong>'}</p>
${warnings.map((warning) => `<p><strong>${escapeHtml(warning)}</strong></p>\n`).join('')}<table style="border-collapse:collapse">${rows}
<tr><td></td><td style="padding:4px 12px 4px 0">${escapeHtml(shippingLabel)}</td><td style="padding:4px 0;text-align:right">${money(order.amountShipping)}</td></tr>
<tr><td></td><td style="padding:4px 12px 4px 0"><strong>Total</strong></td><td style="padding:4px 0;text-align:right"><strong>${money(order.amountTotal)}</strong></td></tr>
</table>
<p><strong>Ship to</strong><br>${address.map(escapeHtml).join('<br>')}</p>
<p><strong>Contact</strong><br>${contact.map(escapeHtml).join('<br>')}</p>
<p><a href="${link}">Open the payment in Stripe</a></p>
</div>`

  return {subject, text, html}
}
