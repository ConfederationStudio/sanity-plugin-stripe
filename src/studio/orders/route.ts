import {isObject} from '../../core/guards'
import type {OrderReply, OrdersReply, StudioRouteErrorCode} from '../../core/orders'

/** Why the Studio didn't get an answer: the route's own codes, and two of the Studio's. */
export type RouteFailure = StudioRouteErrorCode | 'no-token' | 'unreachable'

export class RouteError extends Error {
  readonly code: RouteFailure
  constructor(code: RouteFailure) {
    super(code)
    this.name = 'RouteError'
    this.code = code
  }
}

export interface RouteClient {
  /** Newest first. `before` is the `next` of the answer before. */
  orders(before?: string): Promise<OrdersReply>
  order(id: string): Promise<OrderReply>
}

/**
 * Calls the site's Studio routes as the editor, with the token Sanity gave the Studio on
 * sign-in. A Studio signed in through Sanity's cookie alone has no token to pass, and the editor
 * must sign in again.
 */
export function routeClient(
  api: string,
  token: string | undefined,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): RouteClient {
  async function call<T>(path: string): Promise<T> {
    if (!token) throw new RouteError('no-token')
    let response: Response
    try {
      response = await fetcher(`${api}${path}`, {
        headers: {authorization: `Bearer ${token}`, accept: 'application/json'},
      })
    } catch {
      throw new RouteError('unreachable')
    }
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const code = isObject(body) && typeof body.error === 'string' ? body.error : 'stripe-failed'
      // oxlint-disable-next-line no-unsafe-type-assertion -- the route answers with its own codes
      throw new RouteError(code as RouteFailure)
    }
    // oxlint-disable-next-line no-unsafe-type-assertion -- the route's replies are typed in core/orders
    return body as T
  }

  return {
    orders: (before) => call(before ? `/orders?before=${encodeURIComponent(before)}` : '/orders'),
    order: (id) => call(`/orders/${encodeURIComponent(id)}`),
  }
}

/** What to tell an editor about a failure, and what to do about it. */
export function failureText(failure: unknown, api: string): string {
  const code: RouteFailure = failure instanceof RouteError ? failure.code : 'stripe-failed'
  switch (code) {
    case 'no-token':
      return 'This Studio session has no token to show the site. Sign out of the Studio and sign in again.'
    case 'unreachable':
      return `The Studio can't reach the site at ${api}. Check that the site is up and that its Studio routes allow this Studio's address.`
    case 'signed-out':
      return 'The site couldn’t confirm who you are. Sign out of the Studio and sign in again.'
    case 'not-member':
      return 'Your account isn’t a member of this project.'
    case 'forbidden-origin':
      return 'The site doesn’t accept this Studio’s address. Add it to studioOrigins in the site’s Studio routes.'
    case 'forbidden-role':
      return 'Your role in this project may not see orders. An administrator can change which roles may.'
    case 'no-stripe':
      return 'The site has no Stripe key, so it can’t read orders.'
    case 'sanity-failed':
      return 'The site couldn’t reach Sanity to check who you are. Try again.'
    case 'bad-request':
      return 'The site didn’t understand the request.'
    case 'not-found':
      return 'The site doesn’t know this order, or its Studio routes aren’t at the address in the plugin’s api option.'
    default:
      return 'Stripe didn’t answer the site. Try again.'
  }
}
