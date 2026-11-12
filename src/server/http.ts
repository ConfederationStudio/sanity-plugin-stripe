/**
 * The global `fetch`, called through a wrapper: some runtimes (Cloudflare's among them) refuse a
 * `fetch` taken off the global and called on its own.
 */
export const globalFetch: typeof fetch = (input, init) => fetch(input, init)

/** A secret's SHA-256 in hex, so a cache can tell secrets apart without holding them. */
export async function fingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A JSON answer nobody caches: an editor expects what Stripe holds now. */
export function reply(status: number, body: unknown, headers?: HeadersInit): Response {
  const all = new Headers(headers)
  all.set('content-type', 'application/json; charset=utf-8')
  all.set('cache-control', 'no-store')
  return new Response(JSON.stringify(body), {status, headers: all})
}

/** The Studio's origins as written, each reduced to scheme, host and port. */
export function originSet(origins: readonly string[]): Set<string> {
  const set = new Set<string>()
  for (const origin of origins) {
    if (!URL.canParse(origin)) throw new TypeError(`Not an origin: ${origin}`)
    set.add(new URL(origin).origin)
  }
  return set
}

/**
 * The routes' CORS headers. Only the Studio's origins may read their answers; a request without
 * an origin comes from the same site or from a server, and gets none.
 */
export function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({vary: 'Origin'})
  if (origin) {
    headers.set('access-control-allow-origin', origin)
    headers.set('access-control-allow-methods', 'GET, OPTIONS')
    headers.set('access-control-allow-headers', 'authorization, content-type')
    headers.set('access-control-max-age', '600')
  }
  return headers
}
