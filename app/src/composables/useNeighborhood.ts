/**
 * v4.6 F4 — "Neighborhood" relationship explorer.
 *
 * A pure-TS port of Tolaria's `buildRelationshipGroups` over SoloMD's
 * `workspaceIndex` entries. Tolaria's Neighborhood is NOT a force/node-link
 * graph — it's a grouped LIST of a note's relationships, driven entirely by
 * Markdown frontmatter. We mirror that here.
 *
 * Zero new frontmatter conventions: a "relationship" is ANY frontmatter key
 * whose value is a wikilink (`key: "[[Note]]"`) or an array of wikilinks
 * (`key: ["[[A]]", "[[B]]"]`). Reserved keys (type/tags/aliases/title) are
 * excluded so we don't surface noise.
 *
 *   - OUTGOING groups  = the focal note's relationship keys (sorted), each
 *     resolved to the target entries.
 *   - INVERSE groups   = a reverse scan of every other entry whose
 *     relationship keys point back at the focal note, relabeled like Tolaria
 *     (belongs_to → Children, related_to → Referenced by, else `← Key`).
 *   - BACKLINKS        = body-wikilink backlinks (resolved separately by the
 *     panel via the existing `workspace_index_backlinks` command).
 *
 * All resolution reuses the index's `byStem` map + `lib/wikilinks.ts` so
 * behavior matches existing wikilink/backlink features. No new Tauri command.
 */
import type { IndexEntry } from '../stores/workspaceIndex';
import { extractWikilinks } from '../lib/wikilinks';

/** Frontmatter keys that are never treated as relationships. */
const RESERVED_KEYS = new Set(['type', 'tags', 'aliases', 'title', 'alias', 'tag']);

export interface NeighborRef {
  /** Absolute path of the related note (canonical key for dedupe/nav). */
  path: string;
  /** Display title — entry title, else stem. */
  title: string;
  mtime: number;
}

export interface NeighborGroup {
  /** Raw frontmatter key (outgoing) or inverse label key (inverse). */
  key: string;
  /** Humanized, display-ready label. */
  label: string;
  refs: NeighborRef[];
}

export interface Neighborhood {
  outgoing: NeighborGroup[];
  inverse: NeighborGroup[];
}

/** Title to show for an entry — prefer the frontmatter/H1 title, else stem. */
function entryTitle(e: IndexEntry): string {
  return (e.title && e.title.trim()) || e.stem;
}

function toRef(e: IndexEntry): NeighborRef {
  return { path: e.path, title: entryTitle(e), mtime: e.mtime };
}

/** Humanize a snake_case / kebab-case / camelCase key for display. */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Inverse-relationship label (port of Tolaria's
 * `resolveInverseRelationshipLabel`). Given the KEY on the OTHER note that
 * points back at the focal note, return the label to group it under from the
 * focal note's perspective.
 *
 *   belongs_to → Children     related_to → Referenced by
 *   else       → `← <Humanized Key>`
 */
export function inverseLabelFor(key: string): string {
  const k = key.toLowerCase().replace(/[_-]+/g, '');
  if (k === 'belongsto') return 'Children';
  if (k === 'relatedto') return 'Referenced by';
  return `← ${humanizeKey(key)}`;
}

/**
 * Collect the wikilink target stems for a single frontmatter value. Accepts a
 * scalar (string) or an array; non-wikilink strings yield nothing. Returns
 * lowercased stems for `byStem` lookup.
 */
export function wikilinkTargetsFromValue(value: unknown): string[] {
  const out: string[] = [];
  const collect = (v: unknown) => {
    if (typeof v === 'string') {
      for (const w of extractWikilinks(v)) out.push(w.target.toLowerCase());
    } else if (Array.isArray(v)) {
      for (const item of v) collect(item);
    }
  };
  collect(value);
  return out;
}

/** True if a frontmatter key/value pair is a relationship (non-reserved key
 *  whose value carries at least one wikilink). */
function isRelationshipEntry(key: string, value: unknown): boolean {
  if (RESERVED_KEYS.has(key.toLowerCase())) return false;
  return wikilinkTargetsFromValue(value).length > 0;
}

/**
 * Build the focal note's outgoing relationship groups: one group per
 * relationship key, resolved (via byStem) to target entries. Self-links and
 * duplicate paths within a group are dropped; unresolved targets are skipped.
 */
