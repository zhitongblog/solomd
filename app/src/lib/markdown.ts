import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
// @ts-ignore — types are loose
import katex from '@vscode/markdown-it-katex';
// @ts-ignore — no types shipped
import footnote from 'markdown-it-footnote';
// @ts-ignore — no types shipped
import frontMatter from 'markdown-it-front-matter';
// @ts-ignore — no types shipped
import mark from 'markdown-it-mark';
import cjkFriendly from 'markdown-it-cjk-friendly';
import yaml from 'js-yaml';
import { numberEquations } from './equations';
import { parseImageAltSize } from './md-image-url';
import { sanitizeRenderedHtml } from './sanitize-html';
import { renderMarkmapSvg } from './markmap-render';
import { renderExcalidrawSvg } from './excalidraw';
import { getHljs, getKatex } from './render-deps';
import {
  parseOutlineSegments,
  stripOutlineFormatting,
  type OutlineSegment,
} from './html-live-render';

export { parseOutlineSegments, stripOutlineFormatting, type OutlineSegment };

// NOTE: `@hedgedoc/markdown-it-task-lists` is installed but unusable here —
// its compiled ESM entry does `import Token from 'markdown-it/lib/token.js'`
// which markdown-it@14 no longer exposes as a subpath, so Rollup can't
// resolve it. We implement the same behaviour inline below as a core rule,
// which also lets us attach `data-line` in the same pass.

const katexPlugin: any = (katex as any).default ?? katex;

// The plugin's parse rules are always on; only the typesetting is deferred
// (render-deps.ts). It takes its KaTeX from `options.katex`, so it gets this
// stand-in: the real `renderToString` once the chunk is in, the source text
// until then — the preview and both editors re-render on load. (vite.config
// stubs the plugin's own `require('katex')`, which would otherwise drag KaTeX
// back into the entry chunk.)
const escapeMathSource = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lazyKatex = {
  renderToString(tex: string, options?: { displayMode?: boolean }): string {
    const k = getKatex();
    if (k) return k.renderToString(tex, options as any);
    return options?.displayMode
      ? `<span class="math-pending math-pending--display">$$${escapeMathSource(tex)}$$</span>`
      : `<span class="math-pending">$${escapeMathSource(tex)}$</span>`;
  },
};

// CJK-friendly emphasis (#262 / Gitee IKA1A0). `**限制：**硬链接` renders as
// literal asterisks under stock CommonMark, and that shape is everywhere in
// Chinese writing: a bold run ending in a full-width colon, immediately
// followed by a Han character — no space, because CJK doesn't use one. The
// closing `**` is preceded by punctuation and followed by a letter, so it
// isn't right-flanking and can't close.
//
// `markdown-it-cjk-friendly` implements the CommonMark CJK amendment
// (commonmark/commonmark-spec#650), which reads those clauses as *non-CJK*
// punctuation. ASCII text keeps stock CommonMark behaviour — `**limit:**hard`
// stays literal — because nothing CJK is adjacent.


// Per-render front-matter capture. markdown-it is synchronous so a
// module-level variable is safe for sequential calls, but this is NOT
// concurrent-safe across interleaved renders.
let lastFrontMatterRaw: string | null = null;

// `html: true` lets users embed inline HTML like
// `<img src=… style="zoom:50%;">`, `<details>`, `<sub>`, or table HTML for
// edge cases markdown can't express (issue #54) — that stays on, because
// breaking it would break real documents.
//
// #304 corrects the assumption the old comment made here ("this app only ever
// renders the user's own files — no untrusted input"): notes travel. Shared
// vaults, downloaded .md files, Git-synced folders and AI output all end up in
// this renderer, and `html: true` means `<img src=x onerror=…>` in any of them
// used to execute inside the webview — where `__TAURI_INTERNALS__.invoke`
// exposes the app's own file-read/write commands. So `renderMarkdown()` now
// runs its output through `sanitizeRenderedHtml()` (DOMPurify, configured in
// ./sanitize-html.ts to keep KaTeX MathML, inline SVG, highlight.js spans and
// our data-* plumbing), and tauri.conf.json carries a CSP that blocks inline
// script even if the sanitizer is bypassed.
export const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  // #141 — `breaks` is user-controlled (settings.markdownHardBreaks, default
  // ON = Typora-like: a single newline renders as a line break). This initial
  // value matches that default; the live value is synced from the settings
  // store via setMarkdownHardBreaks() (App.vue watchEffect) on hydration and
  // on toggle. Before 4.8.10 preview/exports used `false` while the Windows
  // live editor hardcoded `true` — the app disagreed with itself (#141).
  breaks: true,
  highlight: (code: string, lang: string): string => {
    // Mermaid blocks are handled after-render (processMermaid in Preview.vue)
    // and must keep the `language-mermaid` class untouched. Return '' so
    // markdown-it falls through to its default HTML-escape path for this
    // lang; the class is still emitted via langPrefix on the <code> tag.
    if (lang === 'mermaid') return '';
    // Not loaded yet (render-deps.ts): plain escaped code now, colours on the
    // re-render that follows the load.
    const hl = getHljs();
    if (!hl) return '';
    if (lang && hl.getLanguage(lang)) {
      try {
        return hl.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {}
    }
    // Unknown language: let hljs auto-detect for a best-effort highlight.
    try {
      return hl.highlightAuto(code).value;
    } catch {
      return '';
    }
  },
})
  // front-matter must run first so it's stripped from the body before
  // any other plugin/rule sees it.
  .use(frontMatter, (fm: string) => {
    lastFrontMatterRaw = fm;
  })
  .use(anchor, { permalink: false, slugify: (s: string) => slugify(s) })
  .use(katexPlugin, { throwOnError: false, katex: lazyKatex })
  .use(footnote)
  .use(mark)
  .use(cjkFriendly);

// #504 — Disable schemeless fuzzy domain auto-linking so stock ticker codes
// like `00700.HK`, `600519.SH`, `000001.SZ`, or filenames like `README.md` are
// not falsely turned into `http://00700.HK` links just because `.hk`/`.sh`/`.sz`/`.md`
// happen to be valid country TLDs. Explicit `http(s)://...` URLs and `<...>`
// autolinks continue to linkify as expected.
md.linkify.set({ fuzzyLink: false });

// #380 — allow `file:` link / image destinations
const stockValidateLink = md.validateLink.bind(md);
md.validateLink = (url: string): boolean => {
  const str = String(url ?? '').trim().toLowerCase();
  if (!str) return false;
  if (str.startsWith('file:')) return true;
  return stockValidateLink(url);
};

// #464 — Allow GFM tables to interrupt blockquotes and lists without requiring
// a blank line, matching CodeMirror's GFM parser in Live mode (`> quote\n| a | b |`).
const tableBlockRule = (md.block.ruler as any).__rules__?.find((r: any) => r.name === 'table');
if (tableBlockRule) {
  tableBlockRule.alt = ['paragraph', 'reference', 'blockquote', 'list'];
}

// #546 — Preserve full-width ideographic spaces (`\u3000`, `　`) at the start
// and end of paragraphs. Stock markdown-it calls `.trim()` on paragraph content,
// which in JavaScript strips all Unicode whitespace including `U+3000`, eating
// CJK first-line / dialogue indentation (`　　　　李玲：...`). CommonMark §2.1
// only trims ASCII spaces/tabs (`U+0020` / `U+0009`).
const origParagraphRule = (md.block.ruler as any).__rules__?.find((r: any) => r.name === 'paragraph')?.fn;
if (origParagraphRule) {
  md.block.ruler.at('paragraph', (state, startLine, endLine, silent) => {
    const blkIndent = state.blkIndent;
    const ok = origParagraphRule(state, startLine, endLine, silent);
    if (ok && !silent) {
      const tok = state.tokens[state.tokens.length - 2];
      if (tok && tok.type === 'inline') {
        tok.content = state
          .getLines(startLine, state.line, blkIndent, false)
          .replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
      }
    }
    return ok;
  });
}
(md.block.ruler as any).__cache__ = null;

