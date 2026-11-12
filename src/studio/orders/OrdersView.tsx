import {ChevronDownIcon} from '@sanity/icons/ChevronDown'
import {ChevronRightIcon} from '@sanity/icons/ChevronRight'
import {CopyIcon} from '@sanity/icons/Copy'
import {LaunchIcon} from '@sanity/icons/Launch'
import {SyncIcon} from '@sanity/icons/Sync'
import {Badge, Box, Button, Card, Container, Flex, Heading, Spinner, Stack, Text} from '@sanity/ui'
import {useToast} from '@sanity/ui/toast'
import {useEffect, useRef, useState, type ReactNode} from 'react'

import {formatMoney} from '../../core/money'
import {addressLines, type OrderDetail, type OrderSummary} from '../../core/orders'
import {addOlder, buyerLabel, countryName, formatWhen, orderBadges, refundLabel} from './format'
import {failureText, type RouteClient} from './route'

interface ListState {
  orders?: OrderSummary[]
  next?: string | null
  failure?: unknown
}

function Fact({label, children}: {label: string; children: ReactNode}) {
  return (
    <Flex gap={3}>
      <Box style={{width: 96, flexShrink: 0}}>
        <Text size={1} muted>
          {label}
        </Text>
      </Box>
      <Box flex={1}>
        {typeof children === 'string' ? <Text size={1}>{children}</Text> : children}
      </Box>
    </Flex>
  )
}

function Line({name, note, amount}: {name: string; note?: string | undefined; amount: string}) {
  return (
    <Flex gap={3} align="flex-start">
      <Box flex={1}>
        <Stack gap={2}>
          <Text size={1}>{name}</Text>
          {note && (
            <Text size={1} muted>
              {note}
            </Text>
          )}
        </Stack>
      </Box>
      <Text size={1} style={{fontVariantNumeric: 'tabular-nums'}}>
        {amount}
      </Text>
    </Flex>
  )
}

function Detail({order, locale}: {order: OrderDetail; locale: string | undefined}) {
  const toast = useToast()
  const money = (minor: number) => formatMoney(minor, order.currency, locale)
  const address = addressLines(order.shipping.name, order.shipping.address)
  const refund = refundLabel(order)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address.join('\n'))
      toast.push({status: 'success', title: 'Address copied'})
    } catch {
      toast.push({status: 'error', title: 'The address could not be copied'})
    }
  }

  return (
    <Stack gap={4}>
      <Card padding={3} radius={2} border>
        <Stack gap={3}>
          {order.items.map((item, index) => (
            <Line
              // oxlint-disable-next-line react/no-array-index-key -- lines have no id and never move
              key={index}
              name={`${item.quantity} × ${item.name}`}
              note={
                item.subscription && order.interval ? `Subscription, ${order.interval}` : undefined
              }
              amount={money(item.amountTotal)}
            />
          ))}
          <Line
            name={order.regionTitle ? `Delivery: ${order.regionTitle}` : 'Delivery'}
            amount={order.amountShipping === 0 ? 'Free' : money(order.amountShipping)}
          />
          <Card borderTop paddingTop={3}>
            <Flex gap={3}>
              <Box flex={1}>
                <Text size={1} weight="medium">
                  Total
                </Text>
              </Box>
              <Text size={1} weight="medium" style={{fontVariantNumeric: 'tabular-nums'}}>
                {money(order.amountTotal)}
              </Text>
            </Flex>
          </Card>
        </Stack>
      </Card>

      {refund && order.amountRefunded !== null && (
        <Card padding={3} radius={2} border tone="caution">
          <Text size={1}>
            {refund}: {money(order.amountRefunded)} was paid back.
          </Text>
        </Card>
      )}
      {order.status === 'unpaid' && (
        <Card padding={3} radius={2} border tone="critical">
          <Text size={1}>
            The payment hasn’t arrived, or it failed. Don’t send this order before Stripe shows it
            as paid.
          </Text>
        </Card>
      )}

      <Stack gap={3}>
        <Fact label="Send to">
          {address.length > 0 ? (
            <Stack gap={2}>
              {address.map((line, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- an address's lines never move
                <Text key={index} size={1}>
                  {index === address.length - 1 && order.shipping.address?.country === line
                    ? (countryName(line, locale) ?? line)
                    : line}
                </Text>
              ))}
            </Stack>
          ) : (
            'No address was given.'
          )}
        </Fact>
        {order.customer.email && (
          <Fact label="Email">
            <Text size={1}>
              <a href={`mailto:${order.customer.email}`}>{order.customer.email}</a>
            </Text>
          </Fact>
        )}
        {order.phone && <Fact label="Phone">{order.phone}</Fact>}
        {order.handledAt && (
          <Fact label="Site">{`Handled the order on ${formatWhen(order.handledAt, locale)}`}</Fact>
        )}
      </Stack>

      <Flex gap={2} wrap="wrap" align="center">
        {address.length > 0 && (
          <Button text="Copy address" icon={CopyIcon} mode="ghost" fontSize={1} onClick={copy} />
        )}
        <Button
          as="a"
          href={order.stripeUrl}
          target="_blank"
          rel="noreferrer"
          text="Open in Stripe"
          iconRight={LaunchIcon}
          mode="ghost"
          fontSize={1}
        />
        <Text size={1} muted>
          Refunds are made in Stripe.
        </Text>
      </Flex>
    </Stack>
  )
}

