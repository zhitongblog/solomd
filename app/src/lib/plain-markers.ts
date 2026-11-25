/**
 * plain-markers.ts — marker-aware source renders for the Windows plain-block
 * live editor.
 *
 * The plain editor keeps every block's Markdown source in a <textarea>; the
 * rendered view beside it is a <div> with the same box metrics so swapping
 * between them never moves the page. Two flavors exist:
 *
 * - `renderPlainVisibleMarkers` — the "always show markers" mode: the source is
 *   emitted verbatim and each marker token gets a `plain-md-marker` span so CSS
 *   can dim it.
 * - `renderPlainMirror` — the "pure WYSIWYG" editing surface (#698): same
 *   source-metric layout, but every marker token (and whole marker lines such
 *   as code fences, `$$`/`$$`, `:::` containers and setext underlines) sits
 *   inside a `plain-md-marker` span so `visibility: hidden` removes it from
 *   view while preserving its position. That keeps the transparent-textarea
 *   overlay's caret and selection aligned with the visible text.
 */

export function escapePlainHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatPlainInlineWithMarkers(raw: string): string {
  const codeSpans: string[] = [];
  const withCodePlaceholders = raw.replace(/(`+)([^`\n]+?)\1/g, (_m, ticks: string, inner: string) => {
    const idx = codeSpans.length;
    codeSpans.push(
      `<span class="plain-md-marker">${escapePlainHtml(ticks)}</span><code>${escapePlainHtml(inner)}</code><span class="plain-md-marker">${escapePlainHtml(ticks)}</span>`,
    );
    return `\u0000CODE${idx}\u0000`;
  });
  let out = escapePlainHtml(withCodePlaceholders);
  out = out.replace(
    /\[\[([^\]\n]+)\]\]/g,
    '<span class="plain-md-marker">[[</span><a class="md-wikilink" data-wikilink="$1">$1</a><span class="plain-md-marker">]]</span>',
  );
  out = out.replace(
    /(!?)\[([^\]\n]+)\]\(([^)\n]+)\)/g,
    '<span class="plain-md-marker">$1[</span><a href="$3">$2</a><span class="plain-md-marker">]($3)</span>',
  );
  out = out.replace(
    /(\*\*|__)([^\n]+?)\1/g,
    '<span class="plain-md-marker">$1</span><strong>$2</strong><span class="plain-md-marker">$1</span>',
  );
  out = out.replace(
    /(~~)([^\n]+?)\1/g,
    '<span class="plain-md-marker">$1</span><del>$2</del><span class="plain-md-marker">$1</span>',
  );
  out = out.replace(
    /(==)([^\n]+?)\1/g,
    '<span class="plain-md-marker">$1</span><mark>$2</mark><span class="plain-md-marker">$1</span>',
  );
  out = out.replace(
    /(^|[^*])(\*)([^*\n]+?)\2(?!\*)/g,
    '$1<span class="plain-md-marker">$2</span><em>$3</em><span class="plain-md-marker">$2</span>',
  );
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => codeSpans[Number(idx)] ?? '');
  return out;
}

/**
 * #536 — When `alwaysShowMarkers` is on in the Windows plain-block live editor,
 * render text/heading/list/quote blocks with their exact Markdown markers preserved
 * and matching `.plain-block__textarea` box metrics so clicking any line never
 * causes layout shift or page jumping.
 */
export function renderPlainVisibleMarkers(src: string): string {
  const singleHeading = /^(\s*(#{1,6})\s+)(.*)$/.exec(src);
  if (singleHeading && !src.includes('\n')) {
    const level = singleHeading[2].length;
    return `<h${level} class="plain-block__markers"><span class="plain-md-marker">${escapePlainHtml(singleHeading[1])}</span>${formatPlainInlineWithMarkers(singleHeading[3])}</h${level}>`;
  }
  const lines = src.split('\n').map((line) => {
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      return `<span class="plain-md-marker">${escapePlainHtml(line)}</span>`;
    }
    const prefixMatch = /^(\s*(?:[-+*]\s+\[[ xX]\]\s+|(?:[-+*]|\d+[.)])\s+|(?:>\s?)+|#{1,6}\s+))(.*)$/.exec(
      line,
    );
    if (prefixMatch) {
      return `<span class="plain-md-marker">${escapePlainHtml(prefixMatch[1])}</span>${formatPlainInlineWithMarkers(prefixMatch[2])}`;
    }
    return formatPlainInlineWithMarkers(line);
  });
  return `<div class="plain-block__markers">${lines.join('\n')}</div>`;
}

/** A whole line that is itself marker syntax — hidden end to end in the mirror. */
const MIRROR_MARKER_LINE = /^\s*(?:`{3,}.*|~{3,}.*|\$\$|\\\[|\\\]|\.{3}|={3,}|-{3,}|\*{3,}|_{3,}|:{3,}.*)$/;
/** One-line math block (`$$E=mc^2$$`, `\[x\]`), own block in the splitter. */
const MIRROR_MATH_SINGLE = /^(\s*(?:\$\$|\\\[))(.*?)(\$\$|\\\])(\s*)$/;
const MIRROR_LINE_PREFIX =
  /^(\s*(?:[-+*]\s+\[[ xX]\]\s+|(?:[-+*]|\d+[.)])\s+|(?:>\s?)+|#{1,6}\s+))(.*)$/;

/**
 * #698 — the mirror render for pure WYSIWYG on the Windows plain-block live
 * editor. Same structure as `renderPlainVisibleMarkers`, additionally wrapping
 * the whole marker lines a plain paragraph tokenizer would leave visible:
 * fenced-code backtick/tilde lines, `$$` / `\[` / `\]` math fences, `:::`
 * container fences, `...` front-matter closers and setext underlines. With the
 * marker spans hidden, only content remains, at the exact positions the source
 * text occupies in the transparent editing <textarea> stacked on top.
 */
export function renderPlainMirror(src: string): string {
  const singleHeading = /^(\s*(#{1,6})\s+)(.*)$/.exec(src);
  if (singleHeading && !src.includes('\n')) {
    const level = singleHeading[2].length;
    return `<h${level} class="plain-block__markers"><span class="plain-md-marker">${escapePlainHtml(singleHeading[1])}</span>${formatPlainInlineWithMarkers(singleHeading[3])}</h${level}>`;
  }
  const lines = src.split('\n').map((line) => {
    if (MIRROR_MARKER_LINE.test(line)) {
      return `<span class="plain-md-marker">${escapePlainHtml(line)}</span>`;
    }
    const mathSingle = MIRROR_MATH_SINGLE.exec(line);
    if (mathSingle) {
      return `<span class="plain-md-marker">${escapePlainHtml(mathSingle[1])}</span>${formatPlainInlineWithMarkers(mathSingle[2])}<span class="plain-md-marker">${escapePlainHtml(mathSingle[3] + mathSingle[4])}</span>`;
    }
    const prefixMatch = MIRROR_LINE_PREFIX.exec(line);
    if (prefixMatch) {
      return `<span class="plain-md-marker">${escapePlainHtml(prefixMatch[1])}</span>${formatPlainInlineWithMarkers(prefixMatch[2])}`;
    }
    return formatPlainInlineWithMarkers(line);
  });
  return `<div class="plain-block__markers">${lines.join('\n')}</div>`;
}
