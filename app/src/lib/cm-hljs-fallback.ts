/**
 * #589 — highlight.js fallback syntax highlighting for CodeMirror 6 fenced code
 * blocks whose language is not covered by `@codemirror/lang-*` (such as
 * `bash`/`sh`/`zsh`/`shell`, `toml`/`ini`, `csharp`, `kotlin`, `swift`, `ruby`,
 * `php`, `lua`, `makefile`, `diff`, `graphql`, `scss`, `less`) as well as
 * untagged fenced code blocks (` ``` `).
 *
 * Uses the lazy-loaded `getHljs()` instance from `render-deps.ts` and maps
 * `hljs-*` classes to `Decoration.mark` spans styled by `styles/hljs-theme.css`.
 */
import { LanguageDescription, syntaxTree } from '@codemirror/language';
import { StateEffect, type Extension, type Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { codeLanguages } from './code-languages';
import { frozenDuringComposition, isImeSafeFlushTransaction } from './cm-ime-guard';
import { getHljs, onRenderDepsChange } from './render-deps';

const hljsReadyEffect = StateEffect.define<null>();

const SKIP_FENCE_LANGS = new Set([
  'mermaid',
  'markmap',
  'mm',
  'excalidraw',
  'tldraw',
  'plantuml',
  'puml',
  'text',
  'plaintext',
  'plain',
  'txt',
  'none',
]);

const HLJS_LANG_ALIASES: Record<string, string> = {
  ahk: 'autohotkey',
  autohotkey: 'autohotkey',
  gawk: 'awk',
  mawk: 'awk',
  nawk: 'awk',
  sh: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ksh: 'bash',
  csh: 'bash',
  console: 'shell',
  terminal: 'shell',
  ps1: 'bash',
  powershell: 'bash',
  pwsh: 'bash',
  bat: 'bash',
  cmd: 'bash',
  toml: 'ini',
  conf: 'ini',
  cfg: 'ini',
  properties: 'ini',
  env: 'ini',
  dotenv: 'ini',
  docker: 'bash',
  dockerfile: 'bash',
  make: 'makefile',
  mk: 'makefile',
  cs: 'csharp',
  kt: 'kotlin',
  kts: 'kotlin',
  rb: 'ruby',
  pl: 'perl',
  objc: 'objectivec',
  patch: 'diff',
  gql: 'graphql',
};

const MAX_FALLBACK_CODE_CHARS = 24_000;

const markCache = new Map<string, Decoration>();
function markForClass(cls: string): Decoration {
  let d = markCache.get(cls);
  if (!d) {
    d = Decoration.mark({ class: cls });
    markCache.set(cls, d);
  }
  return d;
}

export interface HljsSpan {
  from: number;
  to: number;
  cls: string;
}

/**
 * Parse highlight.js HTML output (`<span class="hljs-...">...</span>` + escaped
 * text) back into exact character offsets over the original `code` string.
 * Returns `[]` if offset verification ever disagrees with `code.length`.
 */
export function parseHljsHtmlSpans(html: string, code: string): HljsSpan[] {
  const spans: HljsSpan[] = [];
  const stack: Array<{ cls: string; start: number }> = [];
  let pos = 0;
  const tokenRe = /<span\s+class="([^"]+)">|<\/span>|&(?:#x[0-9a-fA-F]+|#\d+|[a-zA-Z0-9]+);|[^<&]+|[<&]/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html)) !== null) {
    const tok = m[0];
    if (m[1] !== undefined) {
      stack.push({ cls: m[1], start: pos });
    } else if (tok === '</span>') {
      const top = stack.pop();
      if (top && pos > top.start) {
        spans.push({ from: top.start, to: pos, cls: top.cls });
      }
    } else if (tok.startsWith('&') && tok.endsWith(';') && tok.length > 2) {
      // Named HTML entities emitted by highlight.js (`&lt;`, `&gt;`, `&amp;`,
      // `&quot;`) are 1 UTF-16 code unit; numeric entities (`&#x...;`, `&#...;`)
      // may decode to an astral code point (2 UTF-16 code units).
      let charLen = 1;
      if (tok.startsWith('&#x') || tok.startsWith('&#X')) {
        const cp = Number.parseInt(tok.slice(3, -1), 16);
        if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) {
          charLen = String.fromCodePoint(cp).length;
        }
      } else if (tok.startsWith('&#')) {
        const cp = Number.parseInt(tok.slice(2, -1), 10);
        if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) {
          charLen = String.fromCodePoint(cp).length;
        }
      }
      pos += charLen;
    } else {
      pos += tok.length;
    }
  }
  if (pos !== code.length) return [];
  return spans;
}