// ---- Definition List (`Term\n: Definition`, #285) ---------------------------
// Supports Pandoc / PHP Markdown Extra definition lists (`<dl><dt><dd>`).
md.block.ruler.before(
  'paragraph',
  'deflist',
  (state, startLine, endLine, silent) => {
    const getLine = (lineNo: number): string => {
      const pos = state.bMarks[lineNo] + state.tShift[lineNo];
      const max = state.eMarks[lineNo];
      return state.src.slice(pos, max);
    };
    const isDefMarkerLine = (lineNo: number): boolean => {
      if (lineNo < 0 || lineNo >= endLine || state.isEmpty(lineNo)) return false;
      if (state.sCount[lineNo] - state.blkIndent >= 4) return false;
      return /^[:~][ \t]+/.test(getLine(lineNo));
    };
    const isTermCandidateLine = (lineNo: number): boolean => {
      if (lineNo < 0 || lineNo >= endLine || state.isEmpty(lineNo)) return false;
      if (state.sCount[lineNo] - state.blkIndent >= 4) return false;
      const text = getLine(lineNo);
      if (/^(?:#{1,6}[ \t]|`{3,}|~{3,}|>|[-*+][ \t]|\d+[.)][ \t]|[:~][ \t]|\||<(?:!--|[a-zA-Z/]))/.test(text)) {
        return false;
      }
      if (/^(?:[-*_][ \t]*){3,}$/.test(text)) return false;
      return true;
    };
    const matchTermGroupAt = (
      fromLine: number,
    ): { termEnd: number; ddStart: number } | null => {
      if (!isTermCandidateLine(fromLine)) return null;
      let tEnd = fromLine + 1;
      while (tEnd < endLine && isTermCandidateLine(tEnd)) {
        // Stop if `tEnd` itself is the last term directly above a `: def`
        tEnd++;
      }
      let dd = tEnd;
      if (dd < endLine && state.isEmpty(dd)) dd++;
      if (!isDefMarkerLine(dd)) return null;
      return { termEnd: tEnd, ddStart: dd };
    };

    const firstGroup = matchTermGroupAt(startLine);
    if (!firstGroup) return false;
    if (silent) return true;

    const dlOpen = state.push('dl_open', 'dl', 1);
    dlOpen.map = [startLine, 0];

    let curLine = startLine;
    while (curLine < endLine) {
      const group = matchTermGroupAt(curLine);
      if (!group) break;

      for (let tl = curLine; tl < group.termEnd; tl++) {
        const dtOpen = state.push('dt_open', 'dt', 1);
        dtOpen.map = [tl, tl + 1];
        const inlineTok = state.push('inline', '', 0);
        inlineTok.content = getLine(tl).trim();
        inlineTok.map = [tl, tl + 1];
        inlineTok.children = [];
        state.push('dt_close', 'dt', -1);
      }

      curLine = group.ddStart;
      while (curLine < endLine) {
        if (state.isEmpty(curLine)) {
          if (curLine + 1 < endLine && isDefMarkerLine(curLine + 1)) {
            curLine++;
          } else {
            break;
          }
        }
        if (!isDefMarkerLine(curLine)) break;
        const ddStartLine = curLine;
        const firstMatch = getLine(curLine).match(/^[:~][ \t]+(.*)$/);
        const ddLines: string[] = [firstMatch ? firstMatch[1] : ''];
        curLine++;
        while (
          curLine < endLine &&
          !state.isEmpty(curLine) &&
          !isDefMarkerLine(curLine)
        ) {
          if (matchTermGroupAt(curLine)) break;
          ddLines.push(getLine(curLine).trim());
          curLine++;
        }
        const ddOpen = state.push('dd_open', 'dd', 1);
        ddOpen.map = [ddStartLine, curLine];
        const ddInline = state.push('inline', '', 0);
        ddInline.content = ddLines.join('\n');
        ddInline.map = [ddStartLine, curLine];
        ddInline.children = [];
        state.push('dd_close', 'dd', -1);
      }

      if (
        curLine < endLine &&
        state.isEmpty(curLine) &&
        curLine + 1 < endLine &&
        matchTermGroupAt(curLine + 1)
      ) {
        curLine++;
      }
    }

    dlOpen.map = [startLine, curLine];
    state.push('dl_close', 'dl', -1);
    state.line = curLine;
    return true;
  },
  { alt: ['paragraph', 'reference', 'blockquote'] },
);

// ---- Wikilink rule (`[[X]]`, `[[X|alias]]`, `[[X#heading]]`) ---------------
// Used by F1 (v2.0). Renders into <a class="md-wikilink" data-wikilink-target="X">…</a>.
// Preview.vue intercepts clicks and resolves through the workspace index.
md.inline.ruler.before('link', 'wikilink', (state, silent) => {
  const start = state.pos;
  const src = state.src;
  if (src.charCodeAt(start) !== 0x5b /* [ */) return false;
  if (src.charCodeAt(start + 1) !== 0x5b) return false;
  // Find closing `]]` on the same line. Disallow nested `[`.
  const max = state.posMax;
  let i = start + 2;
  while (i < max - 1) {
    const ch = src.charCodeAt(i);
    if (ch === 0x0a) return false; // newline
    if (ch === 0x5b) return false; // nested [
    if (ch === 0x5d && src.charCodeAt(i + 1) === 0x5d) {
      // Found closing ]]
      const inner = src.slice(start + 2, i).trim();
      if (!inner) return false;
      if (silent) {
        state.pos = i + 2;
        return true;
      }
      // Parse target / heading / alias
      let target = inner;
      let alias: string | null = null;
      let heading: string | null = null;
      const pipe = target.indexOf('|');
      if (pipe >= 0) {
        alias = target.slice(pipe + 1).trim() || null;
        target = target.slice(0, pipe).trim();
      }
      const hash = target.indexOf('#');
      if (hash >= 0) {
        heading = target.slice(hash + 1).trim() || null;
        target = target.slice(0, hash).trim();
      }
      const display = alias || (heading ? `${target}#${heading}` : target);
      const tokOpen = state.push('wikilink_open', 'a', 1);
      tokOpen.attrSet('class', 'md-wikilink');
      tokOpen.attrSet('href', '#');
      tokOpen.attrSet('data-wikilink-target', target);
      if (heading) tokOpen.attrSet('data-wikilink-heading', heading);
      const tokText = state.push('text', '', 0);
      tokText.content = display;
      state.push('wikilink_close', 'a', -1);
      state.pos = i + 2;
      return true;
    }
    i++;
  }
  return false;
});

// ---- Superscript `^sup^` and Subscript `~sub~` (#284) -----------------------
// Standard markdown-it-sup / markdown-it-sub rules:
// - `^sup^` renders `<sup>sup</sup>` (ignoring `[^footnote]` and `^^`).
// - `~sub~` renders `<sub>sub</sub>` (ignoring `~~strikethrough~~`).
// - Unescaped spaces or newlines are disallowed inside the markers so prose like
//   `~50 to ~60` is never misinterpreted as subscript.
const UNESCAPE_RE = /\\([ \\!"#$%&'()*+,./:;<=>?@[\]^_`{|}~-])/g;

md.inline.ruler.after('strikethrough', 'superscript', (state, silent) => {
  const max = state.posMax;
  const start = state.pos;
  const src = state.src;
  if (src.charCodeAt(start) !== 0x5e /* ^ */) return false;
  if (silent) return false;
  // Never steal footnote references `[^1]` or double carets `^^`.
  if (start > 0 && (src.charCodeAt(start - 1) === 0x5b /* [ */ || src.charCodeAt(start - 1) === 0x5e)) {
    return false;
  }
  if (start + 2 >= max) return false;
  if (src.charCodeAt(start + 1) === 0x5e) return false;

  state.pos = start + 1;
  let found = false;
  while (state.pos < max) {
    const ch = src.charCodeAt(state.pos);
    if (ch === 0x5e /* ^ */) {
      if (state.pos + 1 < max && src.charCodeAt(state.pos + 1) === 0x5e) {
        state.pos = start;
        return false;
      }
      found = true;
      break;
    }
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
      state.pos = start;
      return false;
    }
    if (ch === 0x5c /* \ */ && state.pos + 1 < max) {
      state.pos += 2;
      continue;
    }
    state.pos++;
  }
  if (!found || start + 1 === state.pos) {
    state.pos = start;
    return false;
  }
  const content = src.slice(start + 1, state.pos);
  state.posMax = state.pos;
  state.pos = start + 1;
  state.push('sup_open', 'sup', 1);
  const textTok = state.push('text', '', 0);
  textTok.content = content.replace(UNESCAPE_RE, '$1');
  state.push('sup_close', 'sup', -1);
  state.pos = state.posMax + 1;
  state.posMax = max;
  return true;
});

md.inline.ruler.after('strikethrough', 'subscript', (state, silent) => {
  const max = state.posMax;
  const start = state.pos;
  const src = state.src;
  if (src.charCodeAt(start) !== 0x7e /* ~ */) return false;
  if (silent) return false;
  // Never interfere with `~~strikethrough~~`.
  if (start > 0 && src.charCodeAt(start - 1) === 0x7e) return false;
  if (start + 2 >= max) return false;
  if (src.charCodeAt(start + 1) === 0x7e) return false;

  state.pos = start + 1;
  let found = false;
  while (state.pos < max) {
    const ch = src.charCodeAt(state.pos);
    if (ch === 0x7e /* ~ */) {
      if (state.pos + 1 < max && src.charCodeAt(state.pos + 1) === 0x7e) {
        state.pos = start;
        return false;
      }
      found = true;
      break;
    }
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
      state.pos = start;
      return false;
    }
    if (ch === 0x5c /* \ */ && state.pos + 1 < max) {
      state.pos += 2;
      continue;
    }
    state.pos++;
  }
  if (!found || start + 1 === state.pos) {
    state.pos = start;
    return false;
  }
  const content = src.slice(start + 1, state.pos);
  state.posMax = state.pos;
  state.pos = start + 1;
  state.push('sub_open', 'sub', 1);
  const textTok = state.push('text', '', 0);
  textTok.content = content.replace(UNESCAPE_RE, '$1');
  state.push('sub_close', 'sub', -1);
  state.pos = state.posMax + 1;
  state.posMax = max;
  return true;
});

// ---- Image with a space in its path (#345) -----------------------------------
// CommonMark doesn't allow a space in a bare link destination, so
// `![](D:/Program Files/a.png)` renders as literal text. SoloMD used to write
// exactly that when pasting into an image folder whose path had a space (it
// now percent-encodes, see md-image-url.ts), so notes in the wild still carry
// such links. Accept them as images — but only when the destination is a
// single line, has no quotes, parentheses or angle brackets, and ends in an
// image extension. Under the standard grammar that text can only ever render
// as the raw characters, so nothing that works today changes meaning.
const SPACED_IMAGE_RE =
  /^!\[([^\]\n]*)\]\(\s*([^()<>"'\n]*?\s[^()<>"'\n]*?\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?))\s*\)/i;
md.inline.ruler.before('image', 'image_spaced_path', (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x21 /* ! */) return false;
  const m = SPACED_IMAGE_RE.exec(state.src.slice(state.pos, state.posMax));
  if (!m) return false;
  const href = state.md.normalizeLink(m[2]);
  if (!state.md.validateLink(href)) return false;
  if (!silent) {
    const children: typeof state.tokens = [];
    state.md.inline.parse(m[1], state.md, state.env, children);
    const token = state.push('image', 'img', 0);
    token.attrs = [['src', href], ['alt', '']];
    token.children = children;
    token.content = m[1];
  }
  state.pos += m[0].length;
  return true;
});

// ---- Image size syntax (`![alt|50%](url)` / `![alt|300](url)`) (#446) -------
const defaultImageRenderer = md.renderer.rules.image;
md.renderer.rules.image = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  if (!token.attrGet('referrerpolicy')) {
    token.attrSet('referrerpolicy', 'no-referrer');
  }
  const rawAlt = token.children
    ? self.renderInlineAsText(token.children, options, env)
    : (token.content || token.attrGet('alt') || '');
  const parsed = parseImageAltSize(rawAlt);
  if (parsed.width || parsed.height) {
    const existingStyle = token.attrGet('style');
    const sizeStyle = [
      parsed.width ? `width: ${parsed.width};` : '',
      parsed.height ? `height: ${parsed.height};` : '',
    ]
      .filter(Boolean)
      .join(' ');
    token.attrSet('style', existingStyle ? `${existingStyle}; ${sizeStyle}` : sizeStyle);
    if (parsed.width?.endsWith('px')) {
      token.attrSet('width', parsed.width.slice(0, -2));
    }
    if (parsed.height?.endsWith('px')) {
      token.attrSet('height', parsed.height.slice(0, -2));
    }
  }
  const html = defaultImageRenderer
    ? defaultImageRenderer(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
  if (parsed.width || parsed.height) {
    return html.replace(/\balt="[^"]*"/, `alt="${escapeHtml(parsed.alt)}"`);
  }
  return html;
};

// ---- Source line mapping for split-pane scroll sync ----
// Annotate every block-level opening token with `data-source-line` set to
// the 1-indexed source line. App.vue's split-scroll uses these attributes
// to map editor viewport lines to preview elements for accurate alignment.
const BLOCK_OPEN_TYPES = new Set([
  'paragraph_open',
  'heading_open',
  'blockquote_open',
  'list_item_open',
  'bullet_list_open',
  'ordered_list_open',
  'dl_open',
  'dt_open',
  'dd_open',
  'table_open',
  'fence',
  'code_block',
  'hr',
  'html_block',
  'math_block',
]);
// v4.3.0 issue #65: wrap each line of a rendered fence in a <span
// class="cb-line"> so a CSS counter can display line numbers when the
// `codeBlockLineNumbers` setting is on. The CSS is gated by a
// `cb-numbered` class added to <pre> here and `cb-numbered-on` on the
// `.preview-content` root — so flipping the setting is a pure-CSS swap,
// no re-render needed.
const defaultFenceRenderer = md.renderer.rules.fence;
function isValidFenceInfoString(rawInfo: string): boolean {
  const trimmed = rawInfo.trim();
  if (!trimmed) return true;
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  if (
    firstWord === 'mermaid' ||
    firstWord === 'markmap' ||
    firstWord === 'tldraw' ||
    firstWord === 'plantuml' ||
    firstWord === 'puml'
  ) {
    return true;
  }
  if (/^[a-zA-Z0-9_+#.-]+(?:\s+\{[^{}\n]*\})?$/.test(trimmed)) return true;
  if (/^\{[a-zA-Z0-9_+#.,=\s-]+\}$/.test(trimmed)) return true;
  return false;
}
md.renderer.rules.fence = function (tokens, idx, options, env, self) {
  const tok = tokens[idx];
  const origInfo = tok.info || '';
  const origContent = tok.content || '';
  // #537 — If the user typed non-language content directly after the opening
  // ``` on line 1 (e.g. ```{内容写在这里} or ```第一行代码), treat it as the
  // first line of the code block rather than swallowing it as an unknown
  // language info string.
  const treatInfoAsCodeLine = origInfo.trim().length > 0 && !isValidFenceInfoString(origInfo);
  if (treatInfoAsCodeLine) {
    tok.info = '';
    tok.content = `${origInfo.trim()}\n${origContent}`;
  }
  const html = defaultFenceRenderer
    ? defaultFenceRenderer(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
  if (treatInfoAsCodeLine) {
    tok.info = origInfo;
    tok.content = origContent;
  }
  // Skip mermaid — Preview.vue replaces these blocks with rendered SVGs.
  // Skip tldraw (F7) the same way — Preview.vue swaps the ```tldraw fence for
  // a static board SVG thumbnail (the language class survives so the
  // post-processor can find it).
  const info = (tok.info || '').trim().toLowerCase();
  const lang = info.split(/\s+/)[0];
  if (!treatInfoAsCodeLine && (lang === 'markmap' || lang === 'mm')) {
    const line = tok.map && tok.map.length > 0 ? tok.map[0] + 1 : 0;
    const lineAttr = line ? ` data-source-line="${line}"` : '';
    return `<div class="markmap-block"${lineAttr}>${renderMarkmapSvg(origContent)}</div>\n`;
  }
  if (!treatInfoAsCodeLine && lang === 'excalidraw') {
    const line = tok.map && tok.map.length > 0 ? tok.map[0] + 1 : 0;
    const lineAttr = line ? ` data-source-line="${line}"` : '';
    return `<div class="excalidraw-block"${lineAttr}>${renderExcalidrawSvg(origContent)}</div>\n`;
  }
  if (!treatInfoAsCodeLine && (lang === 'mermaid' || lang === 'tldraw')) return html;
  // Inject .cb-line wrappers on each line. We do this on the rendered HTML
  // because the highlight has already produced <span class="hljs-..."> spans
  // that may straddle multiple lines (a few hljs grammars emit multi-line
  // comment/string spans). A naive split on '\n' leaves those spans
  // unbalanced, and the browser then NESTS every later line inside line 1
  // (#164 — the whole block collapsed into the first numbered row). So we
  // tokenize: at each newline, close the currently-open spans, emit the line,
  // and reopen them on the next one — every .cb-line is self-contained.
  return html.replace(/<code([^>]*)>([\s\S]*?)<\/code>/, (_m, codeAttrs, inner) => {
    // Strip the trailing newline if any so we don't render an empty
    // line-numbered row at the end.
    // The newline can sit *inside* a highlight span that runs to the end of
    // the block ("…\n</span>"), so look past closing tags for it.
    const trimmed = inner.replace(/\n((?:<\/span>)*)$/, '$1');
    const openSpans: string[] = [];
    let out = '';
    let line = '';
    const flush = () => {
      // #190 — a blank line inside a multi-line highlight span is not an empty
      // string, it is `<span class="hljs-code"></span>`: no text, so no line
      // box, and its number landed on top of the next one. Judge emptiness by
      // the text, not the markup.
      const blank = line.replace(/<[^>]*>/g, '') === '';
      out += `<span class="cb-line">${blank ? `${line} ` : line}</span>`;
      line = '';
    };
    for (const tok of trimmed.match(/<span\b[^>]*>|<\/span>|\n|[^<\n]+|</g) ?? []) {
      if (tok === '\n') {
        line += '</span>'.repeat(openSpans.length);
        flush();
        out += '\n';
        line = openSpans.join('');
      } else if (tok.startsWith('<span')) {
        openSpans.push(tok);
        line += tok;
      } else if (tok === '</span>') {
        openSpans.pop();
        line += tok;
      } else {
        line += tok;
      }
    }
    flush();
    return `<code${codeAttrs}>${out}</code>`;
  })
    // Add cb-numbered class on the <pre> so CSS can scope the counter.
    .replace(/<pre>/, '<pre class="cb-numbered">');
};

// v4.6 — editable display math. Wrap every `$$…$$` block in a container that
// carries its 1-indexed source line, so Preview.vue can map a double-clicked
// formula back to its source range and open an inline LaTeX editor (like
// Tolaria's "editable math source panel"). The default markdown-it-katex
// math_block renderer doesn't propagate token attrs, so we wrap explicitly.
const defaultMathBlock = md.renderer.rules.math_block;
md.renderer.rules.math_block = function (tokens, idx, options, env, self) {
  const html = defaultMathBlock
    ? defaultMathBlock(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
  const tok = tokens[idx];
  const line = tok.map && tok.map.length > 0 ? tok.map[0] + 1 : 0;
  if (!line) return html;
  return `<div class="md-math-block" data-source-line="${line}">${html}</div>`;
};

md.core.ruler.push('source_line_map', (state) => {
  for (const tok of state.tokens) {
    if (!BLOCK_OPEN_TYPES.has(tok.type)) continue;
    if (!tok.map || tok.map.length < 1) continue;
    const line = tok.map[0] + 1; // 1-indexed
    tok.attrJoin('data-source-line', String(line));
  }
});

// ---- Document table of contents (`[TOC]`) ---------------------------------
// Expand a standalone, case-insensitive `[TOC]` paragraph at token level. Doing
// this after markdown-it-anchor has assigned heading ids keeps the links and
// duplicate-heading suffixes identical to the rendered headings. It also keeps
// the original source line map intact; expanding the source text itself would
// shift every heading after a large TOC and break split-pane scroll sync.
const TOC_MARKER_RE = /^\[toc\]$/i;

interface TocHeading {
  level: number;
  text: string;
  id: string;
}

function tocHeadingText(inline: any): string {
  const children = inline?.children ?? [];
  let text = '';
  for (const child of children) {
    if (child.type === 'softbreak' || child.type === 'hardbreak') {
      text += ' ';
    } else if (child.type === 'html_inline') {
      text += String(child.content || '').replace(/<[^>]*>/g, '');
    } else if (
      child.type === 'text' ||
      child.type === 'code_inline' ||
      child.type === 'math_inline' ||
      child.type === 'image' ||
      child.type === 'footnote_ref'
    ) {
      text += child.content || '';
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

function tocHeadingsFromTokens(tokens: any[]): TocHeading[] {
  const headings: TocHeading[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const open = tokens[i];
    const inline = tokens[i + 1];
    if (open.type !== 'heading_open' || inline?.type !== 'inline') continue;
    const level = Number.parseInt(String(open.tag || '').slice(1), 10);
    if (!Number.isFinite(level) || level < 1 || level > 6) continue;
    const text = tocHeadingText(inline) || inline.content.trim();
    const id = open.attrGet('id') || slugify(inline.content);
    if (text && id) headings.push({ level, text, id });
  }
  return headings;
}

function escapeTocLinkLabel(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function tocListMarkdown(headings: TocHeading[]): string {
  const levelStack: number[] = [];
  const lines: string[] = [];
  for (const heading of headings) {
    while (levelStack.length && levelStack[levelStack.length - 1] >= heading.level) {
      levelStack.pop();
    }
    const depth = levelStack.length;
    levelStack.push(heading.level);
    lines.push(
      `${'  '.repeat(depth)}- [${escapeTocLinkLabel(heading.text)}](#${heading.id})`,
    );
  }
  return lines.join('\n');
}

function parseForToc(state: any, source: string): any[] {
  // The front-matter plugin writes through a module-level capture used by the
  // outer render. A nested parse for a live-edit fragment must not replace that
  // capture with the full document's front matter.
  const savedFrontMatter = lastFrontMatterRaw;
  try {
    return state.md.parse(source, { solomdTocScan: true });
  } finally {
    lastFrontMatterRaw = savedFrontMatter;
  }
}

function tocListTokens(state: any, headings: TocHeading[]): any[] {
  const tokens = parseForToc(state, tocListMarkdown(headings));
  for (const token of tokens) {
    // These maps describe the generated list, not the user's document. Leaving
    // them attached would create bogus data-source-line values in the preview.
    token.map = null;
    const sourceLineAttr = token.attrIndex('data-source-line');
    if (sourceLineAttr >= 0) token.attrs?.splice(sourceLineAttr, 1);
    if (token.type === 'bullet_list_open') token.attrJoin('class', 'md-toc__list');
    if (token.type === 'list_item_open') token.attrJoin('class', 'md-toc__item');
    // Inline children are not present in the top-level token array; decorate
    // their link_open tokens explicitly so TOC links can be styled in every
    // renderer that consumes the shared markdown-it instance.
    for (const child of token.children ?? []) {
      if (child.type === 'link_open') child.attrJoin('class', 'md-toc__link');
    }
  }
  return tokens;
}

md.core.ruler.before('source_line_map', 'table_of_contents', (state) => {
  const env = (state.env || {}) as Record<string, unknown>;
  if (env.solomdTocScan === true) return;

  const sourceLines = state.src.split('\n');
  const markers: number[] = [];
  for (let i = 0; i < state.tokens.length - 2; i++) {
    const open = state.tokens[i];
    const inline = state.tokens[i + 1];
    const close = state.tokens[i + 2];
    if (
      open.type !== 'paragraph_open' ||
      inline?.type !== 'inline' ||
      close?.type !== 'paragraph_close' ||
      !TOC_MARKER_RE.test(inline.content.trim()) ||
      !open.map ||
      open.map[1] !== open.map[0] + 1 ||
      !/^[ \t]*\[toc\][ \t]*\r?$/i.test(sourceLines[open.map[0]] ?? '')
    ) {
      continue;
    }
    markers.push(i);
  }
  if (!markers.length) return;

  const externalSource = env.solomdTocSource;
  const headingTokens =
    typeof externalSource === 'string' ? parseForToc(state, externalSource) : state.tokens;
  const headings = tocHeadingsFromTokens(headingTokens);

  // Work backwards so splicing one marker never invalidates a later index.
  for (let m = markers.length - 1; m >= 0; m--) {
    const markerIndex = markers[m];
    const marker = state.tokens[markerIndex];
    if (!headings.length) {
      state.tokens.splice(markerIndex, 3);
      continue;
    }
    const navOpen = new state.Token('toc_open', 'nav', 1);
    navOpen.block = true;
    navOpen.map = marker.map;
    navOpen.attrSet('class', 'md-toc');
    navOpen.attrSet('aria-label', 'Table of contents');
    navOpen.attrSet('data-source-line', String((marker.map?.[0] ?? 0) + 1));
    const navClose = new state.Token('toc_close', 'nav', -1);
    navClose.block = true;
    state.tokens.splice(
      markerIndex,
      3,
      navOpen,
      ...tocListTokens(state, headings),
      navClose,
    );
  }
});

// Raw HTML blocks render their content verbatim — attrJoin above never reaches
// the output, so documents built around `<div>…<img>…</div>` containers had no
// sync anchors at all and the split panes drifted apart across those regions
// (#203 双栏错位). Wrap the raw block in a neutral div carrying the line.
const HTML_CONTAINER_TAG_RE = /<(\/?)(details|div|section|article|aside|figure|blockquote)\b[^>]*>/gi;
function hasUnbalancedContainerHtml(html: string): boolean {
  let depth = 0;
  HTML_CONTAINER_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HTML_CONTAINER_TAG_RE.exec(html)) !== null) {
    if (m[1] === '/') {
      depth -= 1;
      if (depth < 0) return true;
    } else {
      depth += 1;
    }
  }
  return depth !== 0;
}

const defaultHtmlBlock = md.renderer.rules.html_block;
md.renderer.rules.html_block = function (tokens, idx, options, env, self) {
  const html = defaultHtmlBlock
    ? defaultHtmlBlock(tokens, idx, options, env, self)
    : tokens[idx].content;
  const tok = tokens[idx];
  const line = tok.map && tok.map.length > 0 ? tok.map[0] + 1 : 0;
  if (!line) return html;
  // When a container HTML block (e.g. `<details><summary>...</summary>` followed
  // by a blank line, a Markdown table, and `</details>`) is split across
  // multiple tokens, wrapping the opening fragment in `<div data-source-line>`
  // forces the browser/DOMPurify to auto-close `<details>` before `</div>`,
  // pushing the inner `<table>` outside `<details>` (#500 T09-4). Stamp
  // `data-source-line` onto the opening tag directly and leave closing
  // fragments unwrapped.
  if (hasUnbalancedContainerHtml(html)) {
    if (/^\s*<\//.test(html)) return html;
    return html.replace(/^(\s*<[a-zA-Z][\w:-]*)/, `$1 data-source-line="${line}"`);
  }
  return `<div data-source-line="${line}">${html}</div>`;
};

// Terminate a GFM pipe table when a subsequent line contains no pipe (`|`)
// character (#500 T08-9: prose line immediately following a table without an
// intervening blank line should render as a `<p>` paragraph, not be swallowed
// into `<tbody>`).
md.block.ruler.before(
  'table',
  'table_no_pipe_terminator',
  (state, startLine, _endLine, silent) => {
    if (!silent || (state.parentType as string) !== 'table') return false;
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    const lineText = state.src.slice(pos, max);
    return !lineText.includes('|');
  },
  { alt: ['blockquote'] },
);

// Custom core rule: detect GitHub-style task list items (a leading
// `[ ]` / `[x]` in the first inline child of a list item) and:
//   1. add a `task-list-item` class to the <li>
//   2. replace the `[ ] ` / `[x] ` text prefix with an <input type="checkbox">
//   3. attach `data-line="N"` (1-indexed source line) to the <li>
// We also tag the enclosing <ul>/<ol> with `contains-task-list` so
// integrators can strip bullet markers.
// #271 — short table cells don't wrap. The browser's table layout promises a
// column only its min-content width, which for Chinese is ONE character, so a
// short label beside a long column was squeezed until it read top to bottom
// ("定/时/任/务…"). A cell whose text is short — up to ~12 CJK characters or
// ~24 Latin ones — is kept on one line; longer cells wrap as before, so a
// wide table still fits its page.
const SHORT_CELL_WIDTH = 24;
function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += /[\u2E80-\uA4CF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/.test(ch) ? 2 : 1;
  return w;
}
md.core.ruler.after('inline', 'table_short_cells', (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i];
    if (tok.type !== 'td_open' && tok.type !== 'th_open') continue;
    const inline = tokens[i + 1];
    if (inline.type !== 'inline') continue;
    // Measure what is shown, not the markup: `**x**` is one character wide.
    const shown = (inline.children ?? [])
      .map((c) => (c.type === 'text' || c.type === 'code_inline' ? c.content : ''))
      .join('');
    if (shown && displayWidth(shown) <= SHORT_CELL_WIDTH) tok.attrJoin('class', 'cell-nowrap');
  }
});

md.core.ruler.after('inline', 'task_lists', (state) => {
  const tokens = state.tokens;
  const TASK_RE = /^\[([ xX])\][ \u00A0]/;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type !== 'list_item_open') continue;

    // The first content of a list item is typically:
    //   list_item_open -> paragraph_open -> inline -> paragraph_close -> ...
    // We want the `inline` token's first child to be a text token
    // starting with `[ ] ` or `[x] `.
    const paragraphOpen = tokens[i + 1];
    const inlineTok = tokens[i + 2];
    if (
      !paragraphOpen ||
      paragraphOpen.type !== 'paragraph_open' ||
      !inlineTok ||
      inlineTok.type !== 'inline' ||
      !inlineTok.children ||
      inlineTok.children.length === 0
    ) {
      continue;
    }
    const firstChild = inlineTok.children[0];
    if (firstChild.type !== 'text') continue;
    const m = TASK_RE.exec(firstChild.content);
    if (!m) continue;

    const checked = m[1] !== ' ';
    // Strip the `[ ] ` / `[x] ` prefix from the text token.
    firstChild.content = firstChild.content.slice(m[0].length);

    // Insert an html_inline checkbox at the start of the inline children.
    const checkboxToken = new state.Token('html_inline', '', 0);
    checkboxToken.content = `<input class="task-list-item-checkbox" type="checkbox"${
      checked ? ' checked=""' : ''
    } disabled=""> `;
    inlineTok.children.unshift(checkboxToken);

    // Tag the <li>.
    const existingClass = tok.attrGet('class');
    tok.attrSet(
      'class',
      existingClass ? `${existingClass} task-list-item` : 'task-list-item',
    );
    const line = tok.map && tok.map.length > 0 ? tok.map[0] + 1 : 0;
    tok.attrSet('data-line', String(line));

    // Walk back to find the enclosing list token and tag it.
    for (let k = i - 1; k >= 0; k--) {
      const p = tokens[k];
      if (p.type === 'bullet_list_open' || p.type === 'ordered_list_open') {
        const cls = p.attrGet('class');
        if (!cls || !/\bcontains-task-list\b/.test(cls)) {
          p.attrSet(
            'class',
            cls ? `${cls} contains-task-list` : 'contains-task-list',
          );
        }
        break;
      }
      if (p.type === 'bullet_list_close' || p.type === 'ordered_list_close') {
        break;
      }
    }
  }
  return false;
});

// GitHub-style callouts: a blockquote whose first line is `[!NOTE]` (or TIP /
// IMPORTANT / WARNING / CAUTION) renders as a tinted callout card with a
// label row — the syntax GitHub and Obsidian users expect to just work. The
// marker line is stripped; the label/icon comes from CSS (`.md-callout`) so
// every consumer of the rendered HTML (preview, live blocks, print overlay)
// styles it without extra plumbing. Unknown `[!TYPES]` are left as plain
// blockquote text on purpose.
md.core.ruler.after('inline', 'github_callouts', (state) => {
  const tokens = state.tokens;
  const CALLOUT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/i;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'blockquote_open') continue;
    const pOpen = tokens[i + 1];
    const inline = tokens[i + 2];
    if (
      !pOpen ||
      pOpen.type !== 'paragraph_open' ||
      !inline ||
      inline.type !== 'inline' ||
      !inline.children ||
      inline.children.length === 0
    ) {
      continue;
    }
    const first = inline.children[0];
    if (first.type !== 'text') continue;
    const m = CALLOUT_RE.exec(first.content);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    tokens[i].attrJoin('class', `md-callout md-callout--${kind}`);
    first.content = first.content.slice(m[0].length);
    if (first.content === '') {
      // Marker sat alone on its line — drop the empty text node and the
      // line break that followed it so the body starts flush.
      const next = inline.children[1];
      inline.children.splice(0, next && (next.type === 'softbreak' || next.type === 'hardbreak') ? 2 : 1);
    }
  }
});

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\w\-\u4e00-\u9fff]/g, '');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderFrontMatterHtml(raw: string): string {
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch {
    return `<pre class="md-frontmatter md-frontmatter--raw">${escapeHtml(
      raw,
    )}</pre>`;
  }
  if (
    parsed === null ||
    parsed === undefined ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    // Not a key/value map — fall back to raw display.
    return `<pre class="md-frontmatter md-frontmatter--raw">${escapeHtml(
      raw,
    )}</pre>`;
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    return `<pre class="md-frontmatter md-frontmatter--raw">${escapeHtml(
      raw,
    )}</pre>`;
  }
  const rows = entries
    .map(([k, v]) => {
      const valueText =
        v === null || v === undefined
          ? ''
          : typeof v === 'object'
            ? JSON.stringify(v)
            : String(v);
      return `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(valueText)}</dd>`;
    })
    .join('');
  return `<div class="md-frontmatter"><dl>${rows}</dl></div>`;
}

// Tags that markdown-it will treat as HTML blocks when they start at column 0
// AND are surrounded by blank lines. mineru / many AI-PDF-to-Markdown tools
// emit `<table>...</table>` indented 4 spaces or wedged between text lines
// without blank-line separators, which makes markdown-it treat the chunk as
// a code block (4-space indent) or escape it as inline HTML inside a
// paragraph. The preprocessor pulls these tags back to column 0 and inserts
// blank lines around them so the HTML-block rule fires. See issue #71.
const HTML_BLOCK_PASSTHROUGH_TAGS = [
  'table',
  'div',
  'details',
  'figure',
  'iframe',
  'blockquote',
  'pre',
  'section',
  'article',
  'aside',
];
const HTML_BLOCK_RE = new RegExp(
  `^([ \\t]*)(<(?:${HTML_BLOCK_PASSTHROUGH_TAGS.join('|')})\\b[\\s\\S]*?</(?:${HTML_BLOCK_PASSTHROUGH_TAGS.join('|')})>)[ \\t]*$`,
  'gmi',
);

/** Preprocess: ensure block-level HTML elements (like `<table>` emitted by
 *  mineru) are at column 0 with blank lines around them so markdown-it parses
 *  them as HTML blocks rather than indented code or inline HTML inside a
 *  paragraph. Skipped inside fenced code blocks so we don't mangle code
 *  examples.
 */
function unwrapInlineHtmlBlocks(source: string): string {
  // Split on fenced code blocks (``` or ~~~) and only transform the non-code
  // segments. Lightweight split — markdown-it's own fence parser is the
  // authority but this approximation is sufficient for the common case.
  const FENCE_RE = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)/g;
  const segments: { text: string; isFence: boolean }[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(source)) !== null) {
    if (m.index > lastIndex) {
      segments.push({ text: source.slice(lastIndex, m.index), isFence: false });
    }
    segments.push({ text: m[0], isFence: true });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < source.length) {
    segments.push({ text: source.slice(lastIndex), isFence: false });
  }
  return segments
    .map((seg) => {
      if (seg.isFence) return seg.text;
      return seg.text.replace(HTML_BLOCK_RE, (_match, _indent, html) => {
        // Ensure `<details>` blocks that contain Markdown pipe tables without
        // blank lines after `</summary>` / `<details>` or before `</details>`
        // have blank lines so markdown-it parses the inner table rather than
        // treating the whole `<details>` body as a single CommonMark Type-6
        // raw HTML block.
        const normalizedHtml = /^<details\b/i.test(html)
          ? html
              .replace(
                /(<\/summary>[ \t]*)\n(?=[ \t]*\|[^\n]*\n[ \t]*\|?[\s:|-]+\|)/i,
                '$1\n\n',
              )
              .replace(/(\n[ \t]*\|[^\n]*)\n(?=[ \t]*<\/details>)/i, '$1\n\n')
          : html;
        return `\n\n${normalizedHtml}\n\n`;
      });
    })
    .join('');
}

// ---- Malformed table-delimiter normalization ------------------------------
// GFM (and markdown-it) require the delimiter row (the `|---|---|` line under
// the header) to have EXACTLY the same number of cells as the header row. If
// it doesn't — one cell too many or too few — markdown-it rejects the *entire*
// block and renders it as a plain paragraph, so the whole table collapses into
// literal `| … |` text in the preview. AI/LLM exports and PDF-to-Markdown tools
// frequently emit a stray extra `|---|` cell in the delimiter row (e.g. a
// 3-column header with a 4-cell delimiter), which silently breaks the table.
// Typora/Obsidian tolerate this; we do too — same philosophy as the list-indent
// and inline-HTML-block fixups above.
const TABLE_DELIM_CELL_RE = /^\s*:?-+:?\s*$/;

/** Split a table row on unescaped `|` (a `\|` is a literal pipe in a cell). */
function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) {
      cur += c + line[i + 1];
      i++;
      continue;
    }
    if (c === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur);
  return cells;
}

