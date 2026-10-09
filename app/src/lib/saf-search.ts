/**
 * Full-text search over an Android SAF folder (A12, 5.0 round 2). The Rust
 * `search_in_dir` walks real paths and returned nothing for `saf:` ones, so a
 * picked folder could not be searched at all. This mirrors search.rs — same
 * extensions, same skipped names, case-insensitive line match, 200-char
 * snippets, same cap — over the SAF list/read commands. The I/O is injected
 * so the walk is unit-testable.
 */
export interface SafSearchHit {
  file: string;
  line: number;
  snippet: string;
}
interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
}

const ALLOWED_EXT = new Set(['md', 'markdown', 'mdown', 'mkd', 'txt']);
const SKIP_DIRS = new Set(['node_modules', 'target', '.git', 'dist']);

export async function searchSafTree(
  root: string,
  query: string,
  maxResults: number,
  list: (dir: string) => Promise<Entry[]>,
  read: (file: string) => Promise<string>,
): Promise<SafSearchHit[]> {
  const needle = query.toLowerCase();
  const hits: SafSearchHit[] = [];
  if (!needle) return hits;
  const queue = [root];
  while (queue.length && hits.length < maxResults) {
    const dir = queue.shift()!;
    let entries: Entry[];
    try {
      entries = await list(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (hits.length >= maxResults) break;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      if (e.is_dir) {
        queue.push(e.path);
        continue;
      }
      const ext = (e.name.split('.').pop() || '').toLowerCase();
      if (!e.name.includes('.') || !ALLOWED_EXT.has(ext)) continue;
      let content: string;
      try {
        content = await read(e.path);
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push({ file: e.path, line: i + 1, snippet: [...lines[i]].slice(0, 200).join('') });
        }
      }
    }
  }
  return hits;
}
