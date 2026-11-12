import {useMemo} from 'react'
import {useClient} from 'sanity'

import {API_VERSION} from './config'
import {OrdersView} from './orders/OrdersView'
import {routeClient} from './orders/route'

/**
 * The Studio's Orders tab. It asks the site, as the signed-in editor, and the site asks Stripe:
 * the Studio never holds a Stripe key and orders are never written to the dataset.
 */
export function OrdersTool({api}: {api: string}) {
  const client = useClient({apiVersion: API_VERSION})
  const {token} = client.config()
  const route = useMemo(() => routeClient(api, token), [api, token])
  return <OrdersView route={route} api={api} />
}
