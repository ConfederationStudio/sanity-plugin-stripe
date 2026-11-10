import {notFound} from 'next/navigation'
import {formatPrice, readCartProducts} from 'sanity-plugin-stripe/server'

import {CURRENCY} from '../../../../lib/env'
import {PRODUCT_QUERY, reader} from '../../../../lib/sanity'
import {BuyBox} from './BuyBox'

export const dynamic = 'force-dynamic'

const inStock = (count: number | null | undefined) =>
  typeof count === 'number' ? `${count} in stock` : 'no stock count'

export default async function ProductPage({params}: {params: Promise<{slug: string}>}) {
  const {slug} = await params
  const [product] = readCartProducts([await reader.fetch(PRODUCT_QUERY, {slug})])
  if (!product) notFound()
  const variants = product.commerce?.variants ?? []

  return (
    <>
      <h1>{product.title}</h1>
      {typeof product.commerce?.price === 'number' && (
        <p>{formatPrice(product.commerce.price, CURRENCY)}</p>
      )}
      {/* The test site shows the counts, to watch a paid order lower them. */}
      <p className="muted" data-testid="stock">
        {variants.length
          ? variants.map((variant) => `${variant.label}: ${inStock(variant.stockCount)}`).join(', ')
          : inStock(product.commerce?.stockCount)}
      </p>
      <BuyBox product={product} />
    </>
  )
}
