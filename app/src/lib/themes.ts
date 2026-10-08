import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { Extension, Prec } from '@codemirror/state';

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
      // 5.0 §5 — selection is the accent wash for every theme (--accent-soft
      // derives from each theme's --accent); `selection` stays as a fallback.
      '.cm-selectionBackground, ::selection': { backgroundColor: `var(--accent-soft, ${selection}) !important` },
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

// Startup trim: each built-in theme builds a CodeMirror StyleModule and a
// HighlightStyle. Only the active one is ever needed, so they're built on
// first use (and cached, so the Extension identity stays stable across
// reconfigures) instead of all six at module load.
function lazyTheme(build: () => Extension): () => Extension {
  let ext: Extension | null = null;
  return () => (ext ??= build());
}

// ============================================================
// Themes — inspired by popular editors
// ============================================================

const nordTheme = lazyTheme(() => mkTheme(
  '#2e3440', '#d8dee9', '#4c566a', 'rgba(136,192,208,0.2)', '#88c0d0',
  {
    keyword: '#81a1c1', string: '#a3be8c', number: '#b48ead', comment: '#616e88',
    function: '#88c0d0', variable: '#d8dee9', type: '#8fbcbb', property: '#88c0d0',
    heading: '#81a1c1', operator: '#81a1c1', punctuation: '#eceff4',
  },
));

const solarizedLightTheme = lazyTheme(() => mkTheme(
  '#fdf6e3', '#657b83', '#93a1a1', 'rgba(38,139,210,0.15)', '#268bd2',
  {
    keyword: '#859900', string: '#2aa198', number: '#d33682', comment: '#93a1a1',
    function: '#268bd2', variable: '#657b83', type: '#b58900', property: '#268bd2',
    heading: '#cb4b16', operator: '#657b83', punctuation: '#586e75',
  },
));

const solarizedDarkTheme = lazyTheme(() => mkTheme(
  '#002b36', '#839496', '#586e75', 'rgba(38,139,210,0.2)', '#268bd2',
  {
    keyword: '#859900', string: '#2aa198', number: '#d33682', comment: '#586e75',
    function: '#268bd2', variable: '#839496', type: '#b58900', property: '#268bd2',
    heading: '#cb4b16', operator: '#839496', punctuation: '#93a1a1',
  },
));

const monokaiTheme = lazyTheme(() => mkTheme(
  '#272822', '#f8f8f2', '#75715e', 'rgba(249,38,114,0.18)', '#f92672',
  {
    keyword: '#f92672', string: '#e6db74', number: '#ae81ff', comment: '#75715e',
    function: '#a6e22e', variable: '#f8f8f2', type: '#66d9ef', property: '#a6e22e',
    heading: '#f92672', operator: '#f92672', punctuation: '#f8f8f2',
    constant: '#ae81ff',
  },
));

const githubLightTheme = lazyTheme(() => mkTheme(
  '#ffffff', '#24292e', '#babbbc', 'rgba(3,102,214,0.12)', '#0366d6',
  {
    keyword: '#d73a49', string: '#032f62', number: '#005cc5', comment: '#6a737d',
    function: '#6f42c1', variable: '#24292e', type: '#e36209', property: '#005cc5',
    heading: '#005cc5', operator: '#d73a49', punctuation: '#24292e',
  },
));

const draculaTheme = lazyTheme(() => mkTheme(
  '#282a36', '#f8f8f2', '#6272a4', 'rgba(189,147,249,0.18)', '#bd93f9',
  {
    keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', comment: '#6272a4',
    function: '#50fa7b', variable: '#f8f8f2', type: '#8be9fd', property: '#50fa7b',
    heading: '#ff79c6', operator: '#ff79c6', punctuation: '#f8f8f2',
    constant: '#bd93f9',
  },
));

// Map theme name → CodeMirror extension (empty = use CSS vars only)
import { oneDark } from '@codemirror/theme-one-dark';
import type { Theme } from '../types';

/** Which half of a light/dark pair a built-in theme belongs to. */
export function themeFamily(theme: Theme): 'light' | 'dark' {
  switch (theme) {
    case 'light':
    case 'github-light':
    case 'solarized-light':
      return 'light';
    default:
      return 'dark';
  }
}

/**
 * Mermaid's built-in theme for a SoloMD theme: 'dark' for every dark theme
 * (Nord, Dracula, Monokai, Solarized Dark…), not only the one named "dark".
 * Live edit, the Windows editor and preview all use this, so a diagram looks
 * the same in each (#354).
 */
export function mermaidThemeFor(theme: Theme): 'dark' | 'default' {
  return themeFamily(theme) === 'dark' ? 'dark' : 'default';
}

/**
 * With a custom CSS theme active, only the light/dark family of the built-in
 * choice survives (#346). Marketplace themes key their palette on `:root`,
 * `:root[data-theme="light"]` and `:root[data-theme="dark"]`. Every other
 * built-in writes its own name into data-theme ("github-light", "nord", …),
 * and the app's `:root[data-theme="<name>"]` palette out-ranks a bare `:root`.
 * The app's colours won while the theme's unscoped component rules painted
 * dark panels, so text went dark on dark. The built-in's CodeMirror theme also
 * kept its own white editor background.
 */
// 5.0 §2 — the default dark theme keeps One Dark's syntax colours but sits on
// the app's own surface (--bg #1C1C1E), not One Dark's blue-grey #282c34,
// which read as a different window from the header and sidebar around it.
let darkSurface: Extension | null = null;
function oneDarkOnAppSurface(): Extension {
  darkSurface ??= [
    oneDark,
    Prec.high(
      EditorView.theme(
        {
          '&': { backgroundColor: 'var(--bg)', color: 'var(--text)' },
          '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--text-3)', border: 'none' },
        },
        { dark: true },
      ),
    ),
  ];
  return darkSurface;
}

export function cmThemeFor(theme: Theme, customTheme = false): Extension {
  if (customTheme) return themeFamily(theme) === 'dark' ? oneDarkOnAppSurface() : [];
  switch (theme) {
    case 'dark': return oneDarkOnAppSurface();
    case 'nord': return nordTheme();
    case 'solarized-light': return solarizedLightTheme();
    case 'solarized-dark': return solarizedDarkTheme();
    case 'monokai': return monokaiTheme();
    case 'github-light': return githubLightTheme();
    case 'dracula': return draculaTheme();
    default: return [];
  }
}

// Each theme gets its own data-theme value so the UI shell (toolbar, tabs,
// status bar) can style itself with theme-specific CSS variables.
export function dataThemeFor(theme: Theme, customTheme = false): string {
  return customTheme ? themeFamily(theme) : theme;
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

/**
 * D6 — the theme choices as offered in Settings and the View › Theme menu:
 * "System" (follow the OS appearance) first, then every built-in theme, with
 * the two generic names localized (the rest are proper names).
 */
export function themeOptions(t: (key: string) => string): { value: Theme | 'system'; label: string }[] {
  return [
    { value: 'system', label: t('settings.themeSystem') },
    ...themeLabels.map((th) =>
      th.value === 'light'
        ? { ...th, label: t('settings.themeLight') }
        : th.value === 'dark'
          ? { ...th, label: t('settings.themeDark') }
          : th,
    ),
  ];
}
