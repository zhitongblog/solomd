/**
 * #438 — Custom font loader for local font files (especially Android).
 *
 * On Android, unrooted devices cannot install user fonts into `/system/fonts`.
 * Users place `.ttf` / `.otf` / `.woff2` / `.ttc` files in `/storage/emulated/0/Fonts`
 * and type (or pick) the font name in Settings -> Font Family. Because Android
 * WebView only resolves system-installed fonts via plain CSS `font-family`, we
 * scan the user font folders, match the requested family name (or direct file
 * path) against local font files, read the bytes via `read_binary_file`, and
 * register a Web `FontFace` in `document.fonts`.
 */

import { invoke } from '@tauri-apps/api/core';

export interface DiscoveredFont {
  /** File name with extension, e.g. `LXGWWenKai-Regular.ttf`. */
  name: string;
  /** Full path on disk, e.g. `/storage/emulated/0/Fonts/LXGWWenKai-Regular.ttf`. */
  path: string;
  /** File stem without extension, e.g. `LXGWWenKai-Regular`. */
  stem: string;
  /** Clean family name stripped of weight suffix, e.g. `LXGWWenKai`. */
  family: string;
}

interface DirEntryLike {
  name: string;
  path: string;
  is_dir: boolean;
}

export const DEFAULT_FONT_DIRS = [
  '/storage/emulated/0/Fonts',
  '/storage/emulated/0/fonts',
  '/sdcard/Fonts',
  '/storage/emulated/0/Download/Fonts',
  '/storage/emulated/0/Download',
];

const FONT_EXT_RE = /\.(ttf|otf|woff2|woff|ttc)$/i;
const STYLE_SUFFIX_RE =
  /[-_\s]*(regular|normal|book|roman|medium|bold|light|thin|semibold|demibold|extrabold|heavy|black|italic|oblique|vf|variable|w0[1-9])$/i;

/**
 * Known CJK / coding font alias groups so a user who selects the preset
 * `LXGW WenKai` or types `霞鹜文楷` matches `LXGWWenKai-Regular.ttf` on disk.
 */
const FONT_ALIAS_GROUPS: string[][] = [
  ['lxgwwenkai', 'lxgwwenkaimono', 'lxgwwenkaiscreen', '霞鹜文楷', '霞鹜文楷等宽', '霞鹜文楷屏幕阅读版', 'wenkai'],
  ['lxgwbright', '霞鹜新晨宋', '新晨宋'],
  ['tsangerjinkai', 'tsangerjinkai03', 'tsangerjinkai03w04', '仓耳今楷'],
  ['sourcehansans', 'sourcehansanssc', 'sourcehansanscn', 'notosanscjk', 'notosanscjksc', 'notosanssc', '思源黑体'],
  ['sourcehanserif', 'sourcehanserifsc', 'sourcehanserifcn', 'notoserifcjk', 'notoserifcjksc', 'notoserifsc', '思源宋体'],
  ['harmonyossans', 'harmonyossanssc', '鸿蒙黑体', '华为鸿蒙黑体'],
  ['misans', '小米兰亭', '小米字体'],
  ['pingfang', 'pingfangsc', '苹方'],
  ['microsoftyahei', 'yahei', '微软雅黑'],
  ['maplemono', 'maplemonosc', 'maplemonocn'],
  ['jetbrainsmono'],
  ['firacode'],
  ['sarasa', 'sarasagothic', 'sarasamonosc', '更纱黑体'],
];

/** Strip extension and trailing weight/style suffixes from a font filename. */
export function cleanFontFamilyFromFilename(filename: string): { stem: string; family: string } {
  const base = filename.split(/[\\/]/).pop() || filename;
  const stem = base.replace(FONT_EXT_RE, '').trim();
  let family = stem;
  // Strip up to two trailing style tokens (e.g. `-Regular`, `-SC-Regular`).
  for (let i = 0; i < 2; i++) {
    const next = family.replace(STYLE_SUFFIX_RE, '').trim();
    if (next && next !== family) family = next;
    else break;
  }
  return { stem, family: family || stem };
}

