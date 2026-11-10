/**
 * As much of a Sanity client as the plugin uses, so `/server` needs no Sanity package of its own.
 * A client from `@sanity/client` or `next-sanity` fits all three.
 */

/** What the plugin asks of a client that can see private documents: everything, uncached. */
export interface RawConfig {
  perspective: 'raw'
  useCdn: false
  apiVersion: string
}

/** Reads from Sanity. For products and the shop settings, use one that skips the CDN. */
export interface SanityReader {
  fetch(query: string, params?: Record<string, unknown>): Promise<unknown>
  /** When the client has it, the plugin asks for the raw perspective to read stock. */
  withConfig?(config: RawConfig): SanityReader
}

export interface SanityTransaction {
  create(document: {_id: string; _type: string; [field: string]: unknown}): SanityTransaction
  patch(
    documentId: string,
    operations: {dec?: Record<string, number>; set?: Record<string, unknown>},
  ): SanityTransaction
  delete(documentId: string): SanityTransaction
  commit(): Promise<unknown>
}

/** Reads and lowers stock counts. It needs a token that can write: Editor rights are enough. */
export interface SanityWriter extends SanityReader {
  transaction(): SanityTransaction
  withConfig?(config: RawConfig): SanityWriter
}

/**
 * Stock documents and every version of a product are only visible with a token, the raw
 * perspective and an API version that knows Content Releases.
 */
const RAW: RawConfig = {perspective: 'raw', useCdn: false, apiVersion: '2025-02-19'}

export function rawReader(client: SanityReader): SanityReader {
  return client.withConfig?.(RAW) ?? client
}

export function rawWriter(client: SanityWriter): SanityWriter {
  return client.withConfig?.(RAW) ?? client
}
