export type Language = 'markdown' | 'plaintext';
// `liveEdit` (v2.3) renders markdown formatting inline inside the editor —
// Typora / Obsidian Live Preview style. The editor IS the only pane in
// this mode; there is no separate preview column.
//
// `reading` (v2.4) is a full-bleed serif preview without any editor chrome:
// no toolbar, no file tree, no status bar — just the centered prose, like
// a book page. Toggled via Cmd+Shift+R / the toolbar's view-mode cycle,
// auto-applies on iOS when the `readingByDefaultOnMobile` setting is on.
export type ViewMode = 'edit' | 'preview' | 'split' | 'liveEdit' | 'reading';
export type Theme =
  | 'light'
  | 'dark'
  | 'nord'
  | 'solarized-light'
  | 'solarized-dark'
  | 'monokai'
  | 'github-light'
  | 'dracula';

export interface Tab {
  id: string;
  filePath?: string;
  fileName: string;
  content: string;
  savedContent: string;
  encoding: string;
  language: Language;
  hadBom: boolean;
  showOutline?: boolean;
}

export interface FileReadResult {
  content: string;
  encoding: string;
  language: Language;
  had_bom: boolean;
}

// ---- Tile layout (split editor) ----

export type SplitDirection = 'horizontal' | 'vertical';

export interface TileLeaf {
  type: 'leaf';
  id: string;
  activeTabId: string;
}

export interface TileBranch {
  type: 'branch';
  id: string;
  direction: SplitDirection;
  sizes: [number, number]; // percentages summing to 100
  children: [TileNode, TileNode];
}

export type TileNode = TileLeaf | TileBranch;
