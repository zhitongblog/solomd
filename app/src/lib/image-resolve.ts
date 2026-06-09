/**
 * Shared image URL resolution for SoloMD.
 * Used by Preview.vue, pdf-export.ts, image-export.ts, and docx-export.ts
 * to convert local image paths into URLs the webview can load or bytes for embedding.
 */

import { convertFileSrc } from '@tauri-apps/api/core';

/**
 * Normalize a filesystem path so `convertFileSrc` produces a URL the
 * webview will actually load on every platform.
 *   1. Mixed `\` / `/` separators are unified.
 *   2. `./` and `../` segments are resolved.
 *   3. Windows drive prefixes (`C:`) survive normalization.
 */
export function normalizePath(p: string): string {
  if (!p) return p;
  let s = p.replace(/\\/g, '/');
  const driveMatch = s.match(/^([a-zA-Z]):\/(.*)$/);
  let prefix = '';
  let body = s;
  if (driveMatch) {
    prefix = driveMatch[1].toUpperCase() + ':/';
    body = driveMatch[2];
  } else if (s.startsWith('/')) {
    prefix = '/';
    body = s.slice(1);
  }
  const out: string[] = [];
  for (const seg of body.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return prefix + out.join('/');
}

/**
 * Resolve a local image src to an absolute filesystem path.
 * Returns the original src unchanged for remote/data/blob/asset URLs.
 */
export function resolveImagePath(
  src: string,
  imageRoot: string | null,
  filePath?: string,
): string {
  if (!src) return src;
  if (/^(https?|data|blob|asset|tauri):/i.test(src)) return src;

  let p = src;
  if (/^file:\/\//i.test(p)) {
    p = p.slice(7);
    if (p.startsWith('/') && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  }

  const isAbsolute = p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
  if (!isAbsolute) {
    let base: string | null = null;
    if (imageRoot) {
      const rootAbsolute = imageRoot.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(imageRoot);
      if (rootAbsolute) {
        base = imageRoot;
      } else if (filePath) {
        const dir = filePath.replace(/[\\/][^\\/]*$/, '');
        base = dir + '/' + imageRoot;
      }
    }
    if (!base && filePath) {
      base = filePath.replace(/[\\/][^\\/]*$/, '');
    }
    if (base) {
      p = base + '/' + p;
    }
  }

  return normalizePath(p);
}

/**
 * Resolve a single image src into something the webview can load.
 * Converts local paths to `asset://` URLs via Tauri's convertFileSrc().
 */
export function resolveImageSrc(
  src: string,
  imageRoot: string | null,
  filePath?: string,
): string {
  const resolved = resolveImagePath(src, imageRoot, filePath);
  // If it's still a remote/data/blob URL, return as-is
  if (/^(https?|data|blob|asset|tauri):/i.test(resolved)) return resolved;
  try {
    return convertFileSrc(resolved);
  } catch {
    return src;
  }
}

/** Rewrite all `<img src=…>` URLs in the rendered markdown HTML. */
export function rewriteImageUrls(
  rawHtml: string,
  imageRoot: string | null,
  filePath?: string,
): string {
  return rawHtml.replace(
    /(<img[^>]*\bsrc=)(["'])([^"']*)\2/gi,
    (_match, prefix: string, q: string, src: string) => {
      // markdown-it percent-encodes non-ASCII in image URLs (`感` → `%E6%84%9F`).
      // Passing that straight to convertFileSrc encodes the `%` again, yielding
      // `%25E6…` — a double-encoded path that 404s, so images under a Chinese
      // (or space-containing) folder never load (顾河 report, Typora `./images/
      // <笔记名>/` paths). Decode the local path first so it's encoded exactly
      // once — mirroring rewriteLinkUrls. Remote/data/asset URLs are left alone.
      if (!src || /^(https?|data|blob|asset|tauri):/i.test(src)) {
        return `${prefix}${q}${src}${q}`;
      }
      let decoded: string;
      try { decoded = decodeURI(src); } catch { decoded = src; }
      return `${prefix}${q}${resolveImageSrc(decoded, imageRoot, filePath)}${q}`;
    },
  );
}

/**
 * v4.3.0 issue #77 — local-file `<a href=…>` URLs in rendered markdown
 * resolve against the webview's base URL (`http://tauri.localhost/`),
 * which then bakes into exported PDFs / DOCX / images as a useless
 * `http://tauri.localhost/foo.factoryio` link.
 *
 * This rewrites local-file hrefs to absolute `file://` URLs so the link
 * (a) still works on the original machine and (b) shows a meaningful
 * file-system path when the PDF is shared. Remote schemes (http/https/
 * mailto/tel/data/etc.) and in-page anchors (`#section`) are left alone.
 */
export function rewriteLinkUrls(
  rawHtml: string,
  imageRoot: string | null,
  filePath?: string,
): string {
  return rawHtml.replace(
    /(<a\b[^>]*\bhref=)(["'])([^"']*)\2/gi,
    (_match, prefix: string, q: string, href: string) => {
      // Leave anchors / remote / data-style URLs as-is.
      if (!href) return `${prefix}${q}${q}`;
      if (href.startsWith('#')) return `${prefix}${q}${href}${q}`;
      if (/^(https?|mailto|tel|sms|data|blob|asset|tauri|ftp|file):/i.test(href)) {
        return `${prefix}${q}${href}${q}`;
      }
      // Decode the path so `%20` etc. don't go through resolution twice.
      let decoded: string;
      try { decoded = decodeURI(href); } catch { decoded = href; }
      const resolved = resolveImagePath(decoded, imageRoot, filePath);
      const isAbs = resolved.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(resolved);
      if (!isAbs) return `${prefix}${q}${href}${q}`;
      // Build a `file://` URL — encodeURI keeps the path readable while
      // escaping spaces / unicode. Windows drives need an extra `/`.
      const fileUrl = /^[a-zA-Z]:/.test(resolved)
        ? `file:///${encodeURI(resolved.replace(/\\/g, '/'))}`
        : `file://${encodeURI(resolved)}`;
      return `${prefix}${q}${fileUrl}${q}`;
    },
  );
}