function buildHljsFallbackDecorations(view: EditorView): DecorationSet {
  const hl = getHljs();
  if (!hl) return Decoration.none;

  const ranges: Range<Decoration>[] = [];
  const seenBlocks = new Set<number>();
  const doc = view.state.doc;
  const tree = syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'FencedCode') return;
        if (seenBlocks.has(node.from)) return false;
        seenBlocks.add(node.from);

        let rawLang = '';
        let codeFrom = -1;
        let codeTo = -1;
        for (let ch = node.node.firstChild; ch; ch = ch.nextSibling) {
          if (ch.name === 'CodeInfo') {
            rawLang = doc.sliceString(ch.from, ch.to).trim().split(/\s+/)[0]?.toLowerCase() ?? '';
          } else if (ch.name === 'CodeText') {
            codeFrom = ch.from;
            codeTo = ch.to;
          }
        }
        if (codeFrom < 0 || codeTo <= codeFrom || codeTo - codeFrom > MAX_FALLBACK_CODE_CHARS) {
          return false;
        }
        if (rawLang && SKIP_FENCE_LANGS.has(rawLang)) {
          return false;
        }
        if (rawLang && LanguageDescription.matchLanguageName(codeLanguages, rawLang, true)) {
          // Handled natively by CodeMirror's Lezer language parser.
          return false;
        }

        const code = doc.sliceString(codeFrom, codeTo);
        if (!code.trim()) return false;

        const mappedLang = rawLang ? (HLJS_LANG_ALIASES[rawLang] ?? rawLang) : '';
        let html = '';
        try {
          if (mappedLang && hl.getLanguage(mappedLang)) {
            html = hl.highlight(code, { language: mappedLang, ignoreIllegals: true }).value;
          } else {
            html = hl.highlightAuto(code).value;
          }
        } catch {
          return false;
        }
        if (!html) return false;

        const spans = parseHljsHtmlSpans(html, code);
        for (const sp of spans) {
          // Split multi-line spans at '\n' so mark decorations stay strictly intra-line.
          let segStart = sp.from;
          while (segStart < sp.to) {
            const nl = code.indexOf('\n', segStart);
            const segEnd = nl >= 0 && nl < sp.to ? nl : sp.to;
            if (segEnd > segStart) {
              ranges.push(markForClass(sp.cls).range(codeFrom + segStart, codeFrom + segEnd));
            }
            if (nl < 0 || nl >= sp.to) break;
            segStart = nl + 1;
          }
        }
        return false;
      },
    });
  }

  return ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none;
}

export function hljsFallbackExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private unsubscribe: (() => void) | null = null;

      constructor(view: EditorView) {
        this.decorations = buildHljsFallbackDecorations(view);
        this.unsubscribe = onRenderDepsChange(() => {
          queueMicrotask(() => {
            try {
              view.dispatch({ effects: hljsReadyEffect.of(null) });
            } catch {
              /* view may have been destroyed */
            }
          });
        });
      }

      update(u: ViewUpdate) {
        const frozen = frozenDuringComposition(u, this.decorations);
        if (frozen) {
          this.decorations = frozen;
          return;
        }
        const hljsReady = u.transactions.some((tr) =>
          tr.effects.some((e) => e.is(hljsReadyEffect)),
        );
        const treeChanged = syntaxTree(u.state) !== syntaxTree(u.startState);
        if (
          u.docChanged ||
          u.viewportChanged ||
          hljsReady ||
          treeChanged ||
          u.transactions.some(isImeSafeFlushTransaction)
        ) {
          this.decorations = buildHljsFallbackDecorations(u.view);
        }
      }

      destroy() {
        this.unsubscribe?.();
        this.unsubscribe = null;
      }
    },
    { decorations: (v) => v.decorations },
  );
}
