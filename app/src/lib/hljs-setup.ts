/**
 * highlight.js with the 36 grammars `highlight.js/lib/common` ships, as its
 * own chunk. Only `render-deps.ts` imports this, dynamically — see there for
 * why it is not in the entry chunk any more.
 *
 * Registered in the same order as `lib/common` (highlightAuto's tie-break),
 * and only when the chunk is first asked for: each `registerLanguage` runs
 * the grammar factory.
 */
import hljs from 'highlight.js/lib/core';
import type { HLJSApi, LanguageFn } from 'highlight.js';
import hl_xml from 'highlight.js/lib/languages/xml';
import hl_bash from 'highlight.js/lib/languages/bash';
import hl_c from 'highlight.js/lib/languages/c';
import hl_cpp from 'highlight.js/lib/languages/cpp';
import hl_csharp from 'highlight.js/lib/languages/csharp';
import hl_css from 'highlight.js/lib/languages/css';
import hl_markdown from 'highlight.js/lib/languages/markdown';
import hl_diff from 'highlight.js/lib/languages/diff';
import hl_ruby from 'highlight.js/lib/languages/ruby';
import hl_go from 'highlight.js/lib/languages/go';
import hl_graphql from 'highlight.js/lib/languages/graphql';
import hl_ini from 'highlight.js/lib/languages/ini';
import hl_java from 'highlight.js/lib/languages/java';
import hl_javascript from 'highlight.js/lib/languages/javascript';
import hl_json from 'highlight.js/lib/languages/json';
import hl_kotlin from 'highlight.js/lib/languages/kotlin';
import hl_less from 'highlight.js/lib/languages/less';
import hl_lua from 'highlight.js/lib/languages/lua';
import hl_makefile from 'highlight.js/lib/languages/makefile';
import hl_perl from 'highlight.js/lib/languages/perl';
import hl_objectivec from 'highlight.js/lib/languages/objectivec';
import hl_php from 'highlight.js/lib/languages/php';
import hl_php_template from 'highlight.js/lib/languages/php-template';
import hl_plaintext from 'highlight.js/lib/languages/plaintext';
import hl_python from 'highlight.js/lib/languages/python';
import hl_python_repl from 'highlight.js/lib/languages/python-repl';
import hl_r from 'highlight.js/lib/languages/r';
import hl_rust from 'highlight.js/lib/languages/rust';
import hl_scss from 'highlight.js/lib/languages/scss';
import hl_shell from 'highlight.js/lib/languages/shell';
import hl_sql from 'highlight.js/lib/languages/sql';
import hl_swift from 'highlight.js/lib/languages/swift';
import hl_yaml from 'highlight.js/lib/languages/yaml';
import hl_typescript from 'highlight.js/lib/languages/typescript';
import hl_vbnet from 'highlight.js/lib/languages/vbnet';
import hl_wasm from 'highlight.js/lib/languages/wasm';

const HLJS_LANGUAGES: [string, LanguageFn][] = [
  ['xml', hl_xml],
  ['bash', hl_bash],
  ['c', hl_c],
  ['cpp', hl_cpp],
  ['csharp', hl_csharp],
  ['css', hl_css],
  ['markdown', hl_markdown],
  ['diff', hl_diff],
  ['ruby', hl_ruby],
  ['go', hl_go],
  ['graphql', hl_graphql],
  ['ini', hl_ini],
  ['java', hl_java],
  ['javascript', hl_javascript],
  ['json', hl_json],
  ['kotlin', hl_kotlin],
  ['less', hl_less],
  ['lua', hl_lua],
  ['makefile', hl_makefile],
  ['perl', hl_perl],
  ['objectivec', hl_objectivec],
  ['php', hl_php],
  ['php-template', hl_php_template],
  ['plaintext', hl_plaintext],
  ['python', hl_python],
  ['python-repl', hl_python_repl],
  ['r', hl_r],
  ['rust', hl_rust],
  ['scss', hl_scss],
  ['shell', hl_shell],
  ['sql', hl_sql],
  ['swift', hl_swift],
  ['yaml', hl_yaml],
  ['typescript', hl_typescript],
  ['vbnet', hl_vbnet],
  ['wasm', hl_wasm],
];
export function createHljs(): HLJSApi {
  for (const [name, lang] of HLJS_LANGUAGES) hljs.registerLanguage(name, lang);
  return hljs;
}
