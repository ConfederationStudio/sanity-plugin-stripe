import {Card, Flex, Stack, Text, TextInput} from '@sanity/ui'
import {useEffect, useState} from 'react'
import {useClient, useFormValue, type ObjectInputProps} from 'sanity'

import {asArray, isObject} from '../core/guards'
import {publishedId, stockId} from '../core/ids'
import type {ProductStock} from '../core/stock'
import {API_VERSION} from './config'
import {loadStock, parseCount, saveStock, stockFromDocument, stockLeft} from './stock'

/**
 * The price-and-availability field, with the stock boxes under it. The boxes don't belong to the
 * product document: they read and write the product's private stock document, so a count is
 * saved at once and is never part of what a public dataset serves.
 */
export function CommerceInput(props: ObjectInputProps) {
  return (
    <Stack gap={5}>
      {props.renderDefault(props)}
      <StockBoxes commerce={props.value} readOnly={Boolean(props.readOnly)} />
    </Stack>
  )
}

interface VariantRow {
  key: string
  label: string
  soldOut: boolean
}

function readVariants(commerce: unknown): VariantRow[] {
  if (!isObject(commerce)) return []
  return asArray(commerce.variants).flatMap((variant) =>
    isObject(variant) && typeof variant._key === 'string'
      ? [
          {
            key: variant._key,
            label: typeof variant.label === 'string' && variant.label ? variant.label : 'Unnamed',
            soldOut: variant.availability === 'soldOut',
          },
        ]
      : [],
  )
}

function StockBoxes({commerce, readOnly}: {commerce: unknown; readOnly: boolean}) {
  const client = useClient({apiVersion: API_VERSION})
  const documentId = useFormValue(['_id'])
  const productId = typeof documentId === 'string' ? publishedId(documentId) : null
  const [stock, setStock] = useState<ProductStock | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  // Read the counts, and follow them while the form is open: an order lowers them.
  useEffect(() => {
    if (!productId) return undefined
    let live = true
    let changed = false
    const read = async () => {
      const found = await loadStock(client, productId).catch(() => null)
      // A change that arrived while this was on its way is newer than what it found.
      if (!live || changed) return
      if (found) setStock(found)
      setFailure(found ? null : 'The stock counts could not be read.')
    }
    void read()
    const changes = client.listen('*[_id == $id]', {id: stockId(productId)}).subscribe({
      // The event brings the document as it is now. Asking for it again can still get the old one.
      next: (event) => {
        if (!live) return
        changed = true
        setStock(stockFromDocument(productId, event.result))
        setFailure(null)
      },
      error: () => {},
    })
    return () => {
      live = false
      changes.unsubscribe()
    }
  }, [client, productId])

  const save = async (variantKey: string | undefined, count: number | null) => {
    if (!productId || !stock) return
    try {
      await saveStock(client, productId, stock, {
        ...(variantKey === undefined ? {} : {variantKey}),
        count,
      })
      setStock(await loadStock(client, productId))
      setFailure(null)
    } catch {
      setFailure('The count could not be saved. Your role may not allow it.')
    }
  }

  const variants = readVariants(commerce)
  const productSoldOut = isObject(commerce) && commerce.availability === 'soldOut'

  return (
    <Card border padding={3} radius={2}>
      <Stack gap={4}>
        <Stack gap={3}>
          <Text size={1} weight="semibold">
            In stock
          </Text>
          <Text muted size={1}>
            Optional. Leave a box empty to sell without counting. Counts are saved as you leave the
            box and are never public: visitors see on sale or sold out, not a number. They are
            checked at checkout when the site has a Sanity token.
          </Text>
        </Stack>
        {!stock && !failure && (
          <Text muted size={1}>
            Reading the counts…
          </Text>
        )}
        {stock && variants.length === 0 && (
          <StockBox
            label="This product"
            count={stockLeft(stock)}
            disabled={readOnly}
            warn={productSoldOut}
            onSave={(count) => save(undefined, count)}
          />
        )}
        {stock &&
          variants.map((variant) => (
            <StockBox
              key={variant.key}
              label={variant.label}
              count={stockLeft(stock, variant.key)}
              disabled={readOnly}
              warn={productSoldOut || variant.soldOut}
              onSave={(count) => save(variant.key, count)}
            />
          ))}
        {failure && (
          <Card padding={3} radius={2} tone="critical">
            <Text size={1}>{failure}</Text>
          </Card>
        )}
      </Stack>
    </Card>
  )
}

function StockBox(props: {
  label: string
  count: number | null
  disabled: boolean
  /** The product or variant is switched to sold out. */
  warn: boolean
  onSave: (count: number | null) => Promise<void>
}) {
  const {label, count, disabled, warn, onSave} = props
  const saved = count === null ? '' : String(count)
  const [text, setText] = useState(saved)
  const [seen, setSeen] = useState(saved)
  // The saved count changed under the box (an order, another editor): show it.
  if (saved !== seen) {
    setSeen(saved)
    setText(saved)
  }

  const parsed = parseCount(text)
  const commit = () => {
    if (parsed === 'invalid' || text.trim() === saved) return
    void onSave(parsed)
  }

  return (
    <Stack gap={2}>
      <Flex align="center" gap={3}>
        <Text size={1} style={{flex: 1}}>
          {label}
        </Text>
        <div style={{width: '7rem'}}>
          <TextInput
            aria-label={`In stock: ${label}`}
            inputMode="numeric"
            placeholder="Not counted"
            disabled={disabled}
            value={text}
            customValidity={parsed === 'invalid' ? 'A whole number, 0 or more' : ''}
            onChange={(event) => setText(event.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit()
            }}
          />
        </div>
      </Flex>
      {parsed === 'invalid' && (
        <Text size={1} muted>
          Use a whole number, 0 or more.
        </Text>
      )}
      {warn && typeof count === 'number' && count > 0 && (
        <Text size={1} muted>
          {label} has stock again but is switched to sold out. Put it back on sale above.
        </Text>
      )}
    </Stack>
  )
}
