/**
 * Saved-view on-disk file format (F5 — Markdown-first YAML sidecar).
 *
 * Each saved view is ONE file at `{workspace}/.solomd/views/{slug}.yml`,
 * mirroring Tolaria's "one file per view" model. No note frontmatter is
 * touched — views are standalone documents that git-round-trip cleanly.
 *
 * The filter schema REUSES the already-generalized `bases.ts` engine: a view's
 * `filters` is a {@link FilterGroup} (`combinator: 'all' | 'any'`, recursive
 * `children`). We deliberately do NOT re-implement matching here — the store
 * evaluates with `bases.matchesGroup`. This module only owns:
 *   - the `ViewFile` shape,
 *   - slug derivation,
 *   - YAML <-> object serialization (stable, round-trippable),
 *   - normalization of loosely-typed parsed YAML into a well-formed ViewFile.
 *
 * Relationship operators (`linksTo` / `backlinksTo`) live on the leaf as
 * regular ops; bases.ts doesn't evaluate them, so the store rewrites those
 * leaves against a precomputed wikilink adjacency map before evaluation
 * (see savedViews store). Persisting them verbatim keeps the YAML expressive.
 */
import yaml from 'js-yaml';
import {
  getRawValue,
  type ColumnDef,
  type SortSpec,
} from './bases';
import type { IndexEntry } from '../stores/workspaceIndex';

// ---------------------------------------------------------------------------
// Recursive all/any filter tree (the Tolaria-parity layer on top of bases.ts).
//
// `bases.ts` only knows a flat `Filter[]` AND-list and a fixed op set. Rather
// than touch the read-only engine, the recursive `FilterGroup` model + the
// extended op set (any_of / none_of / before / after / regex + relationship
// ops) live HERE and evaluate against bases' exported `getRawValue`. The store
// pre-pass lowers relationship + relative-date leaves before evaluation.
// ---------------------------------------------------------------------------

/** Extended operator set understood by the view engine. */
export type ViewOp =
  | 'contains'
  | 'not_contains'
  | 'equals'
  | 'not_equals'
  | 'starts-with'
  | 'before'
  | 'after'
  | 'any_of'
  | 'none_of'
  | 'is-empty'
  | 'is-not-empty'
  | 'has-tag'
  | 'regex'
  | RelationshipOp;

/** A single leaf condition in the filter tree. */
export interface FilterLeaf {
  /** Column id (bases `ColumnDef.id`: `name`/`mtime`/`tags`/`fm:<key>`). */
  column: string;
  op: ViewOp;
  /** Comparison value. Optional for is-empty / is-not-empty. */
  value?: unknown;
}

/** A boolean group: combine `children` with all (AND) or any (OR). */
export interface FilterGroup {
  combinator: 'all' | 'any';
  children: FilterNode[];
}

export type FilterNode = FilterLeaf | FilterGroup;

/** Narrow a node to a group. */
export function isFilterGroup(node: FilterNode): node is FilterGroup {
  return (
    !!node &&
    typeof node === 'object' &&
    'combinator' in node &&
    Array.isArray((node as FilterGroup).children)
  );
}

/** A view as it lives on disk + in the store. */
export interface ViewFile {
  /** Stable id derived from the filename (sans `.yml`). */
  slug: string;
  /** Human-readable view name (shown in the sidebar). */
  name: string;
  /** Optional emoji / single-char glyph rendered as the row icon. */
  icon?: string;
  /** Optional accent color (any CSS color) used to tint the icon swatch. */
  color?: string;
  /** Manual sort order in the sidebar (ascending). Lower = higher up. */
  order: number;
  /** Column ids shown as muted chips on each note row. Empty = none. */
  columns: string[];
  /** Single-column sort spec, or null for default (mtime desc). */
  sort: SortSpec | null;
  /** Recursive all/any filter tree — evaluated via bases.matchesGroup. */
  filters: FilterGroup;
}

/** Relationship operators understood at the view layer (resolved in store). */
export const RELATIONSHIP_OPS = ['linksTo', 'backlinksTo'] as const;
export type RelationshipOp = (typeof RELATIONSHIP_OPS)[number];

