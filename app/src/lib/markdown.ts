import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import hljs from 'highlight.js/lib/common';
import 'katex/contrib/mhchem';
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

// NOTE: `@hedgedoc/markdown-it-task-lists` is installed but unusable here —
// its compiled ESM entry does `import Token from 'markdown-it/lib/token.js'`
// which markdown-it@14 no longer exposes as a subpath, so Rollup can't
// resolve it. We implement the same behaviour inline below as a core rule,
// which also lets us attach `data-line` in the same pass.

const katexPlugin: any = (katex as any).default ?? katex;

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
// edge cases markdown can't express. CSP in tauri.conf.json is `null` for
// the local webview, but this app only ever renders the user's own files
// — no untrusted input — so the security tradeoff is the same as Typora /
// Obsidian (both ship with HTML on by default). See issue #54.
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
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {}
    }
    // Unknown language: let hljs auto-detect for a best-effort highlight.
    try {
      return hljs.highlightAuto(code).value;
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
  .use(katexPlugin, { throwOnError: false })
  .use(footnote)
  .use(mark)
  .use(cjkFriendly);

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
md.renderer.rules.fence = function (tokens, idx, options, env, self) {
  const html = defaultFenceRenderer
    ? defaultFenceRenderer(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
  // Skip mermaid — Preview.vue replaces these blocks with rendered SVGs.
  // Skip tldraw (F7) the same way — Preview.vue swaps the ```tldraw fence for
  // a static board SVG thumbnail (the language class survives so the
  // post-processor can find it).
  const tok = tokens[idx];
  const info = (tok.info || '').trim().toLowerCase();
  const lang = info.split(/\s+/)[0];
  if (lang === 'mermaid' || lang === 'tldraw') return html;
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
    const trimmed = inner.endsWith('\n') ? inner.slice(0, -1) : inner;
    const openSpans: string[] = [];
    let out = '';
    let line = '';
    const flush = () => {
      out += `<span class="cb-line">${line || ' '}</span>`;
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

// Raw HTML blocks render their content verbatim — attrJoin above never reaches
// the output, so documents built around `<div>…<img>…</div>` containers had no
// sync anchors at all and the split panes drifted apart across those regions
// (#203 双栏错位). Wrap the raw block in a neutral div carrying the line.
const defaultHtmlBlock = md.renderer.rules.html_block;
md.renderer.rules.html_block = function (tokens, idx, options, env, self) {
  const html = defaultHtmlBlock
    ? defaultHtmlBlock(tokens, idx, options, env, self)
    : tokens[idx].content;
  const tok = tokens[idx];
  const line = tok.map && tok.map.length > 0 ? tok.map[0] + 1 : 0;
  if (!line) return html;
  return `<div data-source-line="${line}">${html}</div>`;
};

// Custom core rule: detect GitHub-style task list items (a leading
// `[ ]` / `[x]` in the first inline child of a list item) and:
//   1. add a `task-list-item` class to the <li>
//   2. replace the `[ ] ` / `[x] ` text prefix with an <input type="checkbox">
//   3. attach `data-line="N"` (1-indexed source line) to the <li>
// We also tag the enclosing <ul>/<ol> with `contains-task-list` so
// integrators can strip bullet markers.
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
        return `\n\n${html}\n\n`;
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
 *  trailing cells produced by an outer `| … |` border. */
function tableRowCells(line: string): string[] {
  const cells = splitTableRow(line.trim());
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
        const indent = (next.match(/^\s*/) as RegExpMatchArray)[0];
        out.push(line); // header unchanged
        out.push(`${indent}| ${fixed.join(' | ')} |`); // corrected delimiter
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
  const markRe = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
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
    const m = markRe.exec(line);
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
    } else if (line.trim() === '') {
      out.push(line);
    } else {
      const leadWs = (line.match(/^\s*/) as RegExpMatchArray)[0];
      const lead = expand(leadWs);
      if (stack.length && curOrig >= 0 && lead >= curOrig) {
        out.push(' '.repeat(Math.max(0, lead + curDelta)) + line.slice(leadWs.length));
      } else {
        stack.length = 0;
        curDelta = 0;
        curOrig = -1;
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
 * Run the source through every leniency preprocessor (inline-HTML-block
 * unwrapping #71, malformed table-delimiter repair, list re-indent #132) that
 * makes AI/PDF-exported Markdown render like Typora/Obsidian. Both the HTML
 * render path (`renderMarkdown`) and the DOCX token path (`markdownToDocxBlob`
 * via `md.parse`) must apply this identically, so it lives here as the single
 * source of truth. The numbered-section step is gated behind its opt-in
 * setting.
 */
export function preprocessMarkdown(source: string): string {
  let s = normalizeTableDelimiters(unwrapInlineHtmlBlocks(source || ''));
  if (autoNumberHeadings) s = numberedSectionHeadings(s);
  // `\label` / `\eqref` are LaTeX that KaTeX does not implement — resolve
  // them to `\tag` + anchors + links here so preview, PDF, Word and image
  // export all number equations the same way, from one place.
  s = numberEquations(s).text;
  return normalizeListIndent(s);
}

export function renderMarkdown(source: string, options?: { breaks?: boolean }): string {
  lastFrontMatterRaw = null;
  const normalized = preprocessMarkdown(source);
  const prevBreaks = md.options.breaks;
  if (options?.breaks !== undefined) md.set({ breaks: options.breaks });
  let body = '';
  try {
    body = md.render(normalized);
  } finally {
    if (options?.breaks !== undefined) md.set({ breaks: prevBreaks });
  }
  if (lastFrontMatterRaw !== null) {
    const fmHtml = renderFrontMatterHtml(lastFrontMatterRaw);
    lastFrontMatterRaw = null;
    return fmHtml + body;
  }
  return body;
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
  const lines = source.split('\n');
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
