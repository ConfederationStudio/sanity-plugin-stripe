import Link from 'next/link'
import {formatPrice, readCartProducts} from 'sanity-plugin-stripe/server'

import {CURRENCY} from '../../lib/env'
import {PRODUCTS_QUERY, reader, standIn} from '../../lib/sanity'

// Prices and stock change in the Studio, so the shop is read on every visit.
export const dynamic = 'force-dynamic'

export default async function ShopPage() {
  const products = readCartProducts(await reader.fetch(PRODUCTS_QUERY))
  return (
    <>
      <h1>Shop</h1>
      {standIn && (
        <p className="muted">
          Sample products: no Sanity project is set, so they live in memory and stock goes back when
          the server restarts.
        </p>
      )}
      {products.length === 0 && (
        <p className="muted">
          No products yet. Add one in the <Link href="/studio">Studio</Link>, and publish the shop
          settings there too.
        </p>
      )}
      <ul className="products">
        {products.map((product) => (
          <li key={product._id}>
            <Link href={`/shop/${product.slug}`}>{product.title}</Link>
            <span>
              {typeof product.commerce?.price === 'number'
                ? formatPrice(product.commerce.price, CURRENCY)
                : 'No price'}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}
