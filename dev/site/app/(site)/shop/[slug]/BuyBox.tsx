'use client'

import Link from 'next/link'
import {useId} from 'react'
import {useBuyBox, type CartProduct} from 'sanity-plugin-stripe/react'

/** The buy button, drawn by the site: the plugin's `useBuyBox` knows what can be bought. */
export function BuyBox({product}: {product: CartProduct}) {
  const group = useId()
  const box = useBuyBox(product)

  if (box.soldOut) return <p className="muted">Sold out</p>

  return (
    <div>
      {box.variants.length > 0 && (
        <fieldset>
          <legend>Choose one</legend>
          {box.variants.map((variant) => (
            <label key={variant._key}>
              <input
                type="radio"
                name={group}
                value={variant._key}
                checked={box.variantKey === variant._key}
                disabled={!variant.available}
                onChange={() => box.chooseVariant(variant._key)}
              />{' '}
              {variant.label}
              {!variant.available && ' – sold out'}
            </label>
          ))}
        </fieldset>
      )}
      <button type="button" disabled={!box.status.available || box.full} onClick={() => box.add()}>
        {box.full ? 'All in your cart' : 'Add to cart'}
      </button>
      <output>
        {box.added && (
          <>
            Added. <Link href="/cart">View cart</Link>
          </>
        )}
      </output>
    </div>
  )
}
