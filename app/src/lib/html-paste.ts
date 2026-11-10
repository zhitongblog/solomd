/**
 * #308 — Convert rich-text HTML clipboard content (copied from web pages,
 * Word, Google Docs, Notion, Feishu/Lark, Yuque, etc.) into clean Markdown
 * on paste.
 *
 * Design principles:
 * 1. Never hijack plain code/IDE pastes: VS Code, JetBrains, and terminals put
 *    syntax-colored `<div><span>…</span></div>` on `text/html` without semantic
 *    document tags. We only activate when semantic rich-text elements (`h1-h6`,
 *    `strong`/`b`, `em`/`i`, `del`/`s`/`strike`, `mark`, `sup`, `sub`, `code`,
 *    `pre`, `a[href]`, `ul`/`ol`/`li`, `blockquote`, `table`, `hr`, `img[src]`)
 *    are genuinely present.
 * 2. Preserve nested structure: nested lists (`<ul>`/`<ol>`), task-list
 *    checkboxes (`<input type="checkbox">`), blockquotes, fenced code blocks
 *    with language hints (`class="language-ts"`), and GFM tables.
 * 3. Safe fallback: if conversion yields nothing meaningful or matches the
 *    plain-text clipboard verbatim, return `null` so normal paste proceeds.
 */

import { htmlTableToMarkdown } from './table-paste';

const SEMANTIC_HTML_RE =
  /<(?:h[1-6]|strong|b|em|i|del|s|strike|mark|sup|sub|code|pre|ul|ol|li|blockquote|table|hr)\b|<a\b[^>]*\bhref\s*=|<img\b[^>]*\bsrc\s*=/i;

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

interface HtmlTextNode {
  type: 'text';
  value: string;
}

interface HtmlElementNode {
  type: 'element';
  tag: string;
  attrs: Record<string, string>;
  rawHtml?: string;
  parent: HtmlElementNode | null;
  children: HtmlAstNode[];
}

type HtmlAstNode = HtmlTextNode | HtmlElementNode;

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    });
}

function parseAttributes(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = decodeEntities(val);
  }
  return attrs;
}

function parseHtmlAst(fragment: string): HtmlElementNode {
  const cleaned = fragment
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(?:script|style|noscript|head|svg)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|head|svg)\s*>/gi, '');

  const root: HtmlElementNode = {
    type: 'element',
    tag: 'body',
    attrs: {},
    parent: null,
    children: [],
  };

  const stack: HtmlElementNode[] = [root];
  const tokenRe = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(cleaned)) !== null) {
    const [, closingSlash, rawTag, rawAttrs, selfClosingSlash, textChunk] = m;
    const current = stack[stack.length - 1];

    if (textChunk !== undefined) {
      current.children.push({
        type: 'text',
        value: decodeEntities(textChunk),
      });
      continue;
    }

    const tag = rawTag.toLowerCase();
    const isClosing = closingSlash === '/';
    const isSelfClosing = selfClosingSlash === '/' || VOID_TAGS.has(tag);

    if (isClosing) {
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    // Special case: capture full `<table>...</table>` raw HTML for `htmlTableToMarkdown`
    if (tag === 'table') {
      const tableStart = m.index;
      const closeRe = /<\/table\s*>/gi;
      closeRe.lastIndex = tokenRe.lastIndex;
      const closeMatch = closeRe.exec(cleaned);
      if (closeMatch) {
        const tableEnd = closeMatch.index + closeMatch[0].length;
        const rawTable = cleaned.slice(tableStart, tableEnd);
        current.children.push({
          type: 'element',
          tag: 'table',
          attrs: parseAttributes(rawAttrs),
          rawHtml: rawTable,
          parent: current,
          children: [],
        });
        tokenRe.lastIndex = tableEnd;
        continue;
      }
    }

    // Auto-close sibling `<li>` or `<p>` when a new `<li>` opens at the same list level
    if (tag === 'li' && current.tag === 'li') {
      stack.pop();
    } else if (tag === 'p' && current.tag === 'p') {
      stack.pop();
    }

    const parentNode = stack[stack.length - 1];
    const el: HtmlElementNode = {
      type: 'element',
      tag,
      attrs: parseAttributes(rawAttrs),
      parent: parentNode,
      children: [],
    };
    parentNode.children.push(el);
    if (!isSelfClosing) {
      stack.push(el);
    }
  }

  return root;
}

