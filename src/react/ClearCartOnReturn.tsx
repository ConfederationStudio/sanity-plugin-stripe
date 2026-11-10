import {useEffect} from 'react'

import {useCart} from './cart'

export interface ClearCartOnReturnProps {
  /** The query parameter Stripe's `success_url` carries. Default `session_id`. */
  param?: string
}

/**
 * Empties the cart on the page Stripe sends buyers back to, when the address carries a Checkout
 * Session id. It draws nothing. The order itself is handled by the webhook, not by this page.
 */
export function ClearCartOnReturn({param = 'session_id'}: ClearCartOnReturnProps) {
  const {ready, clear} = useCart()
  useEffect(() => {
    if (ready && new URLSearchParams(window.location.search).has(param)) clear()
  }, [ready, clear, param])
  return null
}
