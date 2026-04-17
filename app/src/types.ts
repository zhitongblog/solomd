export type Language = 'markdown' | 'plaintext';
export type ViewMode = 'edit' | 'preview' | 'split';
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
