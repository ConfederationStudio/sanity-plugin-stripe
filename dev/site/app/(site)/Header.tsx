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
        <Link href="/studio">Studio</Link>
      </nav>
    </header>
  )
}