/** Cell count as markdown-it sees it: split on `|`, drop the empty leading /
 *  trailing cells produced by an outer `| … |` border. Also strips leading
 *  `>` blockquote markers so tables inside blockquotes are normalized properly. */
function tableRowCells(line: string): string[] {
  const stripped = line.replace(/^\s*(?:>\s*)+/, '').trim();
  const cells = splitTableRow(stripped);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}

function isTableDelimiterRow(line: string): boolean {
  const cells = tableRowCells(line);
  if (cells.length === 0) return false;
  // Tolerate empty cells (AI exports emit `| --- |  | --- |`); markdown-it
  // rejects those outright, but as long as there's at least one real `---`
  // cell and no cell holds actual content, it's a mangled delimiter row we
  // can repair. Requiring ≥1 real cell keeps an all-empty `|  |  |` — which
  // is a data row, not a delimiter — from being misclassified.
  let hasRealCell = false;
  for (const c of cells) {
    if (c.trim() === '') continue;
    if (!TABLE_DELIM_CELL_RE.test(c)) return false;
    hasRealCell = true;
  }
  return hasRealCell;
}

/** Rebuild one delimiter cell, preserving its alignment colons. */
function normalizeDelimiterCell(raw: string | undefined): string {
  const t = (raw ?? '').trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return ':---:';
  if (right) return '---:';
  if (left) return ':---';
  return '---';
}