function getTextContent(node: HtmlAstNode): string {
  if (node.type === 'text') return node.value;
  return node.children.map(getTextContent).join('');
}

function findFirstElement(
  node: HtmlElementNode,
  predicate: (el: HtmlElementNode) => boolean,
): HtmlElementNode | null {
  for (const child of node.children) {
    if (child.type === 'element') {
      if (predicate(child)) return child;
      const found = findFirstElement(child, predicate);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Detect whether the HTML clipboard payload was produced by a code editor
 * (VS Code / Monaco) where every token is just `<span style="color:...">`.
 */
function isCodeEditorHtml(html: string): boolean {
  if (/data-metadata\s*=\s*["'][^"']*vscode/i.test(html)) return true;
  if (!SEMANTIC_HTML_RE.test(html)) return true;
  return false;
}

function extractFragment(html: string): string {
  const startMarker = '<!--StartFragment-->';
  const endMarker = '<!--EndFragment-->';
  const s = html.indexOf(startMarker);
  const e = html.indexOf(endMarker);
  if (s >= 0 && e > s) {
    return html.slice(s + startMarker.length, e);
  }
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  if (bodyMatch) return bodyMatch[1];
  return html;
}

function extractCodeLang(el: HtmlElementNode): string {
  const candidates = [
    el.attrs['data-lang'],
    el.attrs['data-language'],
    el.attrs['class'],
    el.parent?.attrs['data-lang'],
    el.parent?.attrs['data-language'],
    el.parent?.attrs['class'],
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const m = /(?:language-|lang-|brush:\s*)([a-z0-9_+-]+)/i.exec(raw);
    if (m) return m[1].toLowerCase();
    const token = raw.trim().toLowerCase();
    if (/^[a-z0-9_+-]{1,20}$/.test(token) && !['code', 'pre', 'highlight', 'hljs', 'prism'].includes(token)) {
      return token;
    }
  }
  return '';
}

interface ConvertContext {
  inPre: boolean;
  inHeading: boolean;
  inTable: boolean;
  listDepth: number;
}

function normalizeInlineText(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/\u00a0/g, ' ');
}

function wrapInlineMarker(inner: string, marker: string): string {
  if (!inner) return '';
  const lead = /^\s+/.exec(inner)?.[0] ?? '';
  const trail = /\s+$/.exec(inner)?.[0] ?? '';
  const core = inner.slice(lead.length, inner.length - trail.length);
  if (!core) return inner;
  return `${lead}${marker}${core}${marker}${trail}`;
}

function serializeChildren(node: HtmlElementNode, ctx: ConvertContext): string {
  let out = '';
  for (const child of node.children) {
    out += serializeNode(child, ctx);
  }
  return out;
}

function serializeList(listEl: HtmlElementNode, ordered: boolean, ctx: ConvertContext): string {
  const startAttr = ordered ? Number.parseInt(listEl.attrs['start'] || '1', 10) : 1;
  let index = Number.isFinite(startAttr) && startAttr > 0 ? startAttr : 1;
  const items: string[] = [];
  const indent = '  '.repeat(ctx.listDepth);

  for (const child of listEl.children) {
    if (child.type !== 'element') continue;
    const tag = child.tag;
    if (tag !== 'li') {
      if (tag === 'ul' || tag === 'ol') {
        const nested = serializeList(child, tag === 'ol', {
          ...ctx,
          listDepth: ctx.listDepth + 1,
        }).trimEnd();
        if (nested) items.push(nested);
      }
      continue;
    }

    // Check for direct task list checkbox (`<input type="checkbox">`)
    let taskPrefix = '';
    const firstInput = findFirstElement(
      child,
      (el) => el.tag === 'input' && (el.attrs['type'] || '').toLowerCase() === 'checkbox',
    );
    if (firstInput) {
      const checked = 'checked' in firstInput.attrs && firstInput.attrs['checked'] !== 'false';
      taskPrefix = checked ? '[x] ' : '[ ] ';
    }

    const bodyParts: string[] = [];
    const nestedLists: string[] = [];
    for (const liChild of child.children) {
      if (liChild.type === 'element') {
        const liTag = liChild.tag;
        if (liTag === 'ul' || liTag === 'ol') {
          const nested = serializeList(liChild, liTag === 'ol', {
            ...ctx,
            listDepth: ctx.listDepth + 1,
          }).trimEnd();
          if (nested) nestedLists.push(nested);
          continue;
        }
        if (liTag === 'input' && (liChild.attrs['type'] || '').toLowerCase() === 'checkbox') {
          continue;
        }
      }
      bodyParts.push(serializeNode(liChild, { ...ctx, listDepth: ctx.listDepth + 1 }));
    }

    const bodyText = bodyParts
      .join('')
      .replace(/^\s+|\s+$/g, '')
      .replace(/\n{2,}/g, '\n');
    const bullet = ordered ? `${index++}. ` : '- ';
    const lines = bodyText ? bodyText.split('\n') : [''];
    const firstLine = `${indent}${bullet}${taskPrefix}${lines[0]}`;
    const restLines = lines.slice(1).map((l) => (l.trim() ? `${indent}  ${l}` : ''));
    const fullItem = [firstLine, ...restLines.filter(Boolean), ...nestedLists].join('\n');
    items.push(fullItem);
  }

  if (items.length === 0) return '';
  return ctx.listDepth === 0 ? `\n\n${items.join('\n')}\n\n` : items.join('\n');
}

function serializeNode(node: HtmlAstNode, ctx: ConvertContext): string {
  if (node.type === 'text') {
    const raw = node.value;
    if (ctx.inPre) return raw.replace(/\u00a0/g, ' ');
    return normalizeInlineText(raw);
  }

  const el = node;
  const tag = el.tag;

  if (tag === 'br') {
    return ctx.inPre || ctx.inTable ? '\n' : '  \n';
  }

  if (tag === 'hr') {
    return '\n\n---\n\n';
  }

  const headingMatch = /^h([1-6])$/.exec(tag);
  if (headingMatch) {
    const level = Number.parseInt(headingMatch[1], 10);
    const inner = serializeChildren(el, { ...ctx, inHeading: true })
      .replace(/\s*\n+\s*/g, ' ')
      .trim();
    if (!inner) return '';
    return `\n\n${'#'.repeat(level)} ${inner}\n\n`;
  }

  if (tag === 'p') {
    const inner = serializeChildren(el, ctx).trim();
    if (!inner) return '';
    return ctx.listDepth > 0 ? `${inner}\n` : `\n\n${inner}\n\n`;
  }

  if (
    tag === 'div' ||
    tag === 'section' ||
    tag === 'article' ||
    tag === 'main' ||
    tag === 'header' ||
    tag === 'footer'
  ) {
    const inner = serializeChildren(el, ctx);
    if (!inner.trim()) return '';
    if (ctx.listDepth > 0) return `${inner.trim()}\n`;
    return `\n${inner}\n`;
  }

  if (tag === 'strong' || tag === 'b') {
    const inner = serializeChildren(el, ctx);
    if (ctx.inHeading) return inner;
    return wrapInlineMarker(inner, '**');
  }

  if (tag === 'em' || tag === 'i') {
    const inner = serializeChildren(el, ctx);
    return wrapInlineMarker(inner, '*');
  }

  if (tag === 'del' || tag === 's' || tag === 'strike') {
    const inner = serializeChildren(el, ctx);
    return wrapInlineMarker(inner, '~~');
  }

  if (tag === 'mark') {
    const inner = serializeChildren(el, ctx);
    return wrapInlineMarker(inner, '==');
  }

  if (tag === 'u') {
    const inner = serializeChildren(el, ctx);
    if (!inner.trim()) return inner;
    return `<u>${inner}</u>`;
  }

  if (tag === 'sup') {
    const inner = serializeChildren(el, ctx).trim();
    if (!inner) return '';
    return /\s/.test(inner) ? `<sup>${inner}</sup>` : `^${inner}^`;
  }

  if (tag === 'sub') {
    const inner = serializeChildren(el, ctx).trim();
    if (!inner) return '';
    return /\s/.test(inner) ? `<sub>${inner}</sub>` : `~${inner}~`;
  }

  if (tag === 'code' && !ctx.inPre) {
    const inner = getTextContent(el).replace(/\r?\n/g, ' ').replace(/\u00a0/g, ' ');
    if (!inner) return '';
    const tickRun = inner.includes('`') ? '``' : '`';
    const pad = inner.startsWith('`') || inner.endsWith('`') ? ' ' : '';
    return `${tickRun}${pad}${inner}${pad}${tickRun}`;
  }

  if (tag === 'pre') {
    const codeEl = findFirstElement(el, (c) => c.tag === 'code') ?? el;
    const lang = extractCodeLang(codeEl) || extractCodeLang(el);
    const rawCode = serializeChildren(codeEl, { ...ctx, inPre: true })
      .replace(/\r\n?/g, '\n')
      .replace(/^\n+|\n+$/g, '');
    const fence = rawCode.includes('```') ? '~~~~' : '```';
    return `\n\n${fence}${lang}\n${rawCode}\n${fence}\n\n`;
  }

  if (tag === 'a') {
    const href = (el.attrs['href'] || '').trim();
    const inner = serializeChildren(el, ctx).trim();
    if (!href || /^javascript:/i.test(href) || href === '#') {
      return inner;
    }
    const label = inner || href;
    return `[${label}](${href})`;
  }

  if (tag === 'img') {
    const src = (el.attrs['src'] || '').trim();
    const alt = (el.attrs['alt'] || '').trim().replace(/[\r\n]+/g, ' ');
    if (!src || /^data:/i.test(src) || /^blob:/i.test(src)) return '';
    return `![${alt}](${src})`;
  }

  if (tag === 'ul' || tag === 'ol') {
    return serializeList(el, tag === 'ol', ctx);
  }

  if (tag === 'blockquote') {
    const inner = serializeChildren(el, ctx).trim();
    if (!inner) return '';
    const quoted = inner
      .split('\n')
      .map((line) => (line.trim() ? `> ${line}` : '>'))
      .join('\n');
    return `\n\n${quoted}\n\n`;
  }

  if (tag === 'table' && el.rawHtml) {
    const mdTable = htmlTableToMarkdown(el.rawHtml);
    if (mdTable) return `\n\n${mdTable}\n\n`;
  }

  return serializeChildren(el, ctx);
}

/**
 * Convert a rich-text HTML string from the clipboard into clean Markdown, or
 * return `null` when the clipboard does not contain rich HTML structure worth
 * converting (so the caller falls back to `text/plain`).
 */
export function clipboardHtmlToMarkdown(
  html: string | null | undefined,
  plainText?: string | null | undefined,
): string | null {
  if (!html || typeof html !== 'string') return null;
  const fragment = extractFragment(html).trim();
  if (!fragment || isCodeEditorHtml(fragment)) return null;

  // If the plain text already looks like raw Markdown copied by the user (e.g.
  // starts with `# `, ``` or markdown link syntax), keep the plain text as-is.
  if (
    plainText &&
    (/(?:^|\n)#{1,6}\s+\S/.test(plainText) ||
      /(?:^|\n)```/.test(plainText) ||
      /\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(plainText))
  ) {
    return null;
  }

  const root = parseHtmlAst(fragment);
  const rawMd = serializeChildren(root, {
    inPre: false,
    inHeading: false,
    inTable: false,
    listDepth: 0,
  });

  const cleaned = rawMd
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleaned) return null;
  if (plainText && cleaned === plainText.replace(/\r\n?/g, '\n').trim()) {
    return null;
  }
  return cleaned;
}