function buildOutgoing(
  focal: IndexEntry,
  byStem: Map<string, IndexEntry>,
): NeighborGroup[] {
  const fm = focal.frontmatter;
  if (!fm) return [];
  const groups: NeighborGroup[] = [];
  const keys = Object.keys(fm).sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const value = fm[key];
    if (!isRelationshipEntry(key, value)) continue;
    const seen = new Set<string>();
    const refs: NeighborRef[] = [];
    for (const stem of wikilinkTargetsFromValue(value)) {
      const target = byStem.get(stem);
      if (!target) continue;
      if (target.path === focal.path) continue; // self
      if (seen.has(target.path)) continue;
      seen.add(target.path);
      refs.push(toRef(target));
    }
    if (refs.length > 0) {
      groups.push({ key, label: humanizeKey(key), refs });
    }
  }
  return groups;
}

/**
 * Build inverse groups: scan every OTHER entry's relationship keys; if any
 * resolves to the focal note, file that entry under the inverse label for
 * that key. Groups are merged by label and dedup'd by path.
 */
function buildInverse(
  focal: IndexEntry,
  entries: IndexEntry[],
  byStem: Map<string, IndexEntry>,
): NeighborGroup[] {
  // label → { refs, paths-seen }
  const byLabel = new Map<string, { refs: NeighborRef[]; seen: Set<string> }>();
  const order: string[] = [];

  for (const other of entries) {
    if (other.path === focal.path) continue;
    const fm = other.frontmatter;
    if (!fm) continue;
    for (const key of Object.keys(fm)) {
      const value = fm[key];
      if (!isRelationshipEntry(key, value)) continue;
      // Does any wikilink in this key resolve to the focal note?
      let pointsBack = false;
      for (const stem of wikilinkTargetsFromValue(value)) {
        if (byStem.get(stem)?.path === focal.path) {
          pointsBack = true;
          break;
        }
      }
      if (!pointsBack) continue;
      const label = inverseLabelFor(key);
      let bucket = byLabel.get(label);
      if (!bucket) {
        bucket = { refs: [], seen: new Set() };
        byLabel.set(label, bucket);
        order.push(label);
      }
      if (!bucket.seen.has(other.path)) {
        bucket.seen.add(other.path);
        bucket.refs.push(toRef(other));
      }
    }
  }

  return order.map((label) => ({
    key: label,
    label,
    refs: byLabel.get(label)!.refs.sort((a, b) => a.title.localeCompare(b.title)),
  }));
}

/**
 * Compute the full neighborhood (outgoing + inverse groups) for a focal note.
 * Backlinks (body links) are fetched separately by the panel because they
 * come from the Rust `workspace_index_backlinks` command, not frontmatter.
 *
 * Pure & memoizable: callers should memoize on `(focal.path, entries identity)`.
 */
export function buildNeighborhood(
  focal: IndexEntry,
  entries: IndexEntry[],
  byStem: Map<string, IndexEntry>,
): Neighborhood {
  return {
    outgoing: buildOutgoing(focal, byStem),
    inverse: buildInverse(focal, entries, byStem),
  };
}

// ---------------------------------------------------------------------------
// Pivot history stack (port of Tolaria's neighborhoodHistory.ts). Panel-local:
// pivoting refocuses the panel on another note WITHOUT opening it in a tab,
// and Escape pops back. Kept as a tiny pure helper so it's unit-testable.
// ---------------------------------------------------------------------------

export interface NeighborhoodHistory {
  /** Stack of focal note paths visited via pivot; top = current focal. */
  stack: string[];
}

export function createHistory(rootPath: string | null): NeighborhoodHistory {
  return { stack: rootPath ? [rootPath] : [] };
}

/** Push a new focal note (pivot). No-op if already the current focal. */
export function pushHistory(h: NeighborhoodHistory, path: string): NeighborhoodHistory {
  if (h.stack[h.stack.length - 1] === path) return h;
  return { stack: [...h.stack, path] };
}

/** Pop the current focal (Escape-to-back). Returns the new top path, or the
 *  unchanged stack when there's nothing to pop back to (≤1 entry). */
export function popHistory(h: NeighborhoodHistory): { history: NeighborhoodHistory; top: string | null } {
  if (h.stack.length <= 1) {
    return { history: h, top: h.stack[0] ?? null };
  }
  const stack = h.stack.slice(0, -1);
  return { history: { stack }, top: stack[stack.length - 1] };
}

export function historyTop(h: NeighborhoodHistory): string | null {
  return h.stack[h.stack.length - 1] ?? null;
}

export function canGoBack(h: NeighborhoodHistory): boolean {
  return h.stack.length > 1;
}
