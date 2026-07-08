/**
 * F3 — Typed relationships (v4.6).
 *
 * Markdown-first, exactly like Tolaria: a *typed relationship* is any
 * non-reserved front-matter key whose value contains one or more
 * `[[wikilink]]` refs (scalar string or an array of strings). There is NO
 * separate relationship database — forward edges are authored in YAML
 * front matter, and inverses are computed in-memory across the workspace
 * index.
 *
 * This module is pure (no Pinia / Tauri imports) so the extraction, inverse
 * labelling, and front-matter edit-string transforms stay unit-testable.
 * The Rust side (`workspace_index.rs::extract_relationships`) mirrors
 * `extractRelationships` below; keep the two in sync — see the parity test
 * in `relationships.test.ts` and the Rust `workspace_index_relationships_tests.rs`.
 */

import { extractWikilinks } from './wikilinks';

/**
 * Front-matter keys that are *structural* and never count as a typed
 * relationship even if (pathologically) they contain a wikilink. Mirrors
 * Tolaria's `FrontmatterKey::is_reserved()` set and the Rust
 * `RESERVED_RELATIONSHIP_KEYS` const in `workspace_index.rs`. Keep the two
 * lists byte-for-byte identical — `relationships.test.ts` asserts parity.
 *
 * Matching is case-insensitive and also treats `_`-prefixed keys as reserved
 * (handled in `isReservedKey`, not listed here).
 */
export const RESERVED_RELATIONSHIP_KEYS: readonly string[] = [
  'title',
  'aliases',
  'alias',
  'tags',
  'tag',
  'status',
  'date',
  'created',
  'modified',
  'updated',
  'icon',
  'color',
  'colour',
  'cssclass',
  'cssclasses',
  'publish',
  'permalink',
  'inbox',
];

const RESERVED_SET = new Set(RESERVED_RELATIONSHIP_KEYS.map((k) => k.toLowerCase()));

/** True when `key` is a reserved/structural front-matter key (case-insensitive,
 *  plus any `_`-prefixed key). Such keys are excluded from relationship
 *  detection. */
export function isReservedKey(key: string): boolean {
  const k = key.trim();
  if (k.length === 0) return true;
  if (k.startsWith('_')) return true;
  return RESERVED_SET.has(k.toLowerCase());
}

/** Does this string contain at least one `[[wikilink]]`? */
export function containsWikilink(value: string): boolean {
  return extractWikilinks(value).length > 0;
}

/**
 * Collect every wikilink-bearing string from a front-matter value, recursing
 * into arrays. Each ref is preserved in its canonical `[[target]]` form
 * (re-emitted from the parsed wikilink so `[[a|alias]]`/`[[a#h]]` collapse to
 * the bare target — matching how the index resolves them).
 *
 * The `nested_flow_wikilink` special case from Tolaria (a one-element array
 * `[ [target] ]` meaning `[[target]]`) is handled by serde/js-yaml at parse
 * time producing `[['target']]`; we treat a string nested at any array depth
 * the same as a scalar.
 */
function collectRefs(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    for (const link of extractWikilinks(value)) {
      out.push(`[[${link.target}]]`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out);
  }
  // numbers / booleans / null / objects can't carry a wikilink — ignore.
}

/**
 * Extract the typed relationships from a parsed front-matter object.
 *
 * Returns a map `relationship key → list of canonical [[ref]]s`, keeping only
 * non-reserved keys whose value contains at least one wikilink. The order of
 * keys follows insertion order of the front-matter object.
 */
export function extractRelationships(
  frontmatter: Record<string, unknown> | null | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!frontmatter || typeof frontmatter !== 'object') return out;
  for (const [key, value] of Object.entries(frontmatter)) {
    if (isReservedKey(key)) continue;
    const refs: string[] = [];
    collectRefs(value, refs);
    if (refs.length > 0) out[key] = refs;
  }
  return out;
}

/** Strip the `[[ ]]` brackets (and any `#heading` / `|alias`) from a ref,
 *  returning the bare target stem. `[[a|b]]` → `a`, `[[a#h]]` → `a`. */
export function parseWikilinkTarget(ref: string): string {
  const links = extractWikilinks(ref);
  if (links.length > 0) return links[0].target;
  // Not bracketed — treat the whole (trimmed) string as the target.
  return ref.trim();
}

