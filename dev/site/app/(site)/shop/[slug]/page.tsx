import {notFound} from 'next/navigation'
import {formatPrice, readCartProducts, readStock, stockLeft} from 'sanity-plugin-stripe/server'

import {CURRENCY} from '../../../../lib/env'
import {PRODUCT_QUERY, reader, stockClient} from '../../../../lib/sanity'
import {BuyBox} from './BuyBox'

export const dynamic = 'force-dynamic'

const inStock = (count: number | null) =>
  typeof count === 'number' ? `${count} in stock` : 'not counted'

export default async function ProductPage({params}: {params: Promise<{slug: string}>}) {
  const {slug} = await params
  const [product] = readCartProducts([await reader.fetch(PRODUCT_QUERY, {slug})])
  if (!product) notFound()
  const variants = product.commerce?.variants ?? []
  // Only the server can read counts. A real shop would show "sold out" and no numbers; the test
  // site prints them, to watch a paid order lower them.
  const stock = stockClient ? (await readStock(stockClient, [product._id])).get(product._id) : null

  return (
    <>
      <h1>{product.title}</h1>
      {typeof product.commerce?.price === 'number' && (
        <p>{formatPrice(product.commerce.price, CURRENCY)}</p>
      )}
      <p className="muted" data-testid="stock">
        Test readout, from the server:{' '}
        {!stockClient
          ? 'stock is not counted without a Sanity token'
          : variants.length
            ? variants
                .map(
                  (variant) =>
                    `${variant.label}: ${inStock(stockLeft(stock ?? undefined, variant._key))}`,
                )
                .join(', ')
            : inStock(stockLeft(stock ?? undefined))}
      </p>
      <BuyBox product={product} currency={CURRENCY} />
    </>
  )
}
