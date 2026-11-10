'use client'

import Link from 'next/link'
import {useId, useState} from 'react'
import {
  cartRows,
  cartSubtotal,
  formatPrice,
  lineKey,
  useCart,
  useCheckout,
  type CartProduct,
  type CheckoutProblem,
  type RegionOption,
} from 'sanity-plugin-stripe/react'

const REASONS: Record<CheckoutProblem['reason'], string> = {
  missing: 'No longer in the shop',
  soldOut: 'Sold out',
  noPrice: 'Not on sale right now',
  chooseVariant: 'Choose a version on the product page',
  variantMissing: 'This version is no longer available',
  tooMany: 'Not that many left',
}

/** The cart, drawn by the site: lines, where to ship, the total and the way to Stripe Checkout. */
export function CartView({
  products,
  regions,
  currency,
}: {
  products: CartProduct[]
  regions: RegionOption[]
  currency: string
}) {
  const cart = useCart()
  const checkout = useCheckout()
  const regionGroup = useId()
  const [regionId, setRegionId] = useState<string>()
  const price = (amount: number) => formatPrice(amount, currency)

  if (!cart.ready) return <p className="muted">Loading your cart…</p>
  if (!cart.lines.length)
    return (
      <p>
        Your cart is empty. <Link href="/">Shop</Link>
      </p>
    )

  const rows = cartRows(cart.lines, products, cart.maxQuantity)
  const subtotal = cartSubtotal(rows)
  const blocked = rows.some((row) => !row.status.available)
  const region = regions.find((candidate) => candidate.id === regionId)
  const {state} = checkout
  const loading = state.status === 'loading'
  const problems = new Map(
    state.status === 'error' ? state.problems.map((problem) => [lineKey(problem), problem]) : [],
  )

  return (
    <>
      <ul className="lines">
        {rows.map(({line, product, status, name, quantity}) => {
          const problem = problems.get(lineKey(line))
          return (
            <li key={lineKey(line)}>
              {product?.imageUrl && <img src={`${product.imageUrl}?w=96`} alt="" />}
              <span className="name">
                {product?.slug ? <Link href={`/shop/${product.slug}`}>{name}</Link> : name}
                {status.available ? (
                  <span>{price(status.price)}</span>
                ) : (
                  <span className="muted">{REASONS[status.reason]}</span>
                )}
                {status.available && problem && (
                  <span className="muted">
                    {REASONS[problem.reason]}
                    {typeof problem.maxQuantity === 'number' &&
                      `: ${problem.maxQuantity} available`}
                  </span>
                )}
              </span>
              {status.available && (
                <fieldset className="quantity" aria-label={`Quantity of ${name}`}>
                  <button
                    type="button"
                    aria-label="One less"
                    onClick={() => cart.setQuantity(line, line.quantity - 1)}
                  >
                    −
                  </button>
                  <span aria-live="polite">{quantity}</span>
                  <button
                    type="button"
                    aria-label="One more"
                    disabled={line.quantity >= status.maxQuantity}
                    onClick={() => cart.setQuantity(line, quantity + 1)}
                  >
                    +
                  </button>
                </fieldset>
              )}
              <button type="button" onClick={() => cart.remove(line)}>
                Remove
              </button>
            </li>
          )
        })}
      </ul>

      <fieldset>
        <legend>Ship to</legend>
        {regions.length === 0 && (
          <p className="muted">
            Shipping isn’t set up yet: publish the shop settings in the Studio.
          </p>
        )}
        {regions.map((option) => (
          <label key={option.id}>
            <input
              type="radio"
              name={regionGroup}
              value={option.id}
              checked={regionId === option.id}
              onChange={() => {
                setRegionId(option.id)
                checkout.reset()
              }}
            />{' '}
            {option.title} ({price(option.rate)})
          </label>
        ))}
      </fieldset>

      <dl className="totals">
        <div>
          <dt>Subtotal</dt>
          <dd>{price(subtotal)}</dd>
        </div>
        <div>
          <dt>Shipping</dt>
          <dd>{region ? price(region.rate) : <span className="muted">Choose above</span>}</dd>
        </div>
        <div className="total">
          <dt>Total</dt>
          <dd>{price(subtotal + (region?.rate ?? 0))}</dd>
        </div>
      </dl>
      <p className="muted">Prices include VAT. You pay on the next page, with Stripe.</p>

      <button
        type="button"
        disabled={blocked || !regions.length || loading}
        onClick={() => checkout.start(regionId)}
      >
        {loading ? 'Going to payment…' : 'Checkout'}
      </button>
      {blocked && <p>Remove what’s no longer available to check out.</p>}
      {state.status === 'error' && (
        <div role="alert">
          <p>{state.message}</p>
          {state.detail && <p className="muted">{state.detail}</p>}
        </div>
      )}
    </>
  )
}
