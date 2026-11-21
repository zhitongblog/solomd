/**
 * #622 — Customizable toolbar items registry.
 *
 * Users can pin any combination of frequent actions onto the top toolbar
 * (which sits to the right of the menubar on Windows when `toolbarInTitlebar`
 * is enabled, freeing the entire tab-bar row for open document tabs).
 */

export type ToolbarItemId =
  | 'viewMode'
  | 'newFile'
  | 'save'
  | 'search'
  | 'export'
  | 'rightSidebar'
  | 'outline'
  | 'inspector'
  | 'insertFrontmatter'
  | 'formatBar'
  | 'focusMode'
  | 'theme'
  | 'gitAdd'
  | 'gitPull'
  | 'gitPush'
  | 'settings'
  | 'more';

export interface ToolbarItemMeta {
  id: ToolbarItemId;
  icon: string;
  labelKey: string;
  /** Group label for the customization modal. */
  group: 'core' | 'writing' | 'git';
}

export const DEFAULT_TOOLBAR_ITEMS: ToolbarItemId[] = [
  'viewMode',
  'search',
  'export',
  'rightSidebar',
  'more',
];

export const ALL_TOOLBAR_ITEMS: ToolbarItemMeta[] = [
  { id: 'viewMode', icon: 'eye', labelKey: 'toolbarCustom.item.viewMode', group: 'core' },
  { id: 'newFile', icon: 'plus', labelKey: 'toolbarCustom.item.newFile', group: 'core' },
  { id: 'save', icon: 'save', labelKey: 'toolbarCustom.item.save', group: 'core' },
  { id: 'search', icon: 'search', labelKey: 'toolbarCustom.item.search', group: 'core' },
  { id: 'export', icon: 'export', labelKey: 'toolbarCustom.item.export', group: 'core' },
  { id: 'rightSidebar', icon: 'sidebar-right', labelKey: 'toolbarCustom.item.rightSidebar', group: 'core' },
  { id: 'outline', icon: 'list', labelKey: 'toolbarCustom.item.outline', group: 'writing' },
  { id: 'inspector', icon: 'info', labelKey: 'toolbarCustom.item.inspector', group: 'writing' },
  { id: 'insertFrontmatter', icon: 'code', labelKey: 'toolbarCustom.item.insertFrontmatter', group: 'writing' },
  { id: 'formatBar', icon: 'type', labelKey: 'toolbarCustom.item.formatBar', group: 'writing' },
  { id: 'focusMode', icon: 'maximize', labelKey: 'toolbarCustom.item.focusMode', group: 'writing' },
  { id: 'theme', icon: 'sun', labelKey: 'toolbarCustom.item.theme', group: 'writing' },
  { id: 'gitAdd', icon: 'plus', labelKey: 'toolbarCustom.item.gitAdd', group: 'git' },
  { id: 'gitPull', icon: 'download', labelKey: 'toolbarCustom.item.gitPull', group: 'git' },
  { id: 'gitPush', icon: 'upload', labelKey: 'toolbarCustom.item.gitPush', group: 'git' },
  { id: 'settings', icon: 'settings', labelKey: 'toolbarCustom.item.settings', group: 'core' },
  { id: 'more', icon: 'more', labelKey: 'toolbarCustom.item.more', group: 'core' },
];

const VALID_IDS = new Set<string>(ALL_TOOLBAR_ITEMS.map((i) => i.id));

export function normalizeToolbarItems(raw: unknown): ToolbarItemId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_TOOLBAR_ITEMS];
  const seen = new Set<ToolbarItemId>();
  const out: ToolbarItemId[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && VALID_IDS.has(item)) {
      const id = item as ToolbarItemId;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}