/**
 * Humanize a relationship key for display: `belongs_to` → `Belongs to`,
 * `relatedTo` → `Related to`, `cites` → `Cites`. Splits on `_`, `-`, and
 * camelCase boundaries, lower-cases the tail, and capitalizes the first word.
 */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  if (spaced.length === 0) return key;
  const lower = spaced.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Normalize a key for inverse-label lookup: lower-case, collapse `_`/`-`/
 *  spaces, and split camelCase so `belongsTo`, `belongs_to`, `Belongs To`
 *  all map to `belongs to`. */
function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Convenience inverse-label map. `belongs_to` → `Children`, `related_to` →
 * `Referenced by`; anything else falls through to `← <Humanized Key>`. This
 * is a small data map, not hardcoded behavior — adding a key here adds an
 * inverse label without touching call sites.
 */
const INVERSE_LABELS: Record<string, string> = {
  'belongs to': 'Children',
  'related to': 'Referenced by',
};

/**
 * Resolve the human-facing inverse label for a forward relationship key.
 * E.g. a note with `belongs_to: [[Parent]]` shows up under "Children" on the
 * Parent's panel; `cites: [[Paper]]` shows up under "← Cites" on the Paper.
 */
export function resolveInverseLabel(key: string): string {
  const norm = normalizeKey(key);
  const mapped = INVERSE_LABELS[norm];
  if (mapped) return mapped;
  return `← ${humanizeKey(key)}`;
}

/**
 * Order resolved inverse labels so the well-known ones (Children, Referenced
 * by) pin to the top, with custom `← …` labels after, alphabetically.
 */
export function orderInverseLabels(labels: string[]): string[] {
  const PINNED = ['Children', 'Referenced by'];
  const pinned = PINNED.filter((l) => labels.includes(l));
  const rest = labels
    .filter((l) => !PINNED.includes(l))
    .sort((a, b) => a.localeCompare(b));
  return [...pinned, ...rest];
}

// ---------------------------------------------------------------------------
// Front-matter edit-string transforms (single-ref scalar vs array; add/remove).
//
// These operate on the raw YAML *front-matter block text* (the content
// between the leading `---` and the closing `---`), so a relationship edit
// never touches the document body. They are deliberately conservative: a
// single ref is written as `key: "[[target]]"`; multiple refs as a YAML list;
// removing the last ref deletes the key entirely.
// ---------------------------------------------------------------------------

/** Build the YAML lines for a relationship key given its current ref list.
 *  Empty list → empty array (caller deletes the key instead). */
function emitRelationshipLines(key: string, refs: string[]): string[] {
  if (refs.length === 1) {
    return [`${key}: "${refs[0]}"`];
  }
  const lines = [`${key}:`];
  for (const r of refs) lines.push(`  - "${r}"`);
  return lines;
}

/**
 * Return the [startLine, endLineExclusive) span of the block of YAML lines
 * that define `key` (the `key:` line plus any following indented list items).
 * Returns null when the key is absent.
 */
function findKeySpan(lines: string[], key: string): [number, number] | null {
  const keyLc = key.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)([^:\s][^:]*?)\s*:/);
    if (!m) continue;
    if (m[1].length !== 0) continue; // only top-level keys
    if (m[2].trim().toLowerCase() !== keyLc) continue;
    // Found the key line; consume following indented (list / block) lines.
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (line.trim() === '') {
        j++;
        continue;
      }
      if (/^\s+/.test(line)) {
        j++;
        continue;
      }
      break;
    }
    return [i, j];
  }
  return null;
}

/**
 * Set the full ref list for a relationship `key` inside a front-matter block
 * (the text BETWEEN the `---` fences, no fences). Passing an empty `refs`
 * array deletes the key. Returns the rewritten block text.
 *
 * Pure string transform over the YAML block — used by `useRelationships`
 * after it splices the block back into the document.
 */
export function setRelationshipInBlock(
  block: string,
  key: string,
  refs: string[],
): string {
  const lines = block.split('\n');
  const span = findKeySpan(lines, key);
  const newLines = refs.length === 0 ? [] : emitRelationshipLines(key, refs);
  if (span) {
    lines.splice(span[0], span[1] - span[0], ...newLines);
  } else if (newLines.length > 0) {
    // Append at the end of the block. Drop a trailing empty line first so we
    // don't grow blank lines unboundedly across repeated edits.
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(...newLines);
  }
  return lines.join('\n');
}
