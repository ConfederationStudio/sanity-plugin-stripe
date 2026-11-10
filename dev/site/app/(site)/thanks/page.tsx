import Link from 'next/link'
import {ClearCartOnReturn} from 'sanity-plugin-stripe/react'

/**
 * Where Stripe sends buyers after paying. Nothing is fulfilled here: the webhook does that, so an
 * order counts even when the buyer closes the tab before this page loads.
 */
export default function ThanksPage() {
  return (
    <>
      <h1>Thank you</h1>
      <p>We have your order and will send it once the payment is confirmed.</p>
      <p>
        <Link href="/">Back to the shop</Link>
      </p>
      <ClearCartOnReturn />
    </>
  )
}
