import {
  cartProductsQuery,
  readCartProducts,
  readShopSettings,
  regionOptions,
  SHOP_SETTINGS_QUERY,
} from 'sanity-plugin-stripe/server'

import {CURRENCY} from '../../../lib/env'
import {reader} from '../../../lib/sanity'
import {CartView} from './CartView'

export const dynamic = 'force-dynamic'

export default async function CartPage() {
  const [products, settings] = await Promise.all([
    reader.fetch(cartProductsQuery()),
    reader.fetch(SHOP_SETTINGS_QUERY),
  ])

  const shop = readShopSettings(settings)

  return (
    <>
      <h1>Cart</h1>
      {/* The same regions the checkout accepts, without their country lists. */}
      <CartView
        products={readCartProducts(products)}
        regions={regionOptions(shop)}
        subscriptionDelivery={shop?.subscriptionDelivery ?? 'free'}
        currency={CURRENCY}
      />
    </>
  )
}
