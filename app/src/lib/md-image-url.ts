/**
 * Make a local image path safe to use as a Markdown link destination.
 *
 * CommonMark does not allow spaces in a bare destination, so
 * `![](D:/Program Files/img.png)` is not an image at all: markdown-it renders
 * the whole thing as literal text (#345). The same happens with an unbalanced
 * `(` or `)`. Every image SoloMD writes into a note — pasted, dropped,
 * uploaded-with-local-fallback, or inserted from a file picker — goes through
 * this function, so an image folder under "Program Files", a note called
 * "My Note" (→ `My Note.assets/`), or a Windows user name with a space all
 * produce links that render.
 *
 * Percent-encoding rather than `<...>`: the rendered `src` is identical either
 * way, but the live-edit image-line detector and other editors (Typora writes
 * `%20` too) only understand the encoded form. Every place that turns a
 * rendered `src` back into a file path decodes it exactly once
 * (`image-resolve.ts`), which is why `%` itself is encoded as well: a file
 * literally named `100%.png` must come back as `100%.png`, not be mangled by
 * that decode.
 *
 * Only characters that break the destination are touched; letters, CJK and
 * `/` stay readable. A remote URL is already URL-encoded, so only its
 * whitespace is touched (an image host can hand back a key with a space in it).
 */
export function encodeImageDestination(path: string): string {
  if (/^(https?|data|blob|asset|tauri):/i.test(path)) return path.replace(/\s/g, '%20');
  return path
    .replace(/%/g, '%25')
    .replace(/\s/g, (c) => (c === ' ' ? '%20' : encodeURIComponent(c)))
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E');
}

/** `![alt](path)` with the path made safe by {@link encodeImageDestination}. */
export function markdownImage(path: string, alt = ''): string {
  return `![${alt}](${encodeImageDestination(path)})`;
}

export interface ParsedImageAltSize {
  alt: string;
  width: string | null;
  height: string | null;
}

const ALT_SIZE_RE = /^(.*?)\|\s*(\d{1,4}(?:%|px)?)(?:\s*[x×]\s*(\d{1,4}(?:%|px)?))?\s*$/i;

function normalizeImageDimension(dim: string): string {
  const trimmed = dim.trim();
  return /^\d+$/.test(trimmed) ? `${trimmed}px` : trimmed.toLowerCase();
}

/**
 * #446 — Parse optional Obsidian/Markdown pipe size syntax at the end of an
 * image's alt text: `![alt|50%](url)`, `![|300](url)`, `![alt|400x300](url)`.
 */
export function parseImageAltSize(rawAlt: string): ParsedImageAltSize {
  const m = ALT_SIZE_RE.exec(rawAlt);
  if (!m) {
    return { alt: rawAlt, width: null, height: null };
  }
  return {
    alt: m[1].trimEnd(),
    width: normalizeImageDimension(m[2]),
    height: m[3] ? normalizeImageDimension(m[3]) : null,
  };
}

const HTML_IMG_TAG_RE = /<img\b([^>]*?)(\/?)>/i;

export interface ParsedMarkdownImageSpan {
  /** Start index of the image (or outer linked-image `[`) in the line. */
  start: number;
  /** End index (exclusive) of the image (or outer linked-image `)`) in the line. */
  end: number;
  /** Raw alt text inside `![...]`. */
  alt: string;
  /** Start index of `alt` in the line. */
  altStart: number;
  /** End index (exclusive) of `alt` in the line. */
  altEnd: number;
  /** Image destination URL/path. */
  src: string;
  /** Optional outer link URL when wrapped as `[![alt](img)](href)`. */
  href?: string;
}