/** Normalize a font name for fuzzy comparison (lowercase, no spaces/punctuation). */
export function normalizeFontKey(raw: string): string {
  return raw
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(FONT_EXT_RE, '')
    .replace(STYLE_SUFFIX_RE, '')
    .replace(/[\s\-_.'"()[\]]+/g, '')
    .toLowerCase();
}

function aliasGroupFor(normKey: string): string[] | null {
  if (!normKey) return null;
  for (const group of FONT_ALIAS_GROUPS) {
    if (group.some((alias) => alias === normKey || normKey.startsWith(alias) || alias.startsWith(normKey))) {
      return group;
    }
  }
  return null;
}

/** True when a user-requested font name matches a discovered font file on disk. */
export function fontMatchesFile(requestedName: string, file: DiscoveredFont): boolean {
  const reqNorm = normalizeFontKey(requestedName);
  if (!reqNorm) return false;
  const stemNorm = normalizeFontKey(file.stem);
  const famNorm = normalizeFontKey(file.family);
  const nameLower = file.name.toLowerCase();
  const reqLower = requestedName.trim().replace(/^["']+|["']+$/g, '').toLowerCase();

  if (reqLower === nameLower || reqLower === file.stem.toLowerCase() || reqLower === file.family.toLowerCase()) {
    return true;
  }
  if (reqNorm === stemNorm || reqNorm === famNorm) {
    return true;
  }
  if (
    reqNorm.length >= 3 &&
    (stemNorm.startsWith(reqNorm) || famNorm.startsWith(reqNorm) || reqNorm.startsWith(famNorm))
  ) {
    return true;
  }
  const group = aliasGroupFor(reqNorm);
  if (group) {
    if (group.some((alias) => stemNorm === alias || famNorm === alias || stemNorm.startsWith(alias) || famNorm.startsWith(alias))) {
      return true;
    }
  }
  return false;
}

let cachedDiscovered: DiscoveredFont[] | null = null;

/** Clear the in-memory font discovery & load caches (used by tests or manual refresh). */
export function resetCustomFontCache(): void {
  cachedDiscovered = null;
  loadedSpecs.clear();
}

export type TauriInvoker = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Scan standard user font directories (e.g. `/storage/emulated/0/Fonts`) up to
 * one subfolder deep and return all `.ttf`/`.otf`/`.woff2`/`.woff`/`.ttc` files.
 */
export async function discoverLocalFontFiles(
  dirs: string[] = DEFAULT_FONT_DIRS,
  forceRefresh = false,
  invoker: TauriInvoker = invoke,
): Promise<DiscoveredFont[]> {
  if (cachedDiscovered && !forceRefresh) return cachedDiscovered;
  if (invoker === invoke && (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window))) {
    return [];
  }
  const seenPaths = new Set<string>();
  const out: DiscoveredFont[] = [];

  try {
    const persisted = await listPersistedFontRecords();
    for (const rec of persisted) {
      const idbPath = `idb://${rec.family}`;
      if (seenPaths.has(idbPath.toLowerCase())) continue;
      seenPaths.add(idbPath.toLowerCase());
      out.push({
        name: rec.name || `${rec.family}.ttf`,
        path: idbPath,
        stem: rec.stem || rec.family,
        family: rec.family,
      });
    }
  } catch {
    // Ignore IDB errors
  }

  const collectFromEntries = (entries: DirEntryLike[]) => {
    for (const entry of entries) {
      if (entry.is_dir || !FONT_EXT_RE.test(entry.name)) continue;
      const key = entry.path.toLowerCase();
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      const { stem, family } = cleanFontFamilyFromFilename(entry.name);
      out.push({ name: entry.name, path: entry.path, stem, family });
    }
  };

  for (const dir of dirs) {
    try {
      const entries = await invoker<DirEntryLike[]>('list_dir', { path: dir, showHidden: false });
      if (!Array.isArray(entries)) continue;
      collectFromEntries(entries);
      // Also check one level of subdirectories (e.g. `/storage/emulated/0/Fonts/LXGWWenKai/`).
      const subdirs = entries.filter((e) => e.is_dir).slice(0, 20);
      for (const sub of subdirs) {
        try {
          const subEntries = await invoker<DirEntryLike[]>('list_dir', { path: sub.path, showHidden: false });
          if (Array.isArray(subEntries)) collectFromEntries(subEntries);
        } catch {
          // Ignore unreadable subdirectory
        }
      }
    } catch {
      // Directory doesn't exist or isn't accessible — skip silently
    }
  }

  cachedDiscovered = out;
  return out;
}

const GENERIC_FAMILIES = new Set([
  '-apple-system',
  'blinkmacsystemfont',
  'system-ui',
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
]);

const loadedSpecs = new Set<string>();

interface PersistedFontRecord {
  family: string;
  stem: string;
  name: string;
  buffer: ArrayBuffer;
}

const IDB_NAME = 'solomd-custom-fonts';
const IDB_STORE = 'fonts';

function openFontIdb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'family' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * #479 — Persist a user-picked `.ttf`/`.otf`/`.woff2` font file in IndexedDB so
 * it survives app restarts on Android / iOS / desktop and appears in the font
 * dropdown list.
 */
export async function persistPickedFontFile(fileName: string, buffer: ArrayBuffer): Promise<string> {
  const { stem, family } = cleanFontFamilyFromFilename(fileName);
  const cleanFamily = family || stem || fileName.replace(/\.[^.]+$/, '');
  if (typeof FontFace !== 'undefined' && typeof document !== 'undefined' && document.fonts) {
    const face = new FontFace(cleanFamily, buffer.slice(0));
    await face.load();
    document.fonts.add(face);
    loadedSpecs.add(`token::${cleanFamily.toLowerCase()}`);
  }
  const db = await openFontIdb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put({
          family: cleanFamily,
          stem: stem || cleanFamily,
          name: fileName,
          buffer,
        } satisfies PersistedFontRecord);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
  cachedDiscovered = null;
  return cleanFamily;
}

export async function listPersistedFontRecords(): Promise<PersistedFontRecord[]> {
  const db = await openFontIdb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? (req.result as PersistedFontRecord[]) : []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

async function registerFontFile(
  path: string,
  familyNames: string[],
  invoker: TauriInvoker = invoke,
): Promise<boolean> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
    return false;
  }
  const rawExpanded: string[] = [];
  for (const raw of familyNames) {
    const clean = raw.trim().replace(/^["']+|["']+$/g, '').trim();
    if (!clean) continue;
    const { stem, family } = cleanFontFamilyFromFilename(clean);
    if (family) rawExpanded.push(family);
    if (stem) rawExpanded.push(stem);
    // Do not pass full filesystem paths (`/storage/...`) into `new FontFace`:
    // Chromium's CSS Font Loading API rejects `/` or `\` in a family name.
    if (!/[\\/]/.test(clean) && !FONT_EXT_RE.test(clean)) {
      rawExpanded.push(clean);
    }
  }
  const uniqueNames = Array.from(new Set(rawExpanded.filter(Boolean)));
  if (!uniqueNames.length) return false;

  const bytes = await invoker<number[]>('read_binary_file', { path });
  if (!bytes || !bytes.length) return false;
  const buffer = new Uint8Array(bytes).buffer;

  let anyLoaded = false;
  for (const family of uniqueNames) {
    const cacheKey = `${family.toLowerCase()}::${path.toLowerCase()}`;
    if (loadedSpecs.has(cacheKey)) {
      anyLoaded = true;
      continue;
    }
    try {
      const face = new FontFace(family, buffer);
      await face.load();
      document.fonts.add(face);
      loadedSpecs.add(cacheKey);
      anyLoaded = true;
    } catch {
      try {
        const quotedFace = new FontFace(`"${family}"`, buffer);
        await quotedFace.load();
        document.fonts.add(quotedFace);
        loadedSpecs.add(cacheKey);
        anyLoaded = true;
      } catch (e) {
        console.warn(`[custom-font] Failed to load FontFace "${family}" from ${path}:`, e);
      }
    }
  }
  return anyLoaded;
}

/**
 * Normalize Android File Manager display paths (e.g. ColorOS `/storage/0/Fonts/...`
 * or `内部共享存储空间/Fonts/...`) into real POSIX paths on Android.
 */
export function expandAndroidFontPath(rawPath: string): string[] {
  const trimmed = rawPath.trim().replace(/^["']+|["']+$/g, '');
  const out = new Set<string>();
  if (/^\/storage\/0\//i.test(trimmed)) {
    out.add(trimmed.replace(/^\/storage\/0\//i, '/storage/emulated/0/'));
  }
  if (/^(?:内部共享存储空间|内部存储|手机存储)[\\/]/.test(trimmed)) {
    out.add(
      trimmed
        .replace(/^(?:内部共享存储空间|内部存储|手机存储)[\\/]/, '/storage/emulated/0/')
        .replace(/\\/g, '/'),
    );
  }
  out.add(trimmed);
  return Array.from(out);
}

function isFilePathFontSpec(token: string): boolean {
  return (
    token.startsWith('/') ||
    /^[a-zA-Z]:[\\/]/.test(token) ||
    FONT_EXT_RE.test(token)
  );
}

/**
 * Ensure any custom font referenced in `fontSpec` (either a font family name
 * or a direct file path) is loaded into `document.fonts` if a matching font
 * file exists in `/storage/emulated/0/Fonts` (or at the given path).
 */
export async function ensureCustomFontLoaded(
  fontSpec: string,
  invoker: TauriInvoker = invoke,
): Promise<boolean> {
  if (
    !fontSpec ||
    (invoker === invoke && (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)))
  ) {
    return false;
  }
  const tokens = fontSpec
    .split(',')
    .map((t) => t.trim().replace(/^["']+|["']+$/g, '').trim())
    .filter((t) => t && !GENERIC_FAMILIES.has(t.toLowerCase()));
  if (!tokens.length) return false;

  // Quick check: if every token was already resolved in this session, skip.
  if (tokens.every((t) => loadedSpecs.has(`token::${t.toLowerCase()}`))) {
    return true;
  }

  let loadedAny = false;
  for (const token of tokens) {
    const tokenKey = `token::${token.toLowerCase()}`;
    if (loadedSpecs.has(tokenKey)) {
      loadedAny = true;
      continue;
    }

    // Case 0: Check IndexedDB persisted fonts picked via file picker (#479)
    try {
      const persisted = await listPersistedFontRecords();
      const matchedRec = persisted.find((r) =>
        fontMatchesFile(token, {
          name: r.name,
          path: `idb://${r.family}`,
          stem: r.stem,
          family: r.family,
        }),
      );
      if (matchedRec && typeof FontFace !== 'undefined' && typeof document !== 'undefined' && document.fonts) {
        const face = new FontFace(matchedRec.family, matchedRec.buffer.slice(0));
        await face.load();
        document.fonts.add(face);
        loadedSpecs.add(tokenKey);
        loadedAny = true;
        continue;
      }
    } catch {
      // Ignore IDB load failure
    }

    // Case 1: User typed a direct file path or filename with extension (.ttf/.otf/...)
    if (isFilePathFontSpec(token)) {
      const candidatePaths =
        token.startsWith('/') ||
        /^[a-zA-Z]:[\\/]/.test(token) ||
        /^(?:内部共享存储空间|内部存储|手机存储)[\\/]/.test(token)
          ? expandAndroidFontPath(token)
          : DEFAULT_FONT_DIRS.map((d) => `${d}/${token}`);
      const { stem, family } = cleanFontFamilyFromFilename(token);
      for (const p of candidatePaths) {
        try {
          if (await registerFontFile(p, [token, stem, family], invoker)) {
            loadedSpecs.add(tokenKey);
            loadedAny = true;
            break;
          }
        } catch {
          // Try next path
        }
      }
      if (loadedSpecs.has(tokenKey)) continue;
    }

    // Case 2: Match against discovered font files in `/storage/emulated/0/Fonts`
    let files = await discoverLocalFontFiles(DEFAULT_FONT_DIRS, false, invoker);
    let matches = files.filter((f) => fontMatchesFile(token, f));
    if (matches.length === 0) {
      // Force a rescan in case the user placed the font file into `Fonts/`
      // after the app started (#451).
      files = await discoverLocalFontFiles(DEFAULT_FONT_DIRS, true, invoker);
      matches = files.filter((f) => fontMatchesFile(token, f));
    }
    // Prefer Regular / Book weight first when a family has multiple weight files
    matches.sort((a, b) => {
      const aReg = /regular|normal|book|roman/i.test(a.stem) ? 0 : 1;
      const bReg = /regular|normal|book|roman/i.test(b.stem) ? 0 : 1;
      return aReg - bReg || a.name.localeCompare(b.name);
    });
    if (matches.length > 0) {
      const hit = matches[0];
      try {
        if (await registerFontFile(hit.path, [token, hit.stem, hit.family], invoker)) {
          loadedSpecs.add(tokenKey);
          loadedAny = true;
        }
      } catch {
        // Ignore unreadable font file
      }
    }
  }

  return loadedAny;
}
