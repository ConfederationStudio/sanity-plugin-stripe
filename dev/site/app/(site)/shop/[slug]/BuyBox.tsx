'use client'

import Link from 'next/link'
import {useId} from 'react'
import {
  describeInterval,
  formatPrice,
  useBuyBox,
  type CartProduct,
} from 'sanity-plugin-stripe/react'

/** The buy button, drawn by the site: the plugin's `useBuyBox` knows what can be bought. */
export function BuyBox({product, currency}: {product: CartProduct; currency: string}) {
  const group = useId()
  const planGroup = useId()
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
      {box.subscription && (
        <fieldset>
          <legend>How often</legend>
          <label>
            <input
              type="radio"
              name={planGroup}
              value="once"
              checked={box.plan === 'once'}
              onChange={() => box.choosePlan('once')}
            />{' '}
            Buy once
          </label>
          <label>
            <input
              type="radio"
              name={planGroup}
              value="subscribe"
              checked={box.plan === 'subscribe'}
              onChange={() => box.choosePlan('subscribe')}
            />{' '}
            Subscribe and save: {formatPrice(box.subscription.price, currency)}{' '}
            {describeInterval(box.subscription.interval)}
          </label>
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