export function isRelationshipOp(op: string): op is RelationshipOp {
  return (RELATIONSHIP_OPS as readonly string[]).includes(op);
}

// ---------------------------------------------------------------------------
// Filter evaluation
// ---------------------------------------------------------------------------

/** Operators the value/op dropdowns offer, grouped for the builder UI. */
export const VIEW_OPS: { value: ViewOp; label: string; needsValue: boolean }[] = [
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'not_contains', label: 'does not contain', needsValue: true },
  { value: 'equals', label: 'equals', needsValue: true },
  { value: 'not_equals', label: 'does not equal', needsValue: true },
  { value: 'starts-with', label: 'starts with', needsValue: true },
  { value: 'has-tag', label: 'has tag', needsValue: true },
  { value: 'any_of', label: 'is any of', needsValue: true },
  { value: 'none_of', label: 'is none of', needsValue: true },
  { value: 'before', label: 'before', needsValue: true },
  { value: 'after', label: 'after', needsValue: true },
  { value: 'is-empty', label: 'is empty', needsValue: false },
  { value: 'is-not-empty', label: 'is not empty', needsValue: false },
  { value: 'regex', label: 'matches regex', needsValue: true },
  { value: 'linksTo', label: 'links to', needsValue: true },
  { value: 'backlinksTo', label: 'is linked from', needsValue: true },
];

function asString(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** Coerce a cell/filter value to epoch ms, or null if not date-like. */
function toEpochMs(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return null;
}

/** Split a multi-value (`any_of`) input into a trimmed string list. */
function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Compile a user-supplied regex in a ReDoS-resistant way: reject catastrophic
 * nested quantifiers and cap source length. Returns null on a bad/dangerous
 * pattern so the leaf simply doesn't match (rather than hanging the UI).
 */
export function compileSafeUserRegex(src: string): RegExp | null {
  if (typeof src !== 'string' || src.length === 0 || src.length > 1000) return null;
  // Heuristic guard against the classic nested-quantifier bombs: a group whose
  // body already contains an unbounded quantifier, and which is ITSELF
  // quantified — e.g. `(a+)+`, `(a*)*`, `(a+)*`, `(\d+)+`, `([a-z]*)+`. These
  // make the engine backtrack exponentially. We don't try to be a full parser;
  // we just reject the obviously dangerous shapes.
  if (/\([^()]*[+*}][^()]*\)\s*[+*]/.test(src)) return null;
  if (/\([^()]*\)\s*[+*]\s*[+*]/.test(src)) return null; // `(a)++`, `(a)**`
  try {
    return new RegExp(src, 'i');
  } catch {
    return null;
  }
}

