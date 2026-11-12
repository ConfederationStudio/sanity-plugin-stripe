import type {OrderDetail, OrderSummary} from '../../core/orders'

/** "12 Nov 2026, 10:02" in the editor's own language and time zone. */
export function formatWhen(iso: string, locale?: string, timeZone?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone ? {timeZone} : {}),
  }).format(date)
}

/** "Netherlands" for `NL`. The code itself when the browser doesn't know it. */
export function countryName(code: string | null, locale = 'en'): string | null {
  if (!code) return null
  try {
    return new Intl.DisplayNames([locale], {type: 'region'}).of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

/** Who to show an order under: the name, else the email address. */
export function buyerLabel(order: Pick<OrderSummary, 'customer'>): string {
  return order.customer.name || order.customer.email || 'A customer'
}

export interface OrderBadge {
  text: string
  tone: 'default' | 'primary' | 'caution' | 'critical'
}

/** What sets an order apart in the list. A plain paid order has none. */
export function orderBadges(
  order: Pick<OrderSummary, 'kind' | 'status' | 'subscription' | 'livemode'>,
): OrderBadge[] {
  const badges: OrderBadge[] = []
  if (order.status === 'unpaid') badges.push({text: 'Not paid', tone: 'critical'})
  if (order.kind === 'renewal') badges.push({text: 'Renewal', tone: 'primary'})
  else if (order.subscription) badges.push({text: 'New subscription', tone: 'primary'})
  if (!order.livemode) badges.push({text: 'Test', tone: 'caution'})
  return badges
}

/** "Fully refunded", "Partly refunded", or null when nothing was paid back or it isn't known. */
export function refundLabel(
  order: Pick<OrderDetail, 'amountRefunded' | 'amountTotal'>,
): string | null {
  if (!order.amountRefunded) return null
  return order.amountRefunded >= order.amountTotal ? 'Fully refunded' : 'Partly refunded'
}

/** Adds older orders to the list, without showing one twice. */
export function addOlder(shown: readonly OrderSummary[], older: readonly OrderSummary[]) {
  const ids = new Set(shown.map(({id}) => id))
  return [...shown, ...older.filter(({id}) => !ids.has(id))]
}