/** When a delimiter row is malformed — its cell count differs from the header,
 *  or it contains an empty cell markdown-it rejects — rewrite it to exactly the
 *  header's column count, padding missing cells with `---`, dropping surplus
 *  ones, and keeping each surviving cell's alignment. Fenced code is skipped so
 *  `| a | b |` samples inside ``` blocks are left untouched. */
function normalizeTableDelimiters(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceChar = '';
  const fenceRe = /^(\s*(?:>\s*)*)(```+|~~~+)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = fenceRe.exec(line);
    if (fm) {
      if (!inFence) {
        inFence = true;
        fenceChar = fm[2][0];
        out.push(line);
        continue;
      }
      if (fm[2][0] === fenceChar) {
        inFence = false;
        out.push(line);
        continue;
      }
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const next = lines[i + 1];
    const headerLooksTabular = line.includes('|') && line.trim() !== '';
    if (
      headerLooksTabular &&
      next !== undefined &&
      next.includes('|') &&
      isTableDelimiterRow(next)
    ) {
      const headerCells = tableRowCells(line);
      const delimCells = tableRowCells(next);
      // Repair when the delimiter's column count differs from the header, OR
      // when it has an empty cell markdown-it would choke on. A count-matched,
      // fully-valid delimiter is left byte-for-byte untouched.
      const needsRepair =
        delimCells.length !== headerCells.length ||
        delimCells.some((c) => c.trim() === '');
      if (headerCells.length >= 1 && needsRepair) {
        const fixed: string[] = [];
        for (let k = 0; k < headerCells.length; k++) {
          fixed.push(normalizeDelimiterCell(delimCells[k]));
        }
        const prefix = (next.match(/^\s*(?:>\s*)*/) as RegExpMatchArray)[0];
        out.push(line); // header unchanged
        out.push(`${prefix}| ${fixed.join(' | ')} |`); // corrected delimiter
        i++; // skip the original malformed delimiter
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * #132 — re-indent nested list items to consistent 2-space steps.
 *
 * CommonMark turns content indented ≥4 spaces past its list item's content
 * column into an *indented code block*. So a sub-list a user typed with a Tab
 * (8 columns) under a 2-space parent silently renders as a code block with the
 * `*`/`**` markers shown literally. Typora / Obsidian re-indent instead of
 * punishing the typo; we do the same before parsing. We walk the document,
 * derive each marker's nesting depth from the sequence of indents seen so far,
 * and rewrite its leading whitespace to depth*2 spaces; continuation lines of
 * an item shift by the same delta. Fenced code and genuine top-level indented
 * code blocks (no enclosing list) are left untouched.
 */
function normalizeListIndent(source: string): string {
  const expand = (ws: string): number => {
    let n = 0;
    for (const c of ws) n += c === '\t' ? 4 - (n % 4) : 1;
    return n;
  };
  const lines = source.split('\n');
  const out: string[] = [];
  // #213 — track each level's `markerWidth` (marker glyph + trailing spaces)
  // so a nested item re-indents under its PARENT's content column instead of a
  // fixed 2-space step. Ordered markers are 3+ chars wide (`1. `, `10. `), and
  // CommonMark only nests a child when it's indented by at least the parent
  // marker width — the old flat +2 left ordered sublists under-indented, so
  // markdown-it flattened them into siblings.
  const stack: { orig: number; norm: number; markerWidth: number }[] = [];
  let inFence = false;
  let fenceChar = '';
  let curDelta = 0;
  let curOrig = -1;
  const markRe = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
  const noSpaceOrderedRe = /^([ \t]*)(\d{1,3}[.)])([^\s\d.)].*)$/;
  const cjkLeadRe = /^[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef“”‘’（【《「『]/;
  const fenceRe = /^([ \t]*)(```+|~~~+)/;
  const hasAdjacentListLine = (idx: number): boolean => {
    for (let j = idx + 1; j < lines.length; j++) {
      const next = lines[j];
      if (fenceRe.test(next)) return false;
      if (next.trim() === '') continue;
      return markRe.test(next) || noSpaceOrderedRe.test(next);
    }
    return false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = fenceRe.exec(line);
    if (fm) {
      if (!inFence) {
        inFence = true;
        fenceChar = fm[2][0];
        out.push(line);
        continue;
      }
      if (fm[2][0] === fenceChar) {
        inFence = false;
        out.push(line);
        continue;
      }
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    let m = markRe.exec(line);
    if (!m) {
      const ns = noSpaceOrderedRe.exec(line);
      if (
        ns &&
        !line.includes('|') &&
        (cjkLeadRe.test(ns[3]) || stack.length > 0 || hasAdjacentListLine(i))
      ) {
        m = [line, ns[1], ns[2], ' ', ns[3]] as unknown as RegExpExecArray;
      }
    }
    if (m) {
      const orig = expand(m[1]);
      // Content column = marker glyph + its trailing spaces. A child list must
      // clear this to nest (CommonMark), so we re-indent children to exactly it.
      const markerWidth = m[2].length + m[3].length;
      while (stack.length && orig < stack[stack.length - 1].orig) stack.pop();
      const top = stack[stack.length - 1];
      let norm: number;
      if (top && orig === top.orig) {
        norm = top.norm;
        // Siblings can differ in marker width (`9.` → `10.`); keep this item's
        // width for ITS children.
        top.markerWidth = markerWidth;
      } else if (top && orig > top.orig) {
        norm = top.norm + top.markerWidth;
        stack.push({ orig, norm, markerWidth });
      } else {
        norm = 0;
        stack.length = 0;
        stack.push({ orig, norm, markerWidth });
      }
      curDelta = norm - orig;
      curOrig = orig;
      out.push(' '.repeat(norm) + m[2] + m[3] + m[4]);
    } else if (line.replace(/^[ \t]+|[ \t]+$/g, '') === '') {
      out.push(line);
    } else {
      const leadWs = (line.match(/^[ \t]*/) as RegExpMatchArray)[0];
      const lead = expand(leadWs);
      if (stack.length && curOrig >= 0 && lead >= curOrig) {
        const top = stack[stack.length - 1];
        const next = lines[i + 1];
        if (
          top &&
          line.includes('|') &&
          !isTableDelimiterRow(line) &&
          next !== undefined &&
          next.includes('|') &&
          isTableDelimiterRow(next)
        ) {
          const tableIndent = ' '.repeat(top.norm + top.markerWidth);
          while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
            out.push(tableIndent + lines[i].trimStart());
            i++;
          }
          i--;
          continue;
        }
        out.push(' '.repeat(Math.max(0, lead + curDelta)) + line.slice(leadWs.length));
      } else {
        stack.length = 0;
        curDelta = 0;
        curOrig = -1;
        const next = lines[i + 1];
        if (
          lead >= 4 &&
          line.includes('|') &&
          !isTableDelimiterRow(line) &&
          next !== undefined &&
          next.includes('|') &&
          isTableDelimiterRow(next)
        ) {
          while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
            out.push(lines[i].trimStart());
            i++;
          }
          i--;
          continue;
        }
        out.push(line);
      }
    }
  }
  return out.join('\n');
}