/** Evaluate a single leaf against an entry, given the resolved columns. */
export function matchesLeaf(
  entry: IndexEntry,
  leaf: FilterLeaf,
  columns: ColumnDef[],
): boolean {
  const col = columns.find((c) => c.id === leaf.column);
  if (!col) return true; // unknown column → non-filtering, like bases.ts
  const raw = getRawValue(entry, col);
  const isDate = col.kind === 'date' || (col.source === 'builtin' && col.id === 'mtime');

  switch (leaf.op) {
    case 'is-empty':
      return isEmptyValue(raw);
    case 'is-not-empty':
      return !isEmptyValue(raw);
    case 'contains': {
      const n = String(leaf.value ?? '').toLowerCase();
      return n === '' ? true : asString(raw).toLowerCase().includes(n);
    }
    case 'not_contains': {
      const n = String(leaf.value ?? '').toLowerCase();
      return n === '' ? true : !asString(raw).toLowerCase().includes(n);
    }
    case 'starts-with': {
      const n = String(leaf.value ?? '').toLowerCase();
      return n === '' ? true : asString(raw).toLowerCase().startsWith(n);
    }
    case 'equals': {
      const want = leaf.value;
      if (Array.isArray(raw)) return raw.some((x) => String(x) === String(want));
      return String(raw ?? '') === String(want ?? '');
    }
    case 'not_equals': {
      const want = leaf.value;
      if (Array.isArray(raw)) return !raw.some((x) => String(x) === String(want));
      return String(raw ?? '') !== String(want ?? '');
    }
    case 'has-tag': {
      const tags = Array.isArray(raw)
        ? raw.map((x) => String(x))
        : asString(raw).split(',').map((s) => s.trim()).filter(Boolean);
      const wanted = toList(leaf.value);
      return wanted.length === 0 ? true : wanted.some((w) => tags.includes(w));
    }
    case 'any_of': {
      const wanted = toList(leaf.value).map((s) => s.toLowerCase());
      if (wanted.length === 0) return true;
      const have = Array.isArray(raw)
        ? raw.map((x) => String(x).toLowerCase())
        : [asString(raw).toLowerCase()];
      return wanted.some((w) => have.includes(w));
    }
    case 'none_of': {
      const wanted = toList(leaf.value).map((s) => s.toLowerCase());
      if (wanted.length === 0) return true;
      const have = Array.isArray(raw)
        ? raw.map((x) => String(x).toLowerCase())
        : [asString(raw).toLowerCase()];
      return !wanted.some((w) => have.includes(w));
    }
    case 'before': {
      if (isDate) {
        const a = toEpochMs(raw);
        const b = toEpochMs(leaf.value);
        return a == null || b == null ? false : a < b;
      }
      const a = Number(asString(raw));
      const b = Number(asString(leaf.value));
      return Number.isFinite(a) && Number.isFinite(b) ? a < b : false;
    }
    case 'after': {
      if (isDate) {
        const a = toEpochMs(raw);
        const b = toEpochMs(leaf.value);
        return a == null || b == null ? false : a > b;
      }
      const a = Number(asString(raw));
      const b = Number(asString(leaf.value));
      return Number.isFinite(a) && Number.isFinite(b) ? a > b : false;
    }
    case 'regex': {
      const re = compileSafeUserRegex(String(leaf.value ?? ''));
      return re ? re.test(asString(raw)) : false;
    }
    // Relationship ops are lowered to membership predicates by the store before
    // they reach this matcher; if one slips through, treat it as non-matching.
    case 'linksTo':
    case 'backlinksTo':
      return false;
    default:
      return true;
  }
}

/** Recursively evaluate a filter group (all = AND, any = OR). */
export function matchesGroup(
  entry: IndexEntry,
  group: FilterGroup,
  columns: ColumnDef[],
): boolean {
  const children = group.children ?? [];
  if (children.length === 0) return true; // empty group matches everything
  const test = (node: FilterNode): boolean =>
    isFilterGroup(node)
      ? matchesGroup(entry, node, columns)
      : matchesLeaf(entry, node, columns);
  return group.combinator === 'any' ? children.some(test) : children.every(test);
}

/**
 * Coerce arbitrary parsed input into a well-formed FilterGroup. Accepts:
 *   - a real group `{combinator, children}` (recursed),
 *   - a bare array of leaves (wrapped as `{all: [...]}` — bases back-compat),
 *   - anything else → an empty `all` group.
 */
export function normalizeFilterGroup(raw: unknown): FilterGroup {
  if (Array.isArray(raw)) {
    return { combinator: 'all', children: raw.map(normalizeNode).filter(Boolean) as FilterNode[] };
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    // Tolaria-style `{all:[...]}` / `{any:[...]}` shorthand.
    if (Array.isArray(o.all)) {
      return { combinator: 'all', children: (o.all as unknown[]).map(normalizeNode).filter(Boolean) as FilterNode[] };
    }
    if (Array.isArray(o.any)) {
      return { combinator: 'any', children: (o.any as unknown[]).map(normalizeNode).filter(Boolean) as FilterNode[] };
    }
    if ('combinator' in o || 'children' in o) {
      const combinator = o.combinator === 'any' ? 'any' : 'all';
      const children = Array.isArray(o.children)
        ? (o.children as unknown[]).map(normalizeNode).filter(Boolean) as FilterNode[]
        : [];
      return { combinator, children };
    }
  }
  return { combinator: 'all', children: [] };
}

