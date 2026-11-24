/**
 * #622 — Customizable toolbar items registry.
 *
 * Users can pin any combination of frequent actions onto the top toolbar
 * (which sits to the right of the menubar on Windows when `toolbarInTitlebar`
 * is enabled, freeing the entire tab-bar row for open document tabs).
 */

export type BuiltinToolbarItemId =
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

/**
 * #665 — Built-in toolbar item OR any command palette command prefixed with `cmd:`.
 */
export type ToolbarItemId = BuiltinToolbarItemId | `cmd:${string}`;

export interface ToolbarItemMeta {
  id: BuiltinToolbarItemId;
  icon: string;
  labelKey: string;
  /** Group label for the customization modal. */
  group: 'core' | 'writing' | 'git';
}

export const DEFAULT_TOOLBAR_ITEMS: BuiltinToolbarItemId[] = [
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

/** #665 — Icon choices available in the custom toolbar icon picker. */
export const TOOLBAR_ICON_OPTIONS: string[] = [
  'sparkles',
  'upload',
  'download',
  'export',
  'file',
  'folder',
  'save',
  'search',
  'code',
  'list',
  'type',
  'eye',
  'sun',
  'settings',
  'plus',
  'info',
  'maximize',
  'sidebar-right',
  'bookmark',
  'terminal',
];

/** Map any command ID (`sync.webdavPush`, `export.html`, etc.) to a sensible default icon. */
export function defaultIconForCommand(cmdId: string): string {
  const id = cmdId.toLowerCase();
  if (id.includes('push') || id.includes('upload')) return 'upload';
  if (id.includes('pull') || id.includes('download')) return 'download';
  if (id.startsWith('export.')) return 'export';
  if (id.includes('search') || id.includes('find')) return 'search';
  if (id.includes('save')) return 'save';
  if (id.includes('new') || id.includes('create') || id.includes('add')) return 'plus';
  if (id.startsWith('fmt.') || id.startsWith('cn.')) return 'type';
  if (id.includes('code') || id.includes('snippet') || id.includes('frontmatter')) return 'code';
  if (id.includes('outline') || id.includes('list') || id.includes('toc')) return 'list';
  if (id.includes('theme')) return 'sun';
  if (id.includes('focus') || id.includes('zen')) return 'maximize';
  if (id.includes('setting')) return 'settings';
  if (id.startsWith('view.')) return 'eye';
  if (id.startsWith('file.') || id.startsWith('daily.')) return 'file';
  return 'sparkles';
}

/** Derive a user-facing category key from a command palette ID. */
export function commandCategoryOf(cmdId: string): string {
  const prefix = cmdId.split('.')[0] || 'other';
  if (prefix === 'file' || prefix === 'daily' || prefix === 'inbox') return 'file';
  if (prefix === 'fmt' || prefix === 'cn' || prefix === 'editor' || prefix === 'fold') return 'edit';
  if (prefix === 'view' || prefix === 'pane' || prefix === 'window') return 'view';
  if (prefix === 'export') return 'export';
  if (prefix === 'sync' || prefix === 'history') return 'sync';
  if (prefix === 'ai' || prefix === 'agent') return 'ai';
  return 'tools';
}

const VALID_IDS = new Set<string>(ALL_TOOLBAR_ITEMS.map((i) => i.id));

export function normalizeToolbarItems(raw: unknown): ToolbarItemId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_TOOLBAR_ITEMS];
  const seen = new Set<ToolbarItemId>();
  const out: ToolbarItemId[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && (VALID_IDS.has(item) || (item.startsWith('cmd:') && item.length > 4))) {
      const id = item as ToolbarItemId;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}
