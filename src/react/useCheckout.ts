import {useCallback, useState} from 'react'

import {readCheckoutProblems, type CheckoutProblem} from '../core/cart'
import {asString, isObject} from '../core/guards'
import {useCart} from './cart'

export type CheckoutState =
  | {status: 'idle'}
  /** Asking the site for a Checkout Session, then on the way to Stripe. */
  | {status: 'loading'}
  | {
      status: 'error'
      /** `region`, `empty`, `unavailable`, `invalid`, or `offline` when the site can't be reached. */
      error: string
      /** For the buyer. */
      message: string
      /** For the developer: only sent by a checkout route with `debug` on. */
      detail?: string
      /** The cart lines the checkout turned down, and why. */
      problems: CheckoutProblem[]
    }

export interface UseCheckoutOptions {
  /** The site's checkout route. Default `/api/checkout`. */
  endpoint?: string
  messages?: {
    /** No shipping region chosen. */
    region?: string
    /** The site answered without saying why. */
    unavailable?: string
    /** The site couldn't be reached. */
    offline?: string
  }
}

export interface Checkout {
  state: CheckoutState
  /** Sends the cart and the chosen region to the checkout route, then goes to Stripe's page. */
  start: (regionId: string | undefined) => Promise<void>
  /** Back to `idle`, for example when the buyer changes the cart after an error. */
  reset: () => void
}

const MESSAGES = {
  region: 'Choose where to ship the order.',
  unavailable: "Checkout isn't available right now. Please try again later.",
  offline: "Couldn't reach the shop. Check your connection and try again.",
}

/** Starts Stripe Checkout for the cart, and says what went wrong when it can't. */
export function useCheckout(options: UseCheckoutOptions = {}): Checkout {
  const {endpoint = '/api/checkout'} = options
  const messages = {...MESSAGES, ...options.messages}
  const {lines} = useCart()
  const [state, setState] = useState<CheckoutState>({status: 'idle'})

  const start = async (regionId: string | undefined) => {
    if (!regionId) {
      setState({status: 'error', error: 'region', message: messages.region, problems: []})
      return
    }
    setState({status: 'loading'})
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({lines, regionId}),
      })
      const body: unknown = await response.json().catch(() => null)
      const data = isObject(body) ? body : {}
      if (response.ok && typeof data.url === 'string') {
        // Stay in the loading state while the browser goes to Stripe.
        window.location.assign(data.url)
        return
      }
      setState({
        status: 'error',
        error: asString(data.error) ?? 'unavailable',
        message: asString(data.message) ?? messages.unavailable,
        ...(typeof data.detail === 'string' ? {detail: data.detail} : {}),
        problems: readCheckoutProblems(data.problems),
      })
    } catch {
      setState({status: 'error', error: 'offline', message: messages.offline, problems: []})
    }
  }

  const reset = useCallback(() => setState({status: 'idle'}), [])
  return {state, start, reset}
}
