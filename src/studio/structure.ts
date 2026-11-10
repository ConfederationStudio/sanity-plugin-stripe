import {CogIcon} from '@sanity/icons/Cog'
import type {ListItemBuilder, StructureBuilder} from 'sanity/structure'

import {SHOP_SETTINGS_ID, SHOP_SETTINGS_TYPE} from '../core/ids'

/**
 * The shop settings as one item in the Studio's structure, opening the one document:
 *
 * ```ts
 * S.list().items([S.documentTypeListItem('product'), shopSettingsListItem(S)])
 * ```
 */
export function shopSettingsListItem(
  S: StructureBuilder,
  title = 'Shop settings',
): ListItemBuilder {
  return S.listItem()
    .title(title)
    .id(SHOP_SETTINGS_ID)
    .icon(CogIcon)
    .child(S.document().schemaType(SHOP_SETTINGS_TYPE).documentId(SHOP_SETTINGS_ID).title(title))
}

/** True for the shop settings type's own list item, to leave it out of `S.documentTypeListItems()`. */
export function isShopSettingsListItem(item: ListItemBuilder): boolean {
  return item.getId() === SHOP_SETTINGS_TYPE
}