/** #141 — flip the global soft-newline behavior (preview, exports, live
 *  editor all share the `md` singleton). Called by the settings store sync. */
export function setMarkdownHardBreaks(on: boolean): void {
  md.set({ breaks: on });
}

// #216 — `typographer: true` also enables markdown-it's `smartquotes` rule,
// which rewrites straight quotes to curly ones (' → U+2019). Fonts that
// resolve U+2019 through a CJK fallback draw it fullwidth, so "test's"
// renders as "test'　s" — reported as "extra space after the apostrophe",
// and the preview stops matching the typed source. Curly quotes are opt-in
// now (settings.smartQuotes); the rest of typographer ((c) → ©, --- → —,
// ellipsis) is unaffected.
md.disable('smartquotes');

/** #216 — toggle curly-quote substitution; synced from the settings store. */
export function setMarkdownSmartQuotes(on: boolean): void {
  if (on) md.enable('smartquotes');
  else md.disable('smartquotes');
}

// ---- Numbered-section auto-headings (opt-in setting) ----------------------
// Chinese reports / 公文 often write section numbers as plain text —
// `6.2 出口许可证管理目录` — with no `#`, so neither markdown-it nor Typora
// treat them as headings (a heading needs `#` + space; a bare number is just
// text). When the `markdownAutoNumberHeadings` setting is on we promote such
// lines to headings whose level tracks the numbering depth (`6.2` → h2,
// `6.2.1` → h3). Default OFF because auto-promotion is inherently heuristic
// (a line like `3.14 是圆周率` starts with a decimal too), so the user opts in.
let autoNumberHeadings = false;

