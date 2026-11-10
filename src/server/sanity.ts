/**
 * As much of a Sanity client as the plugin uses, so `/server` needs no Sanity package of its own.
 * A client from `@sanity/client` or `next-sanity` fits both.
 */

/** Reads products and the shop settings. Use one that skips the CDN: `useCdn: false`. */
export interface SanityReader {
  fetch(query: string, params?: Record<string, unknown>): Promise<unknown>
}

export interface SanityTransaction {
  create(document: {_id: string; _type: string; [field: string]: unknown}): SanityTransaction
  patch(
    documentId: string,
    operations: {dec?: Record<string, number>; set?: Record<string, unknown>},
  ): SanityTransaction
  commit(): Promise<unknown>
}

/** Lowers stock counts. It needs a token that can write: an Editor token is enough. */
export interface SanityWriter extends SanityReader {
  transaction(): SanityTransaction
  /** When the client has it, the plugin asks for drafts too: `perspective: 'raw'`. */
  withConfig?(config: {perspective: 'raw'; useCdn: false}): SanityWriter
}