function Row({
  order,
  first,
  open,
  onToggle,
  route,
  api,
  locale,
}: {
  order: OrderSummary
  first: boolean
  open: boolean
  onToggle: () => void
  route: RouteClient
  api: string
  locale: string | undefined
}) {
  const [detail, setDetail] = useState<{order?: OrderDetail; failure?: unknown}>({})
  const asked = useRef(false)
  const detailId = `stripe-order-${order.id}`

  useEffect(() => {
    if (!open || asked.current) return
    asked.current = true
    route.order(order.id).then(
      (reply) => setDetail({order: reply.order}),
      (failure: unknown) => {
        // Opening the row again asks again.
        asked.current = false
        setDetail({failure})
      },
    )
  }, [open, order.id, route])

  const where = countryName(order.country, locale)
  return (
    <Card borderTop={!first}>
      <Card
        as="button"
        type="button"
        padding={3}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={onToggle}
        style={{width: '100%', textAlign: 'left'}}
      >
        <Flex align="center" gap={3}>
          <Text size={1} muted>
            {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </Text>
          <Box flex={1}>
            <Flex align="center" gap={3} wrap="wrap">
              <Box flex={1} style={{minWidth: 200}}>
                <Stack gap={2}>
                  <Text weight="medium" textOverflow="ellipsis">
                    {buyerLabel(order)}
                  </Text>
                  <Text size={1} muted textOverflow="ellipsis">
                    {[formatWhen(order.createdAt, locale), where].filter(Boolean).join(' · ')}
                  </Text>
                </Stack>
              </Box>
              <Flex align="center" gap={2}>
                {orderBadges(order).map((badge) => (
                  <Badge key={badge.text} tone={badge.tone}>
                    {badge.text}
                  </Badge>
                ))}
                <Box style={{minWidth: 84}}>
                  <Text size={1} align="right" style={{fontVariantNumeric: 'tabular-nums'}}>
                    {formatMoney(order.amountTotal, order.currency, locale)}
                  </Text>
                </Box>
              </Flex>
            </Flex>
          </Box>
        </Flex>
      </Card>
      {open && (
        <Box id={detailId} padding={4} paddingTop={2}>
          {detail.order && <Detail order={detail.order} locale={locale} />}
          {!detail.order && detail.failure !== undefined && (
            <Card padding={3} radius={2} border tone="critical">
              <Text size={1}>{failureText(detail.failure, api)}</Text>
            </Card>
          )}
          {!detail.order && detail.failure === undefined && (
            <Flex justify="center" padding={3}>
              <Spinner muted />
            </Flex>
          )}
        </Box>
      )}
    </Card>
  )
}

/**
 * The shop's orders, newest first, as the site reads them from Stripe at that moment. Opening
 * one shows what to pack and where to send it.
 */
export function OrdersView({
  route,
  api,
  locale,
}: {
  route: RouteClient
  /** Named in messages when the site can't be reached. */
  api: string
  /** For amounts and dates. Default: the browser's. */
  locale?: string
}) {
  const [turn, setTurn] = useState(0)
  const [loaded, setLoaded] = useState<ListState & {route: RouteClient; turn: number}>()
  const [older, setOlder] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const ask = async () => {
      try {
        const reply = await route.orders()
        if (live) setLoaded({route, turn, orders: reply.orders, next: reply.next})
      } catch (failure) {
        if (live) setLoaded({route, turn, failure})
      }
    }
    void ask()
    return () => {
      live = false
    }
  }, [route, turn])

  // What was loaded for another sign-in, or before a refresh, is not shown.
  const state: ListState = loaded?.route === route && loaded.turn === turn ? loaded : {}
  const busy = older || (state.orders === undefined && state.failure === undefined)

  const showOlder = async (before: string) => {
    setOlder(true)
    try {
      const reply = await route.orders(before)
      setLoaded(
        (previous) =>
          previous && {
            route: previous.route,
            turn: previous.turn,
            orders: addOlder(previous.orders ?? [], reply.orders),
            next: reply.next,
          },
      )
    } catch (failure) {
      setLoaded((previous) => previous && {...previous, failure})
    } finally {
      setOlder(false)
    }
  }

  const {orders, next, failure} = state
  return (
    <Container width={2} padding={4} sizing="border">
      <Stack gap={5}>
        <Flex align="center" gap={3} wrap="wrap">
          <Box flex={1} style={{minWidth: 260}}>
            <Stack gap={3}>
              <Heading as="h1" size={2}>
                Orders
              </Heading>
              <Text size={1} muted>
                Read from Stripe as you open this tab. Nothing about a buyer is saved in Sanity.
              </Text>
            </Stack>
          </Box>
          <Button
            text="Refresh"
            icon={SyncIcon}
            mode="ghost"
            disabled={busy}
            onClick={() => {
              setOpen(null)
              setTurn(turn + 1)
            }}
          />
        </Flex>

        {failure !== undefined && (
          <Card padding={3} radius={2} border tone="critical">
            <Text size={1}>{failureText(failure, api)}</Text>
          </Card>
        )}

        {!orders && failure === undefined && (
          <Flex justify="center" padding={5}>
            <Spinner muted />
          </Flex>
        )}

        {orders && orders.length === 0 && (
          <Card padding={4} radius={2} border tone="transparent">
            <Text size={1} muted>
              {next
                ? 'None of the account’s latest payments is an order of this shop.'
                : 'No orders yet. They show here as soon as a checkout is completed.'}
            </Text>
          </Card>
        )}

        {orders && orders.length > 0 && (
          <Card radius={2} border style={{overflow: 'hidden'}}>
            {orders.map((order, index) => (
              <Row
                key={order.id}
                order={order}
                first={index === 0}
                open={open === order.id}
                onToggle={() => setOpen(open === order.id ? null : order.id)}
                route={route}
                api={api}
                locale={locale}
              />
            ))}
          </Card>
        )}

        {orders && next && (
          <Flex justify="center">
            <Button
              text={busy ? 'Loading…' : 'Show older orders'}
              mode="ghost"
              disabled={busy}
              onClick={() => void showOlder(next)}
            />
          </Flex>
        )}
      </Stack>
    </Container>
  )
}
