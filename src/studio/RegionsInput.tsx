import {Button, Card, Flex, Stack, Text} from '@sanity/ui'
import {set, type ArrayOfObjectsInputProps} from 'sanity'

import type {ShippingRegionValue} from './schema/settings'

/**
 * The shipping regions list. While it is empty it offers the regions from the plugin's options.
 * A document's starting values come from its template, and a Studio that keeps the settings to
 * one document usually removes that template, so the offer is made here instead.
 */
export function createRegionsInput(starting: ShippingRegionValue[]) {
  return function RegionsInput(props: ArrayOfObjectsInputProps) {
    const empty = !props.value?.length
    return (
      <Stack gap={3}>
        {empty && starting.length > 0 && !props.readOnly && (
          <Card border padding={3} radius={2}>
            <Flex align="center" gap={3}>
              <Text size={1} style={{flex: 1}}>
                No shipping regions yet. Start from the {starting.length} this Studio was set up
                with, then change the rates.
              </Text>
              <Button
                mode="ghost"
                text="Use the starting regions"
                onClick={() => props.onChange(set(starting))}
              />
            </Flex>
          </Card>
        )}
        {props.renderDefault(props)}
      </Stack>
    )
  }
}
