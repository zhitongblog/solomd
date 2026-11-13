/**
 * Which folders Pandoc should resolve a note's relative resources from.
 *
 * Pandoc is handed the Markdown through a temp file (that is how `--citeproc`
 * gets a sane base), so a note that says `![](assets/pic.png)` is resolved
 * against the temp dir, fails, and has the picture silently dropped from the
 * export — an EPUB with no images at all (#560). `--resource-path` fixes the
 * lookup; this module decides what goes on it, and is deliberately free of
 * Tauri / store imports so it can be unit-tested.
 */

const NOT_A_PATH = /^(?:saf:|content:\/\/)/i;

/**
 * Note's own folder first, then the workspace root (notes often link
 * root-relative paths), de-duplicated. Android SAF vaults are skipped: they
 * have no filesystem path to hand Pandoc.
 */
export function pandocResourcePaths(
  filePath: string | null | undefined,
  workspaceRoot: string | null | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string | null | undefined) => {
    if (!dir || NOT_A_PATH.test(dir)) return;
    // `/vault` and `/vault/` are the same folder; handing Pandoc both just
    // makes it search twice.
    const key = dir.length > 1 ? dir.replace(/[\\/]+$/, '') : dir;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(dir);
  };
  add(parentDirOf(filePath));
  add(workspaceRoot);
  return out;
}

/** Same rule as `lib/new-file-target.ts` — duplicated here to keep this module
 *  dependency-free (`new-file-target` drags in the tree-selection store). */
function parentDirOf(path: string | null | undefined): string | null {
  if (!path) return null;
  const m = path.match(/^(.*)[\\/][^\\/]+$/);
  return m && m[1] ? m[1] : null;
}
