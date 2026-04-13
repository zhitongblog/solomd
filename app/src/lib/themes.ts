import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { Extension } from '@codemirror/state';

function mkTheme(
  bg: string,
  fg: string,
  gutter: string,
  selection: string,
  cursor: string,
  highlights: Record<string, string>,
): Extension {
  const theme = EditorView.theme(
    {
      '&': { backgroundColor: bg, color: fg },
      '.cm-content': { caretColor: cursor },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: cursor },
      '.cm-selectionBackground, ::selection': { backgroundColor: `${selection} !important` },
      '.cm-gutters': { backgroundColor: bg, color: gutter, border: 'none' },
      '.cm-activeLineGutter': { color: cursor },
    },
    { dark: isDark(bg) },
  );

  const hl = HighlightStyle.define([
    { tag: t.keyword, color: highlights.keyword },
    { tag: [t.name, t.deleted, t.character, t.macroName], color: highlights.variable || fg },
    { tag: [t.function(t.variableName), t.labelName], color: highlights.function },
    { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: highlights.constant || highlights.keyword },
    { tag: [t.definition(t.name), t.separator], color: fg },
    { tag: [t.typeName, t.className, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: highlights.type },
    { tag: [t.number, t.bool], color: highlights.number },
    { tag: [t.string, t.special(t.brace)], color: highlights.string },
    { tag: [t.comment, t.lineComment, t.blockComment], color: highlights.comment, fontStyle: 'italic' },
    { tag: t.meta, color: highlights.meta || highlights.comment },
    { tag: t.link, color: highlights.link || highlights.string, textDecoration: 'underline' },
    { tag: t.heading, color: highlights.heading || highlights.keyword, fontWeight: 'bold' },
    { tag: [t.atom, t.special(t.variableName)], color: highlights.atom || highlights.function },
    { tag: t.invalid, color: highlights.invalid || '#ff0000' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: t.processingInstruction, color: highlights.meta || highlights.comment },
    { tag: t.propertyName, color: highlights.property || highlights.function },
    { tag: t.operator, color: highlights.operator || fg },
    { tag: t.punctuation, color: highlights.punctuation || fg },
  ]);

  return [theme, syntaxHighlighting(hl)];
}

function isDark(bg: string): boolean {
  const hex = bg.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

// ============================================================
// Themes — inspired by popular editors
// ============================================================

export const nordTheme = mkTheme(
  '#2e3440', '#d8dee9', '#4c566a', 'rgba(136,192,208,0.2)', '#88c0d0',
  {
    keyword: '#81a1c1', string: '#a3be8c', number: '#b48ead', comment: '#616e88',
    function: '#88c0d0', variable: '#d8dee9', type: '#8fbcbb', property: '#88c0d0',
    heading: '#81a1c1', operator: '#81a1c1', punctuation: '#eceff4',
  },
);

export const solarizedLightTheme = mkTheme(
  '#fdf6e3', '#657b83', '#93a1a1', 'rgba(38,139,210,0.15)', '#268bd2',
  {
    keyword: '#859900', string: '#2aa198', number: '#d33682', comment: '#93a1a1',
    function: '#268bd2', variable: '#657b83', type: '#b58900', property: '#268bd2',
    heading: '#cb4b16', operator: '#657b83', punctuation: '#586e75',
  },
);

export const solarizedDarkTheme = mkTheme(
  '#002b36', '#839496', '#586e75', 'rgba(38,139,210,0.2)', '#268bd2',
  {
    keyword: '#859900', string: '#2aa198', number: '#d33682', comment: '#586e75',
    function: '#268bd2', variable: '#839496', type: '#b58900', property: '#268bd2',
    heading: '#cb4b16', operator: '#839496', punctuation: '#93a1a1',
  },
);

export const monokaiTheme = mkTheme(
  '#272822', '#f8f8f2', '#75715e', 'rgba(249,38,114,0.18)', '#f92672',
  {
    keyword: '#f92672', string: '#e6db74', number: '#ae81ff', comment: '#75715e',
    function: '#a6e22e', variable: '#f8f8f2', type: '#66d9ef', property: '#a6e22e',
    heading: '#f92672', operator: '#f92672', punctuation: '#f8f8f2',
    constant: '#ae81ff',
  },
);

export const githubLightTheme = mkTheme(
  '#ffffff', '#24292e', '#babbbc', 'rgba(3,102,214,0.12)', '#0366d6',
  {
    keyword: '#d73a49', string: '#032f62', number: '#005cc5', comment: '#6a737d',
    function: '#6f42c1', variable: '#24292e', type: '#e36209', property: '#005cc5',
    heading: '#005cc5', operator: '#d73a49', punctuation: '#24292e',
  },
);

export const draculaTheme = mkTheme(
  '#282a36', '#f8f8f2', '#6272a4', 'rgba(189,147,249,0.18)', '#bd93f9',
  {
    keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', comment: '#6272a4',
    function: '#50fa7b', variable: '#f8f8f2', type: '#8be9fd', property: '#50fa7b',
    heading: '#ff79c6', operator: '#ff79c6', punctuation: '#f8f8f2',
    constant: '#bd93f9',
  },
);

// Map theme name → CodeMirror extension (empty = use CSS vars only)
import { oneDark } from '@codemirror/theme-one-dark';
import type { Theme } from '../types';

export function cmThemeFor(theme: Theme): Extension {
  switch (theme) {
    case 'dark': return oneDark;
    case 'nord': return nordTheme;
    case 'solarized-light': return solarizedLightTheme;
    case 'solarized-dark': return solarizedDarkTheme;
    case 'monokai': return monokaiTheme;
    case 'github-light': return githubLightTheme;
    case 'dracula': return draculaTheme;
    default: return [];
  }
}

// Map theme → CSS data-theme value (for shell CSS vars)
export function dataThemeFor(theme: Theme): string {
  switch (theme) {
    case 'dark':
    case 'nord':
    case 'solarized-dark':
    case 'monokai':
    case 'dracula':
      return 'dark';
    default:
      return 'light';
  }
}

export const themeLabels: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light (Default)' },
  { value: 'dark', label: 'Dark (One Dark)' },
  { value: 'nord', label: 'Nord' },
  { value: 'solarized-light', label: 'Solarized Light' },
  { value: 'solarized-dark', label: 'Solarized Dark' },
  { value: 'monokai', label: 'Monokai' },
  { value: 'github-light', label: 'GitHub Light' },
  { value: 'dracula', label: 'Dracula' },
];