function normalizeNode(raw: unknown): FilterNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  // A nested group?
  if ('combinator' in o || 'children' in o || Array.isArray(o.all) || Array.isArray(o.any)) {
    return normalizeFilterGroup(o);
  }
  // A leaf — require a column + op.
  if (typeof o.column === 'string' && typeof o.op === 'string') {
    const leaf: FilterLeaf = { column: o.column, op: o.op as ViewOp };
    if ('value' in o) leaf.value = o.value;
    return leaf;
  }
  return null;
}

/** Folder (relative to the workspace root) where view files live. */
export const VIEWS_DIR = '.solomd/views';

/**
 * Derive a filesystem-safe slug from a view name. Lowercase, spaces → `-`,
 * strip anything that isn't `[a-z0-9-]`, collapse repeats. Falls back to
 * `view` when the name has no usable characters (e.g. pure punctuation or
 * CJK, which we transliterate-skip rather than mangle).
 */
export function slugify(name: string): string {
  const base = (name || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    // Keep only ASCII word chars + dashes for a portable filename.
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'view';
}

/** Ensure a slug is unique against an existing set (appends -2, -3, …). */
export function uniqueSlug(name: string, taken: Set<string>): string {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

/**
 * Coerce arbitrary parsed-YAML / partial input into a well-formed ViewFile.
 * `slug` is supplied by the caller (derived from the filename so renaming the
 * file renames the view) and always wins over any `slug` key in the body.
 */
export function normalizeViewFile(slug: string, raw: unknown): ViewFile {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const name =
    typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : slug;

  const icon = typeof obj.icon === 'string' && obj.icon ? obj.icon : undefined;
  const color = typeof obj.color === 'string' && obj.color ? obj.color : undefined;

  const order =
    typeof obj.order === 'number' && Number.isFinite(obj.order) ? obj.order : 0;

  const columns = Array.isArray(obj.columns)
    ? obj.columns.filter((c): c is string => typeof c === 'string')
    : [];

  const sort = normalizeSort(obj.sort);

  // Accept both `filters` (tree) and a bare `filterGroup` key for resilience.
  const filters = normalizeFilterGroup(obj.filters ?? obj.filterGroup ?? []);

  return { slug, name, icon, color, order, columns, sort, filters };
}

function normalizeSort(raw: unknown): SortSpec | null {
  if (!raw || typeof raw !== 'object') {
    // Allow `"mtime:desc"` string form too.
    if (typeof raw === 'string' && raw.includes(':')) {
      const [column, dir] = raw.split(':');
      if (column) return { column, dir: dir === 'asc' ? 'asc' : 'desc' };
    }
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.column !== 'string' || !o.column) return null;
  return { column: o.column, dir: o.dir === 'asc' ? 'asc' : 'desc' };
}

/**
 * Serialize a ViewFile to YAML. The `slug` is intentionally NOT written (it's
 * the filename) so the file stays the single source of truth and renaming the
 * file is the way to rename the slug. Keys are emitted in a fixed order for
 * stable diffs. Undefined optionals are omitted entirely.
 */
export function serializeViewFile(view: ViewFile): string {
  const out: Record<string, unknown> = { name: view.name };
  if (view.icon) out.icon = view.icon;
  if (view.color) out.color = view.color;
  out.order = view.order;
  if (view.columns.length) out.columns = view.columns;
  if (view.sort) out.sort = { column: view.sort.column, dir: view.sort.dir };
  out.filters = view.filters;
  return yaml.dump(out, { lineWidth: 100, noRefs: true, sortKeys: false });
}

/**
 * Parse a YAML string into a ViewFile. Tolerant: malformed YAML or a
 * non-object document yields a minimal valid view (named after the slug, no
 * filters) rather than throwing, so one corrupt file can't break the panel.
 */
export function parseViewFile(slug: string, text: string): ViewFile {
  let parsed: unknown = null;
  try {
    parsed = yaml.load(text);
  } catch {
    parsed = null;
  }
  return normalizeViewFile(slug, parsed);
}

/** Build a default, empty view skeleton (used by "New view"). */
export function emptyView(slug: string, name: string): ViewFile {
  return {
    slug,
    name,
    order: 0,
    columns: [],
    sort: { column: 'mtime', dir: 'desc' },
    filters: { combinator: 'all', children: [] },
  };
}
