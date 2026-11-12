/**
 * #505 — TextBundle / TextPack (`.textpack` / `.textbundle`) self-contained
 * Markdown container pack & unpack utilities (https://textbundle.org/).
 *
 * A `.textpack` file is a standard ZIP archive containing:
 *   - `info.json`     — TextBundle v2 metadata
 *   - `text.markdown` — Markdown body with local asset paths rewritten to `assets/<name>`
 *   - `assets/<name>` — Bundled binary assets (images, PDFs, attachments)
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

export interface TextBundleInfo {
  version: number;
  type: string;
  creatorIdentifier?: string;
  transient?: boolean;
}

export interface LocalAssetRef {
  /** Original raw path in Markdown, e.g. `_assets/demo.png` or `./img/pic.jpg`. */
  rawPath: string;
  /** Basename inside `assets/`, e.g. `demo.png`. */
  bundleFileName: string;
}

const REMOTE_OR_DATA_RE = /^(?:https?:|data:|blob:|mailto:|tel:|#)/i;

function sanitizeAssetFileName(rawPath: string, usedNames: Set<string>): string {
  const clean = rawPath
    .split('#')[0]
    .split('?')[0]
    .replace(/\\/g, '/')
    .split('/')
    .pop() || 'asset';
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // Keep raw
  }
  const safe = decoded.replace(/[^\w.\-\u4e00-\u9fa5 ()[\]]+/g, '_') || 'asset';
  if (!usedNames.has(safe.toLowerCase())) {
    usedNames.add(safe.toLowerCase());
    return safe;
  }
  const dot = safe.lastIndexOf('.');
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  let idx = 2;
  while (usedNames.has(`${stem}-${idx}${ext}`.toLowerCase())) {
    idx++;
  }
  const candidate = `${stem}-${idx}${ext}`;
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Scan Markdown source for local asset paths (`![alt](path)` and `<img src="path">`)
 * and rewrite them to `assets/<bundleFileName>`.
 */
export function rewriteMarkdownForTextBundle(markdown: string): {
  rewrittenMarkdown: string;
  assets: LocalAssetRef[];
} {
  const mapByRaw = new Map<string, string>();
  const usedNames = new Set<string>();
  const assets: LocalAssetRef[] = [];

  const registerRef = (rawPath: string): string | null => {
    const trimmed = rawPath.trim().replace(/^<|>$/g, '');
    if (!trimmed || REMOTE_OR_DATA_RE.test(trimmed)) return null;
    if (mapByRaw.has(trimmed)) return `assets/${mapByRaw.get(trimmed)!}`;
    const bundleFileName = sanitizeAssetFileName(trimmed, usedNames);
    mapByRaw.set(trimmed, bundleFileName);
    assets.push({ rawPath: trimmed, bundleFileName });
    return `assets/${bundleFileName}`;
  };

  // Rewrite Markdown image links: ![alt](url "optional title")
  let out = markdown.replace(
    /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(\s+"[^"]*"|\s+'[^']*')?\s*\)/g,
    (full, alt: string, rawTarget: string, titlePart?: string) => {
      const rewritten = registerRef(rawTarget);
      if (!rewritten) return full;
      return `![${alt}](${rewritten}${titlePart ?? ''})`;
    },
  );

  // Rewrite HTML <img src="..."> tags
  out = out.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi,
    (full, prefix: string, quote: string, src: string) => {
      const rewritten = registerRef(src);
      if (!rewritten) return full;
      return `${prefix}${quote}${rewritten}${quote}`;
    },
  );

  return { rewrittenMarkdown: out, assets };
}

/**
 * Build a `.textpack` (ZIP) byte buffer from Markdown content and a map of
 * `bundleFileName -> Uint8Array` binary assets.
 */
export function createTextPackArchive(
  rewrittenMarkdown: string,
  assetBytesByBundleName: Record<string, Uint8Array>,
): Uint8Array {
  const info: TextBundleInfo = {
    version: 2,
    type: 'net.daringfireball.markdown',
    creatorIdentifier: 'app.solomd',
    transient: false,
  };
  const files: Record<string, Uint8Array> = {
    'info.json': strToU8(JSON.stringify(info, null, 2) + '\n'),
    'text.markdown': strToU8(rewrittenMarkdown),
  };
  for (const [name, bytes] of Object.entries(assetBytesByBundleName)) {
    const cleanName = name.replace(/^assets\//, '');
    files[`assets/${cleanName}`] = bytes;
  }
  return zipSync(files, { level: 6 });
}

export interface UnpackedTextPack {
  info: TextBundleInfo;
  markdown: string;
  assets: Array<{ name: string; bytes: Uint8Array }>;
}

/**
 * Unpack a `.textpack` ZIP archive and rewrite `assets/<name>` links to
 * `<targetAssetsDir>/<name>` so extracted assets work in a standard Markdown folder.
 */
export function extractTextPackArchive(
  zipBytes: Uint8Array,
  targetAssetsDir = '_assets',
): UnpackedTextPack {
  const entries = unzipSync(zipBytes);
  // Some tools wrap the bundle inside a top-level `<name>.textbundle/` folder inside the zip.
  const keys = Object.keys(entries);
  const findKey = (re: RegExp) => keys.find((k) => re.test(k));

  const infoKey = findKey(/(?:^|\/)info\.json$/i);
  let info: TextBundleInfo = {
    version: 2,
    type: 'net.daringfireball.markdown',
  };
  if (infoKey && entries[infoKey]) {
    try {
      info = JSON.parse(strFromU8(entries[infoKey])) as TextBundleInfo;
    } catch {
      // Keep default info
    }
  }

  const textKey =
    findKey(/(?:^|\/)text\.(?:markdown|md|txt)$/i) ??
    keys.find((k) => /\.(?:markdown|md)$/i.test(k) && !k.includes('__MACOSX'));
  const rawMarkdown = textKey && entries[textKey] ? strFromU8(entries[textKey]) : '';

  const assets: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const key of keys) {
    if (key.includes('__MACOSX') || key.endsWith('/')) continue;
    const m = key.match(/(?:^|\/)assets\/(.+)$/i);
    if (m && m[1] && entries[key]) {
      const baseName = m[1].split('/').pop() || m[1];
      assets.push({ name: baseName, bytes: entries[key] });
    }
  }

  const cleanDir = targetAssetsDir.replace(/[/\\]+$/, '');
  const rewrittenMarkdown = cleanDir
    ? rawMarkdown
        .replace(
          /(!\[[^\]]*\]\(\s*)(?:\.\/)?assets\/([^)\s]+)/g,
          (_full, prefix: string, name: string) => `${prefix}${cleanDir}/${name}`,
        )
        .replace(
          /(<img\b[^>]*?\bsrc\s*=\s*["'])(?:\.\/)?assets\/([^"']+)/gi,
          (_full, prefix: string, name: string) => `${prefix}${cleanDir}/${name}`,
        )
    : rawMarkdown;

  return {
    info,
    markdown: rewrittenMarkdown,
    assets,
  };
}
