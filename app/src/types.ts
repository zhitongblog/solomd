export type Language = 'markdown' | 'plaintext';
// `liveEdit` (v2.3) renders markdown formatting inline inside the editor —
// Typora / Obsidian Live Preview style. The editor IS the only pane in
// this mode; there is no separate preview column.
export type ViewMode = 'edit' | 'preview' | 'split' | 'liveEdit';
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
