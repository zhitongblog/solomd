import { LanguageDescription } from '@codemirror/language';

/**
 * The languages the code editor can actually highlight.
 *
 * `markdown({ codeLanguages })` hands this to lezer, so this array — not any
 * list maintained elsewhere — is the truth for "what a fence language lights
 * up". `fence-languages.ts` derives the ``` completion list from it rather
 * than keeping a second copy that could drift.
 *
 * Moved out of `Editor.vue` for exactly that reason (issue #297). Same
 * entries, same order, same supports.
 *
 * Startup trim: the grammars are loaded on demand (`load`, CodeMirror's own
 * mechanism for this) instead of imported up front. Thirteen lezer parse
 * tables were deserialized on every launch — on the Windows native editor,
 * which never uses CodeMirror, for nothing. lang-markdown asks for a
 * grammar the first time a fence names it and re-highlights that block when
 * it arrives; after that it is cached here like before.
 */
export const codeLanguages = [
  LanguageDescription.of({
    name: 'javascript',
    alias: ['js', 'jsx', 'mjs', 'cjs'],
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: 'typescript',
    alias: ['ts', 'tsx', 'mts', 'cts'],
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  }),
  LanguageDescription.of({ name: 'python', alias: ['py', 'py3'], load: () => import('@codemirror/lang-python').then((m) => m.python()) }),
  LanguageDescription.of({ name: 'rust', alias: ['rs'], load: () => import('@codemirror/lang-rust').then((m) => m.rust()) }),
  LanguageDescription.of({ name: 'html', alias: ['htm'], load: () => import('@codemirror/lang-html').then((m) => m.html()) }),
  LanguageDescription.of({ name: 'css', load: () => import('@codemirror/lang-css').then((m) => m.css()) }),
  LanguageDescription.of({ name: 'json', alias: ['jsonc', 'json5'], load: () => import('@codemirror/lang-json').then((m) => m.json()) }),
  LanguageDescription.of({ name: 'cpp', alias: ['c', 'c++', 'cc', 'cxx', 'h', 'hpp', 'hxx'], load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()) }),
  LanguageDescription.of({ name: 'java', load: () => import('@codemirror/lang-java').then((m) => m.java()) }),
  LanguageDescription.of({ name: 'go', alias: ['golang'], load: () => import('@codemirror/lang-go').then((m) => m.go()) }),
  LanguageDescription.of({ name: 'yaml', alias: ['yml'], load: () => import('@codemirror/lang-yaml').then((m) => m.yaml()) }),
  LanguageDescription.of({ name: 'sql', alias: ['sqlite', 'postgres', 'mysql'], load: () => import('@codemirror/lang-sql').then((m) => m.sql()) }),
  LanguageDescription.of({ name: 'xml', alias: ['svg', 'xhtml', 'plist'], load: () => import('@codemirror/lang-xml').then((m) => m.xml()) }),
];
