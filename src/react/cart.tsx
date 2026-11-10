import {
  createContext,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

import {lineKey, MAX_QUANTITY, sanitizeLines, type CartLine} from '../core/cart'

/**
 * The cart lives in localStorage, so it survives reloads and stays in step across tabs.
 * It holds product references and quantities only; prices are always read again at checkout.
 */

const EMPTY: CartLine[] = []

interface CartStore {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => CartLine[]
  getServerSnapshot: () => CartLine[]
  set: (next: CartLine[]) => void
}

function createCartStore(storageKey: string, max: number): CartStore {
  let lines = EMPTY
  let loaded = false
  const listeners = new Set<() => void>()
  // An empty cart is always the same array, so clearing an empty cart doesn't re-render.
  const clean = (input: unknown) => {
    const result = sanitizeLines(input, max)
    return result.length ? result : EMPTY
  }

  const read = () => {
    try {
      lines = clean(JSON.parse(window.localStorage.getItem(storageKey) ?? '[]'))
    } catch {
      lines = EMPTY
    }
    loaded = true
  }
  const emit = () => listeners.forEach((listener) => listener())
  // Another tab changed the cart.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey) return
    read()
    emit()
  }

  return {
    subscribe(listener) {
      if (listeners.size === 0) window.addEventListener('storage', onStorage)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) window.removeEventListener('storage', onStorage)
      }
    },
    getSnapshot() {
      if (!loaded) read()
      return lines
    },
    getServerSnapshot: () => EMPTY,
    set(next) {
      lines = clean(next)
      loaded = true
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(lines))
      } catch {
        // Private browsing or full storage: the cart still works until the page closes.
      }
      emit()
    },
  }
}

const CartContext = createContext<{store: CartStore; max: number} | null>(null)

export interface CartProviderProps {
  children: ReactNode
  /** localStorage key. Change it to start everyone with an empty cart. Default `cart`. */
  storageKey?: string
  /** Most of one item a buyer can order at once. Default 10. */
  maxQuantity?: number
}

/** Holds the cart for everything inside it. Put it in the site's layout. */
export function CartProvider({
  children,
  storageKey = 'cart',
  maxQuantity = MAX_QUANTITY,
}: CartProviderProps) {
  const [store] = useState(() => createCartStore(storageKey, maxQuantity))
  const value = useMemo(() => ({store, max: maxQuantity}), [store, maxQuantity])
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

type LineRef = Pick<CartLine, 'productId' | 'variantKey'>

export interface Cart {
  lines: CartLine[]
  /** Number of items, counting quantities. */
  count: number
  /** False during server rendering and hydration, before the stored cart has been read. */
  ready: boolean
  /** Most of one item a buyer can order at once. */
  maxQuantity: number
  /** Adds to the line for this product and variant. `limit` caps the total, for example at the stock count. */
  add: (line: CartLine, limit?: number) => void
  setQuantity: (line: LineRef, quantity: number) => void
  remove: (line: LineRef) => void
  clear: () => void
}

const subscribeNothing = () => () => {}

/** The cart, and the ways to change it. Needs a `<CartProvider>` higher up the tree. */
export function useCart(): Cart {
  const context = useContext(CartContext)
  if (!context) throw new Error('useCart needs a <CartProvider> higher up the tree.')
  const {store, max} = context
  const lines = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
  const ready = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  )

  return useMemo(() => {
    const current = () => store.getSnapshot()
    const same = (a: LineRef, b: LineRef) => lineKey(a) === lineKey(b)
    /** The cart with one line's quantity changed. */
    const withQuantity = (line: LineRef, quantity: number) =>
      current().map((candidate) =>
        same(candidate, line) ? Object.assign({}, candidate, {quantity}) : candidate,
      )
    return {
      lines,
      count: lines.reduce((sum, line) => sum + line.quantity, 0),
      ready,
      maxQuantity: max,
      add(line, limit = max) {
        const existing = current().find((candidate) => same(candidate, line))
        const quantity = Math.min((existing?.quantity ?? 0) + line.quantity, limit, max)
        if (quantity < 1) return
        store.set(existing ? withQuantity(line, quantity) : [...current(), {...line, quantity}])
      },
      setQuantity(line, quantity) {
        if (quantity < 1) {
          store.set(current().filter((candidate) => !same(candidate, line)))
          return
        }
        store.set(withQuantity(line, Math.min(quantity, max)))
      },
      remove(line) {
        store.set(current().filter((candidate) => !same(candidate, line)))
      },
      clear() {
        store.set(EMPTY)
      },
    }
  }, [lines, ready, store, max])
}