function maskInlineCode(text: string): boolean[] {
  const n = text.length;
  const code = new Array<boolean>(n).fill(false);
  for (let p = 0; p < n; ) {
    if (text[p] === '`') {
      let len = 1;
      while (p + len < n && text[p + len] === '`') len++;
      let q = p + len;
      let closed = -1;
      while (q < n) {
        if (text[q] === '`') {
          let len2 = 1;
          while (q + len2 < n && text[q + len2] === '`') len2++;
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
  return code;
}

function unescapeMarkdownUrl(raw: string): string {
  let out = raw.replace(/&amp;/gi, '&');
  if (/^https?:\/\//i.test(out)) {
    out = out.replace(/\\([!#$%&'()*+,/:;=?@[\]_~-])/g, '$1');
  } else {
    out = out.replace(/\\([()[\]])/g, '$1');
  }
  return out;
}

function parseLinkDestinationAndTitle(
  text: string,
  openParen: number,
): { dest: string; end: number } | null {
  const n = text.length;
  if (openParen >= n || text[openParen] !== '(') return null;
  let q = openParen + 1;
  while (q < n && (text[q] === ' ' || text[q] === '\t')) q++;
  if (q >= n) return null;

  let dest = '';
  if (text[q] === '<') {
    const destStart = q + 1;
    let closeAngle = -1;
    for (let k = destStart; k < n; k++) {
      if (text[k] === '\\' && k + 1 < n) {
        k++;
        continue;
      }
      if (text[k] === '<') return null;
      if (text[k] === '>') {
        closeAngle = k;
        break;
      }
    }
    if (closeAngle < 0) return null;
    dest = text.slice(destStart, closeAngle).trim();
    if (!dest) return null;
    q = closeAngle + 1;
  } else {
    const destStart = q;
    let parenDepth = 0;
    while (q < n) {
      const ch = text[q];
      if (ch === '\\' && q + 1 < n) {
        q += 2;
        continue;
      }
      if (ch === ' ' || ch === '\t') break;
      if (ch === '(') {
        parenDepth++;
        q++;
        continue;
      }
      if (ch === ')') {
        if (parenDepth > 0) {
          parenDepth--;
          q++;
          continue;
        }
        break;
      }
      q++;
    }
    if (parenDepth !== 0) return null;
    dest = text.slice(destStart, q);
    if (!dest) return null;
  }

  const wsStart = q;
  while (q < n && (text[q] === ' ' || text[q] === '\t')) q++;
  if (q < n && text[q] !== ')') {
    if (q === wsStart) return null;
    const quote = text[q];
    if (quote === '"' || quote === "'" || quote === '(') {
      const closeQuote = quote === '(' ? ')' : quote;
      let closeTitle = -1;
      for (let k = q + 1; k < n; k++) {
        if (text[k] === '\\' && k + 1 < n) {
          k++;
          continue;
        }
        if (text[k] === closeQuote) {
          closeTitle = k;
          break;
        }
      }
      if (closeTitle < 0) return null;
      q = closeTitle + 1;
      while (q < n && (text[q] === ' ' || text[q] === '\t')) q++;
    } else {
      // #345 / #506 — Fallback for unencoded spaces in image paths/URLs
      // (`![](D:/Program Files/a.png)` or `![](https://example.com/a b.png)`),
      // matching `image_spaced_path` in `markdown.ts`.
      const closeParen = text.indexOf(')', q);
      if (closeParen < 0) return null;
      const candidate = text.slice(openParen + 1, closeParen).trim();
      if (
        !candidate ||
        /[<>"']/.test(candidate) ||
        !/\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)(?:[?#][^\s)]*)?$/i.test(candidate)
      ) {
        return null;
      }
      return { dest: unescapeMarkdownUrl(candidate), end: closeParen + 1 };
    }
  }

  if (q >= n || text[q] !== ')') return null;
  return { dest: unescapeMarkdownUrl(dest), end: q + 1 };
}

function normalizeRefLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * #506 — Collect Markdown link/image reference definitions (`[id]: url`) across
 * document lines (ignoring lines inside fenced/indented code blocks).
 */
export function extractImageReferenceDefinitions(
  lines: readonly string[],
  fenceBody?: readonly boolean[],
): Map<string, string> {
  const refs = new Map<string, string>();
  const defRe =
    /^\s*(?:>\s*)*\[([^\]]+)\]:\s*(?:<([^>\s]+)>|([^\s]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
  for (let i = 0; i < lines.length; i++) {
    if (fenceBody?.[i]) continue;
    const m = defRe.exec(lines[i]);
    if (!m) continue;
    const key = normalizeRefLabel(m[1]);
    const dest = unescapeMarkdownUrl((m[2] || m[3] || '').trim());
    if (key && dest && !refs.has(key)) {
      refs.set(key, dest);
    }
  }
  return refs;
}

function parseSingleImageAt(
  text: string,
  bangIndex: number,
  code: readonly boolean[],
  refMap?: ReadonlyMap<string, string>,
): ParsedMarkdownImageSpan | null {
  const n = text.length;
  if (bangIndex + 1 >= n || text[bangIndex] !== '!' || text[bangIndex + 1] !== '[') {
    return null;
  }
  let p = bangIndex + 2;
  let depth = 1;
  while (p < n) {
    if (text[p] === '\\' && p + 1 < n) {
      p += 2;
      continue;
    }
    if (code[p]) {
      p++;
      continue;
    }
    if (text[p] === '[') depth++;
    else if (text[p] === ']') {
      depth--;
      if (depth === 0) break;
    }
    p++;
  }
  if (depth !== 0 || p >= n) return null;
  const altStart = bangIndex + 2;
  const altEnd = p;
  const alt = text.slice(altStart, altEnd);

  // Inline destination: `![alt](url)`
  if (p + 1 < n && text[p + 1] === '(') {
    const parsedDest = parseLinkDestinationAndTitle(text, p + 1);
    if (parsedDest) {
      return {
        start: bangIndex,
        end: parsedDest.end,
        alt,
        altStart,
        altEnd,
        src: parsedDest.dest,
      };
    }
  }

  // Reference-style destination: `![alt][ref]`, `![alt][]`, or `![ref]`
  if (refMap && refMap.size > 0) {
    if (p + 1 < n && text[p + 1] === '[') {
      let r = p + 2;
      while (r < n && text[r] !== ']' && text[r] !== '[') {
        if (text[r] === '\\' && r + 1 < n) {
          r += 2;
          continue;
        }
        r++;
      }
      if (r < n && text[r] === ']') {
        const rawRef = text.slice(p + 2, r);
        const key = normalizeRefLabel(rawRef || alt);
        const resolved = key ? refMap.get(key) : undefined;
        if (resolved) {
          return {
            start: bangIndex,
            end: r + 1,
            alt,
            altStart,
            altEnd,
            src: resolved,
          };
        }
      }
    } else {
      const key = normalizeRefLabel(alt);
      const resolved = key ? refMap.get(key) : undefined;
      if (resolved) {
        return {
          start: bangIndex,
          end: p + 1,
          alt,
          altStart,
          altEnd,
          src: resolved,
        };
      }
    }
  }

  return null;
}

/**
 * #506 — Find all Markdown image spans in a single line (outside inline code),
 * including:
 * - standalone images `![alt](url)`
 * - images inside list items (`- ![alt](url)`, `1. ![alt](url)`) or blockquotes (`> ![alt](url)`)
 * - clickable linked images (`[![alt](imgUrl)](linkUrl)`)
 * - images with brackets in `alt` (`![[图1] 描述](url)`)
 * - angle-bracketed URLs (`![alt](<url>)`) and balanced parentheses (`![alt](https://.../a(1).png)`)
 * - single/double/paren-quoted titles (`![alt](url 'title')`)
 * - reference-style images (`![alt][ref]`) when `refMap` is supplied.
 */
export function findMarkdownImagesInLine(
  line: string,
  refMap?: ReadonlyMap<string, string>,
): ParsedMarkdownImageSpan[] {
  if (!line.includes('![')) return [];
  const n = line.length;
  const code = maskInlineCode(line);
  const out: ParsedMarkdownImageSpan[] = [];
  let i = 0;
  while (i < n) {
    if (code[i]) {
      i++;
      continue;
    }
    if (line[i] === '\\' && i + 1 < n) {
      i += 2;
      continue;
    }
    // Linked image: `[![alt](imgUrl)](linkUrl)`
    if (line[i] === '[' && i + 2 < n && line[i + 1] === '!' && line[i + 2] === '[') {
      const inner = parseSingleImageAt(line, i + 1, code, refMap);
      if (inner && inner.end + 1 < n && line[inner.end] === ']' && line[inner.end + 1] === '(') {
        const outer = parseLinkDestinationAndTitle(line, inner.end + 1);
        if (outer) {
          out.push({
            start: i,
            end: outer.end,
            alt: inner.alt,
            altStart: inner.altStart,
            altEnd: inner.altEnd,
            src: inner.src,
            href: outer.dest,
          });
          i = outer.end;
          continue;
        }
      }
    }
    // Standard or reference image: `![alt](url)` / `![alt][ref]`
    if (line[i] === '!' && i + 1 < n && line[i + 1] === '[') {
      const img = parseSingleImageAt(line, i, code, refMap);
      if (img) {
        out.push(img);
        i = img.end;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * #446 / #506 — Update the display width of a Markdown image (`![alt](url)` ->
 * `![alt|50%](url)`) or HTML `<img ...>` line. Passing `'100%'` or `''`
 * restores the natural/default 100% size by removing the size override.
 * Returns the updated line text, or `null` if the line has no image.
 */
export function resizeMarkdownImageLine(line: string, size: string): string | null {
  const normalizedSize = size.trim();
  const isReset = !normalizedSize || normalizedSize === '100%';
  const mdImages = findMarkdownImagesInLine(line);
  if (mdImages.length > 0) {
    const first = mdImages[0];
    const baseAlt = parseImageAltSize(first.alt).alt;
    const nextAlt = isReset
      ? baseAlt
      : baseAlt
        ? `${baseAlt}|${normalizedSize}`
        : `|${normalizedSize}`;
    return `${line.slice(0, first.altStart)}${nextAlt}${line.slice(first.altEnd)}`;
  }

  const htmlMatch = HTML_IMG_TAG_RE.exec(line);
  if (htmlMatch) {
    let attrs = htmlMatch[1]
      .replace(/\s+width\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+height\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    if (/\bstyle\s*=\s*"([^"]*)"/i.test(attrs)) {
      attrs = attrs.replace(/\bstyle\s*=\s*"([^"]*)"/i, (_m, styleBody: string) => {
        const cleaned = styleBody
          .replace(/(?:^|;)\s*(?:width|height|zoom)\s*:[^;]*/gi, '')
          .replace(/^;\s*|\s*;$/g, '')
          .trim();
        if (isReset) return cleaned ? `style="${cleaned}"` : '';
        const dim = normalizeImageDimension(normalizedSize);
        return `style="${cleaned ? `${cleaned}; ` : ''}width: ${dim};"`;
      });
    } else if (!isReset) {
      const dim = normalizeImageDimension(normalizedSize);
      attrs = `${attrs.trimEnd()} width="${dim.endsWith('px') ? dim.slice(0, -2) : dim}" style="width: ${dim};"`;
    }
    const cleanAttrs = attrs.replace(/\s{2,}/g, ' ').trim();
    const selfClose = htmlMatch[2] ? ' /' : '';
    return line.replace(
      HTML_IMG_TAG_RE,
      `<img${cleanAttrs ? ` ${cleanAttrs}` : ''}${selfClose}>`,
    );
  }

  return null;
}