/** Sync the numbered-heading toggle from the settings store. */
export function setMarkdownAutoNumberHeadings(on: boolean): void {
  autoNumberHeadings = on;
}

// Require ≥2 dot-joined numeric segments (`6.2`, `6.2.1`) so single-number
// sentences ("6 个要点") and ordered-list markers (`1.`) are never touched.
const NUMBERED_HEADING_RE = /^(\d+(?:\.\d+)+)\.?[ \t]+(\S.*?)\s*$/;
// Lines whose text ends in sentence punctuation are prose that merely opens
// with a decimal, not a section title — leave them alone.
const SENTENCE_END_RE = /[。．.！？!?，,；;、]$/;

function numberedSectionHeadings(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceChar = '';
  const fenceRe = /^(\s*)(```+|~~~+)/;
  for (const line of lines) {
    const fm = fenceRe.exec(line);
    if (fm) {
      if (!inFence) {
        inFence = true;
        fenceChar = fm[2][0];
        out.push(line);
        continue;
      }
      if (fm[2][0] === fenceChar) {
        inFence = false;
        out.push(line);
        continue;
      }
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    const m = NUMBERED_HEADING_RE.exec(line);
    if (m && !SENTENCE_END_RE.test(m[2])) {
      const depth = Math.min(6, m[1].split('.').length);
      out.push(`${'#'.repeat(depth)} ${m[1]} ${m[2]}`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * #433 — DeepSeek / ChatGPT and standard LaTeX documents often delimit display
 * math with `\[ ... \]` and inline math with `\( ... \)`. `@vscode/markdown-it-katex`
 * only parses `$$ ... $$` and `$ ... $`, and markdown-it's escape rule otherwise
 * strips `\[` / `\(` down to literal `[` / `(`, leaving raw LaTeX source on
 * screen. Normalize `\[ ... \]` → `$$ ... $$` and `\( ... \)` → `$ ... $`
 * outside fenced code blocks and inline code backtick spans, before equation
 * numbering (`numberEquations`) and markdown-it rendering.
 */
function replaceInlineLatexOnLine(line: string): string {
  if (!line.includes('\\(') && !line.includes('\\[')) return line;
  const n = line.length;
  const code = new Array<boolean>(n).fill(false);
  for (let p = 0; p < n; ) {
    if (line[p] === '`') {
      let len = 1;
      while (p + len < n && line[p + len] === '`') len++;
      let q = p + len;
      let closed = -1;
      while (q < n) {
        if (line[q] === '`') {
          let len2 = 1;
          while (q + len2 < n && line[q + len2] === '`') len2++;
          if (len2 === len) {
            closed = q + len2;
            break;
          }
          q += len2;
        } else {
          q++;
        }
      }
      if (closed >= 0) {
        for (let k = p; k < closed; k++) code[k] = true;
        p = closed;
      } else {
        p += len;
      }
    } else {
      p++;
    }
  }

  let out = '';
  let i = 0;
  while (i < n) {
    if (
      !code[i] &&
      line[i] === '\\' &&
      (i === 0 || line[i - 1] !== '\\') &&
      (line[i + 1] === '(' || line[i + 1] === '[')
    ) {
      const isDisplay = line[i + 1] === '[';
      const closeChar = isDisplay ? ']' : ')';
      let j = i + 2;
      let close = -1;
      while (j < n - 1) {
        if (!code[j] && line[j] === '\\' && line[j + 1] === closeChar) {
          // Ensure the backslash isn't itself escaped (`\\)`).
          let bs = 0;
          let k = j;
          while (k >= i + 2 && line[k] === '\\') {
            bs++;
            k--;
          }
          if (bs % 2 === 1) {
            close = j;
            break;
          }
        }
        j++;
      }
      if (close >= 0) {
        const inner = line.slice(i + 2, close).trim();
        if (inner) {
          const delim = isDisplay ? '$$' : '$';
          const prevChar = out.length > 0 ? out[out.length - 1] : '';
          const nextChar = close + 2 < n ? line[close + 2] : '';
          const leadSpace = !isDisplay && prevChar && /[\w\d]/.test(prevChar) ? ' ' : '';
          const trailSpace = !isDisplay && nextChar && /[\w\d]/.test(nextChar) ? ' ' : '';
          out += `${leadSpace}${delim}${inner}${delim}${trailSpace}`;
          i = close + 2;
          continue;
        }
      }
    }
    out += line[i];
    i++;
  }
  return out;
}

export function normalizeLatexDelimiters(source: string): string {
  if (!source || (!source.includes('\\[') && !source.includes('\\('))) {
    return source;
  }
  const lines = source.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceChar = '';
  const fenceRe = /^(\s*)(```+|~~~+)/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fm = fenceRe.exec(line);
    if (fm) {
      if (!inFence) {
        inFence = true;
        fenceChar = fm[2][0];
        out.push(line);
        i++;
        continue;
      }
      if (fm[2][0] === fenceChar) {
        inFence = false;
        out.push(line);
        i++;
        continue;
      }
    }
    if (inFence) {
      out.push(line);
      i++;
      continue;
    }

    // Whole-line single-line display math: `\[ ... \]`
    const singleBlock = /^(\s*)\\\[(.+?)\\\]\s*$/.exec(line);
    if (singleBlock && !line.includes('`')) {
      const indent = singleBlock[1];
      const inner = singleBlock[2].trim();
      if (inner && !inner.includes('\\]')) {
        out.push(`${indent}$$${inner}$$`);
        i++;
        continue;
      }
    }

    // Multi-line display math opening with `\[` (alone on line or with leading TeX)
    const openBlock = /^(\s*)\\\[\s*(.*)$/.exec(line);
    if (openBlock && !line.includes('`')) {
      const indent = openBlock[1];
      const firstRest = openBlock[2];
      // Scan forward for matching `\]` before next fence or end of doc
      let closeIdx = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (fenceRe.test(lines[j])) break;
        if (/\\\]\s*$/.test(lines[j])) {
          closeIdx = j;
          break;
        }
      }
      if (closeIdx > i) {
        out.push(`${indent}$$`);
        if (firstRest.trim()) {
          out.push(`${indent}${firstRest}`);
        }
        for (let k = i + 1; k < closeIdx; k++) {
          out.push(lines[k]);
        }
        const closeLine = lines[closeIdx];
        const closeMatch = /^(\s*)(.*?)\\\]\s*$/.exec(closeLine);
        if (closeMatch) {
          if (closeMatch[2].trim()) {
            out.push(`${closeMatch[1]}${closeMatch[2]}`);
          }
          out.push(`${indent}$$`);
        } else {
          out.push(`${indent}$$`);
        }
        i = closeIdx + 1;
        continue;
      }
    }

    out.push(replaceInlineLatexOnLine(line));
    i++;
  }

  return out.join('\n');
}

