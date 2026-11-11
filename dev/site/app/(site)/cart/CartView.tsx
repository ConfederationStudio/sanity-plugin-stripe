'use client'

import Link from 'next/link'
import {useId, useState} from 'react'
import {
  cartRows,
  cartSubtotal,
  describeInterval,
  formatPrice,
  lineKey,
  shippingQuote,
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
  noSubscription: 'No longer offered as a subscription',
  tooMany: 'Not that many left',
  otherInterval: 'One checkout takes subscriptions with the same interval only',
}

/** The cart, drawn by the site: lines, where to ship, the total and the way to Stripe Checkout. */
export function CartView({
  products,
  regions,
  subscriptionDelivery,
  currency,
}: {
  products: CartProduct[]
  regions: RegionOption[]
  /** From the shop settings: whether a subscription pays the region's rate with every delivery. */
  subscriptionDelivery: 'free' | 'rate'
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
  // The checkout works delivery out again on the server; this is the same sum, for the buyer.
  // A cart with a subscription pays nothing extra, or the region's rate with every delivery,
  // which then goes by the lines that repeat.
  const repeating = rows.reduce(
    (sum, row) => (row.status.available && row.status.interval ? sum + row.total : sum),
    0,
  )
  const subscribes = rows.some((row) => row.status.available && row.status.interval)
  const quote = (option: RegionOption) =>
    subscribes
      ? subscriptionDelivery === 'rate'
        ? shippingQuote(option, repeating)
        : {amount: 0, missing: null}
      : shippingQuote(option, subtotal)
  const shipping = region ? quote(region) : null
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
                  <span>
                    {price(status.price)}
                    {status.interval && `, ${describeInterval(status.interval)}`}
                  </span>
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
            {option.title} ({quote(option).amount === 0 ? 'free' : price(quote(option).amount)}
            {typeof option.freeFrom === 'number' && `, free from ${price(option.freeFrom)}`})
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
          <dd>
            {shipping ? (
              shipping.amount === 0 ? (
                'Free'
              ) : (
                price(shipping.amount)
              )
            ) : (
              <span className="muted">Choose above</span>
            )}
          </dd>
        </div>
        <div className="total">
          <dt>{subscribes ? 'Due today' : 'Total'}</dt>
          <dd>{price(subtotal + (shipping?.amount ?? 0))}</dd>
        </div>
      </dl>
      {shipping?.missing ? (
        <p className="muted">{price(shipping.missing)} more for free delivery.</p>
      ) : null}
      {subscribes && (
        <p className="muted">
          What you subscribe to is charged again with each delivery, until you cancel.
        </p>
      )}
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
