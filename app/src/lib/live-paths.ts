/**
 * 5.0 regression C4 — the ⌘P quick switcher draws on the recent-files list
 * and the save-count store, and neither hears about a rename, a delete or a
 * move (in the app or in Finder), so the switcher kept offering files that no
 * longer exist. Rather than hook every place a file can disappear, the
 * switcher re-checks its candidates each time it opens.
 *
 * A candidate is live when the workspace index knows it (cheap, and covers
 * every Markdown file in the vault) or, failing that, when its parent folder
 * still lists it. Folders are listed once each. A folder the caller reports
 * as gone (an empty listing) takes its files with it; one that cannot be
 * listed for any other reason (sandbox, permissions — `null` or a throw)
 * proves nothing, so its files are kept. Paths we have no way to check
 * (Android SAF URIs) are kept too.
 */

function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

function parentOf(p: string): string {
  const n = norm(p);
  const i = n.lastIndexOf('/');
  return i > 0 ? n.slice(0, i) : i === 0 ? '/' : '';
}

function uncheckable(p: string): boolean {
  return /^(saf:|content:)/i.test(p);
}

/**
 * Return the subset of `candidates` that are missing on disk.
 *
 * `indexed` holds the paths the workspace index knows about; `listDir`
 * returns the full paths in one folder (`[]` when the folder is gone), or
 * `null` when it cannot tell.
 */
export async function findMissing(
  candidates: Iterable<string>,
  indexed: Iterable<string>,
  listDir: (dir: string) => Promise<string[] | null>,
): Promise<Set<string>> {
  const known = new Set<string>();
  for (const p of indexed) known.add(norm(p));
  const byDir = new Map<string, string[]>();
  for (const p of new Set(candidates)) {
    if (!p || uncheckable(p) || known.has(norm(p))) continue;
    const dir = parentOf(p);
    if (!dir) continue;
    const list = byDir.get(dir);
    if (list) list.push(p);
    else byDir.set(dir, [p]);
  }
  const missing = new Set<string>();
  await Promise.all(
    [...byDir].map(async ([dir, paths]) => {
      let listing: string[] | null = null;
      try {
        listing = await listDir(dir);
      } catch {
        listing = null;
      }
      if (listing === null) return;
      // Case-insensitive: macOS and Windows volumes usually are, and a
      // recent path whose casing differs from the disk must not be dropped.
      const present = new Set(listing.map((x) => norm(x).toLowerCase()));
      for (const p of paths) if (!present.has(norm(p).toLowerCase())) missing.add(p);
    }),
  );
  return missing;
}
