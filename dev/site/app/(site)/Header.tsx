'use client'

import Link from 'next/link'
import {useCart} from 'sanity-plugin-stripe/react'

export function Header() {
  const {count, ready} = useCart()
  return (
    <header>
      <Link href="/">Test shop</Link>
      <nav>
        <Link href="/cart">Cart{ready && count > 0 ? ` (${count})` : ''}</Link>
        {/* A route, not a page: it sends a subscriber on to Stripe's customer portal. */}
        <a href="/account">Account</a>
        <Link href="/studio">Studio</Link>
      </nav>
    </header>
  )
}
