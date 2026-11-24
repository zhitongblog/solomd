import { LanguageDescription, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { hljsDocumentExtension, resolveHljsLangForFile } from './cm-hljs-fallback';

/**
 * The languages the code editor can actually highlight.
 *
 * `markdown({ codeLanguages })` hands this to lezer, so this array — not any
 * list maintained elsewhere — is the truth for "what a fence language lights
 * up". `fence-languages.ts` derives the ``` completion list from it rather
 * than keeping a second copy that could drift.
 *
 * Also used by `loadPlainLanguageExtension(fileName)` to provide native
 * CodeMirror syntax highlighting when opening non-Markdown text/code files
 * (`.xml`, `.py`, `.json`, `.yaml`, `.js`, `.ts`, `.html`, `.css`, `.rs`, etc.).
 */
export const codeLanguages = [
  LanguageDescription.of({
    name: 'javascript',
    alias: ['js', 'jsx', 'mjs', 'cjs'],
    extensions: ['js', 'jsx', 'mjs', 'cjs'],
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: 'typescript',
    alias: ['ts', 'tsx', 'mts', 'cts'],
    extensions: ['ts', 'tsx', 'mts', 'cts'],
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  }),
  LanguageDescription.of({
    name: 'python',
    alias: ['py', 'py3'],
    extensions: ['py', 'py3', 'pyw', 'pyi'],
    load: () => import('@codemirror/lang-python').then((m) => m.python()),
  }),
  LanguageDescription.of({
    name: 'rust',
    alias: ['rs'],
    extensions: ['rs'],
    load: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  }),
  LanguageDescription.of({
    name: 'html',
    alias: ['htm'],
    extensions: ['html', 'htm', 'vue', 'astro', 'svelte'],
    load: () => import('@codemirror/lang-html').then((m) => m.html()),
  }),
  LanguageDescription.of({
    name: 'css',
    extensions: ['css'],
    load: () => import('@codemirror/lang-css').then((m) => m.css()),
  }),
  LanguageDescription.of({
    name: 'json',
    alias: ['jsonc', 'json5'],
    extensions: ['json', 'jsonc', 'json5', 'webmanifest'],
    load: () => import('@codemirror/lang-json').then((m) => m.json()),
  }),
  LanguageDescription.of({
    name: 'cpp',
    alias: ['c', 'c++', 'cc', 'cxx', 'h', 'hpp', 'hxx'],
    extensions: ['c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'hxx'],
    load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  }),
  LanguageDescription.of({
    name: 'java',
    extensions: ['java'],
    load: () => import('@codemirror/lang-java').then((m) => m.java()),
  }),
  LanguageDescription.of({
    name: 'go',
    alias: ['golang'],
    extensions: ['go'],
    load: () => import('@codemirror/lang-go').then((m) => m.go()),
  }),
  LanguageDescription.of({
    name: 'yaml',
    alias: ['yml'],
    extensions: ['yaml', 'yml'],
    load: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  }),
  LanguageDescription.of({
    name: 'sql',
    alias: ['sqlite', 'postgres', 'mysql'],
    extensions: ['sql'],
    load: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  }),
  LanguageDescription.of({
    name: 'xml',
    alias: ['svg', 'xhtml', 'plist'],
    extensions: ['xml', 'svg', 'xhtml', 'plist', 'xsd', 'xsl', 'xslt', 'wsdl', 'pom', 'csproj', 'fxml', 'rss', 'atom'],
    load: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  }),
];

/**
 * Load a syntax-highlighting CodeMirror extension for a non-Markdown file
 * (e.g. `.xml`, `.py`, `.json`, `.yaml`, `.sh`, `.toml`, `.lua`, `.ini`).
 * Returns `[]` for plain `.txt` / `.log` or unrecognized files.
 */
export async function loadPlainLanguageExtension(fileName: string): Promise<Extension> {
  if (!fileName) return [];
  const desc = LanguageDescription.matchFilename(codeLanguages, fileName);
  if (desc) {
    try {
      const support = await desc.load();
      return [support, syntaxHighlighting(defaultHighlightStyle, { fallback: true })];
    } catch {
      return [];
    }
  }
  const hljsLang = resolveHljsLangForFile(fileName);
  if (hljsLang) {
    return [hljsDocumentExtension(hljsLang)];
  }
  return [];
}
