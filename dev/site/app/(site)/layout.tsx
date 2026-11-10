import type {ReactNode} from 'react'
import {CartProvider} from 'sanity-plugin-stripe/react'

import {Header} from './Header'

import './styles.css'

export const metadata = {title: 'Stripe plugin test shop'}

export default function Layout({children}: {children: ReactNode}) {
  return (
    <html lang="en">
      <body>
        <CartProvider storageKey="stripe-plugin-test-cart">
          <Header />
          <main>{children}</main>
        </CartProvider>
      </body>
    </html>
  )
}