/**
 * Run the source through every leniency preprocessor (inline-HTML-block
 * unwrapping #71, malformed table-delimiter repair, list re-indent #132) that
 * makes AI/PDF-exported Markdown render like Typora/Obsidian. Both the HTML
 * render path (`renderMarkdown`) and the DOCX token path (`markdownToDocxBlob`
 * via `md.parse`) must apply this identically, so it lives here as the single
 * source of truth. The numbered-section step is gated behind its opt-in
 * setting.
 */
// Converts backslashes to forward slashes in markdown image destinations
// so that Windows paths like `![x](E:\photos\a.png)` survive markdown-it's
// CommonMark escape processing (which strips `\p` → `p`, `\i` → `i`, etc.).
// LiveEdit mode reads the raw source and is unaffected; only the preview /
// split / PDF / DOCX pipelines go through markdown-it and need this.
function normalizeImageBackslashPaths(source: string): string {
  if (!source.includes('\\')) return source;
  const lines = source.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceChar = '';
  const fenceRe = /^(\s*)(```+|~~~+)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = fenceRe.exec(line);
    if (fm) {
      if (!inFence) {
        inFence = true;
        fenceChar = fm[2][0];
        out.push(line);
        continue;
      }
      if (fm[2][0] === fenceChar && fm[2].length >= 3) {
        inFence = false;
        fenceChar = '';
      }
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    // Match ![alt](path) where path contains backslashes.
    // The path is everything between ( and ) that is not ) or whitespace at the end.
    out.push(
      line.replace(
        /(!\[[^\]]*\]\()([^)\n]+?)(\s*\))/g,
        (_match, prefix: string, path: string, suffix: string) =>
          prefix + path.replace(/\\/g, '/') + suffix,
      ),
    );
  }
  return out.join('\n');
}

function normalizeFullwidthEscapes(source: string): string {
  if (!source.includes('\\')) return source;
  const lines = source.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = '';
  const fenceRe = /^(\s*)(```+|~~~+)/;
  for (const line of lines) {
    const m = fenceRe.exec(line);
    if (m) {
      if (!inFence) {
        inFence = true;
        fenceMarker = m[2][0];
      } else if (m[2][0] === fenceMarker && line.trim() === m[2]) {
        inFence = false;
        fenceMarker = '';
      }
      out.push(line);
      continue;
    }
    if (inFence || !line.includes('\\')) {
      out.push(line);
      continue;
    }
    // Preserve inline code spans while unescaping `\` before fullwidth CJK punctuation
    const parts = line.split(/(`+[^`]*`+)/g);
    out.push(
      parts
        .map((seg, i) =>
          i % 2 === 1
            ? seg
            : seg.replace(/\\([＃＊＿～｀［］（）｛｝｜！＞＋－．、【】《》“”‘’：；，。？])/g, '$1'),
        )
        .join(''),
    );
  }
  return out.join('\n');
}

export function preprocessMarkdown(source: string): string {
  const clean = (source || '').replace(/\r\n?/g, '\n');
  let s = normalizeTableDelimiters(unwrapInlineHtmlBlocks(clean));
  s = normalizeLatexDelimiters(s);
  s = normalizeImageBackslashPaths(s);
  s = normalizeFullwidthEscapes(s);
  if (autoNumberHeadings) s = numberedSectionHeadings(s);
  // `\label` / `\eqref` are LaTeX that KaTeX does not implement — resolve
  // them to `\tag` + anchors + links here so preview, PDF, Word and image
  // export all number equations the same way, from one place.
  s = numberEquations(s).text;
  return normalizeListIndent(s);
}

export function renderMarkdown(
  source: string,
  options?: { breaks?: boolean; tocSource?: string },
): string {
  lastFrontMatterRaw = null;
  const normalized = preprocessMarkdown(source);
  const env: Record<string, unknown> = {};
  if (options?.tocSource !== undefined) {
    env.solomdTocSource = preprocessMarkdown(options.tocSource);
  }
  const prevBreaks = md.options.breaks;
  if (options?.breaks !== undefined) md.set({ breaks: options.breaks });
  let body = '';
  try {
    body = md.render(normalized, env);
  } finally {
    if (options?.breaks !== undefined) md.set({ breaks: prevBreaks });
  }
  if (lastFrontMatterRaw !== null) {
    const fmHtml = renderFrontMatterHtml(lastFrontMatterRaw);
    lastFrontMatterRaw = null;
    body = fmHtml + body;
  }
  // #304 — single choke point. Every consumer of rendered markdown (preview,
  // the live-block editor, slideshow, PDF/image/HTML export) goes through
  // here, so sanitizing the return value covers all of them at once.
  return sanitizeRenderedHtml(body);
}

/**
 * Extract the `imageRoot` field from a document's YAML front matter.
 * Supports aliases `image_root` and (Typora) `typora-root-url`.
 * Returns null if no front matter or no such field.
 *
 * Parsing is a minimal regex — we don't want a full YAML dep just for this.
 * Good enough for single-line string values like:
 *   imageRoot: ./images
 *   imageRoot: "D:\\blog\\assets"
 *   imageRoot: '/Users/foo/blog/assets'
 */
export function extractImageRoot(source: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!m) return null;
  const fm = m[1];
  const im = /^(?:imageRoot|image_root|typora-root-url)\s*:\s*(.+?)\s*$/m.exec(fm);
  if (!im) return null;
  return im[1].replace(/^["']|["']$/g, '').trim() || null;
}

export interface OutlineItem {
  level: number;
  text: string;
  slug: string;
  line: number;
}

export function extractOutline(source: string): OutlineItem[] {
  const lines = (source || '').replace(/\r\n?/g, '\n').split('\n');
  const items: OutlineItem[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const level = m[1].length;
      const text = m[2];
      items.push({ level, text, slug: slugify(text), line: i + 1 });
    }
  }
  return items;
}

/**
 * #418 — Reorder a Markdown heading section (from `sourceHeadingLine` up to the
 * next heading of equal or higher rank) before or after `targetHeadingLine`'s
 * section.
 */
export function reorderMarkdownHeadingSection(
  source: string,
  sourceHeadingLine: number,
  targetHeadingLine: number,
  position: 'before' | 'after' = 'before',
): string {
  if (!source || sourceHeadingLine === targetHeadingLine) return source;
  const outline = extractOutline(source);
  const srcIdx = outline.findIndex((h) => h.line === sourceHeadingLine);
  const dstIdx = outline.findIndex((h) => h.line === targetHeadingLine);
  if (srcIdx < 0 || dstIdx < 0) return source;

  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const sectionRange = (idx: number): [number, number] => {
    const h = outline[idx];
    const start = h.line - 1;
    let end = lines.length;
    for (let j = idx + 1; j < outline.length; j++) {
      if (outline[j].level <= h.level) {
        end = outline[j].line - 1;
        break;
      }
    }
    return [start, end];
  };

  const [srcStart, srcEnd] = sectionRange(srcIdx);
  const [dstStart, dstEnd] = sectionRange(dstIdx);
  const insertAt = position === 'before' ? dstStart : dstEnd;
  if (insertAt >= srcStart && insertAt <= srcEnd) {
    return source;
  }

  const moved = lines.slice(srcStart, srcEnd);
  const remaining = [...lines.slice(0, srcStart), ...lines.slice(srcEnd)];
  const adjustedInsert = insertAt > srcStart ? insertAt - (srcEnd - srcStart) : insertAt;
  remaining.splice(adjustedInsert, 0, ...moved);
  return remaining.join('\n');
}
