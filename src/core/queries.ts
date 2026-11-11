import {SHOP_SETTINGS_ID, SHOP_SETTINGS_TYPE} from './ids'

/** Where a site keeps its products, for the queries the plugin writes. */
export interface ProductQueryOptions {
  /** Document types that can be bought. Default `['product']`. */
  types?: readonly string[]
  /** The name of the `stripeCommerce` field on those types. Default `commerce`. */
  field?: string
  /** GROQ for the product's name. Default `title`. */
  title?: string
  /** GROQ for the product's slug. Default `slug.current`. */
  slug?: string
  /** GROQ for the URL of the image shown in the cart and on Stripe's page. */
  image?: string
}

const NAME = /^[A-Za-z_]\w*$/
const TYPE_NAME = /^[A-Za-z_][\w.-]*$/

/** The options with their defaults, checked: names end up inside GROQ. */
export function resolveProductQuery(options: ProductQueryOptions = {}) {
  const types = options.types?.length ? [...options.types] : ['product']
  const field = options.field ?? 'commerce'
  for (const type of types) {
    if (!TYPE_NAME.test(type))
      throw new TypeError(`sanity-plugin-stripe: "${type}" is not a document type name`)
  }
  if (!NAME.test(field)) throw new TypeError(`sanity-plugin-stripe: "${field}" is not a field name`)
  return {
    types,
    field,
    title: options.title ?? 'title',
    slug: options.slug ?? 'slug.current',
    image:
      options.image ?? 'coalesce(images[0].asset->url, image.asset->url, mainImage.asset->url)',
  }
}

const typeFilter = (types: readonly string[]) =>
  `_type in [${types.map((type) => JSON.stringify(type)).join(', ')}]`

/** The price-and-availability field as the cart and the checkout read it. No stock counts. */
export const COMMERCE_PROJECTION = `{availability, price, taxClass, variants[]{_key, label, availability}, subscription{enabled, price, every, unit}}`

/**
 * What the cart and the checkout need of a product, for the site's own queries:
 *
 * ```ts
 * defineQuery(`*[_type == "product"]{${cartProductProjection()}}`)
 * ```
 */
export function cartProductProjection(options?: ProductQueryOptions): string {
  const {field, title, slug, image} = resolveProductQuery(options)
  return `_id, "title": ${title}, "slug": ${slug}, "imageUrl": ${image}, "commerce": ${field}${COMMERCE_PROJECTION}`
}

/** Every product that has the commerce field filled in, for the cart page. */
export function cartProductsQuery(options?: ProductQueryOptions): string {
  const {types, field} = resolveProductQuery(options)
  return `*[${typeFilter(types)} && defined(${field})]{${cartProductProjection(options)}}`
}

/** The products with the ids in `$ids`, for the checkout. */
export function checkoutProductsQuery(options?: ProductQueryOptions): string {
  const {types} = resolveProductQuery(options)
  return `*[${typeFilter(types)} && _id in $ids]{${cartProductProjection(options)}}`
}

/**
 * Every version of the products in `productIds` (published, draft, and copies inside a Content
 * Release), with the keys of its variants: what the webhook marks sold out. It needs the raw
 * perspective, a token, and API version 2025-02-19 or later.
 */
export function productVersionsQuery(
  productIds: readonly string[],
  options?: ProductQueryOptions,
): {query: string; params: Record<string, string>} {
  const {types, field} = resolveProductQuery(options)
  const params: Record<string, string> = {}
  const anyVersion = productIds.map((id, index) => {
    params[`product${index}`] = id
    return `sanity::versionOf($product${index})`
  })
  return {
    query: `*[${typeFilter(types)} && defined(${field}) && (${anyVersion.join(' || ') || 'false'})]{_id, "variants": ${field}.variants[]._key}`,
    params,
  }
}

/** The shop settings: shipping regions, selling out at 0, and delivery for subscriptions. */
export const SHOP_SETTINGS_QUERY = `*[_type == "${SHOP_SETTINGS_TYPE}" && _id == "${SHOP_SETTINGS_ID}"][0]{shippingRegions[]{_key, title, everywhereElse, countries, rate, freeFrom}, autoSoldOut, subscriptionDelivery}`
