import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import hljs from 'highlight.js/lib/common';
// @ts-ignore — types are loose
import katex from '@vscode/markdown-it-katex';
// @ts-ignore — no types shipped
import footnote from 'markdown-it-footnote';
// @ts-ignore — no types shipped
import frontMatter from 'markdown-it-front-matter';
// @ts-ignore — no types shipped
import mark from 'markdown-it-mark';
import yaml from 'js-yaml';

// NOTE: `@hedgedoc/markdown-it-task-lists` is installed but unusable here —
// its compiled ESM entry does `import Token from 'markdown-it/lib/token.js'`
// which markdown-it@14 no longer exposes as a subpath, so Rollup can't
// resolve it. We implement the same behaviour inline below as a core rule,
// which also lets us attach `data-line` in the same pass.

const katexPlugin: any = (katex as any).default ?? katex;

// Per-render front-matter capture. markdown-it is synchronous so a
// module-level variable is safe for sequential calls, but this is NOT
// concurrent-safe across interleaved renders.
let lastFrontMatterRaw: string | null = null;

export const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
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
  .use(mark);

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
md.core.ruler.push('source_line_map', (state) => {
  for (const tok of state.tokens) {
    if (!BLOCK_OPEN_TYPES.has(tok.type)) continue;
    if (!tok.map || tok.map.length < 1) continue;
    const line = tok.map[0] + 1; // 1-indexed
    tok.attrJoin('data-source-line', String(line));
  }
});

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

export function renderMarkdown(source: string): string {
  lastFrontMatterRaw = null;
  const body = md.render(source || '');
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
