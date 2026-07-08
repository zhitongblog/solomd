/**
 * Saved-view on-disk file format (F5 — Markdown-first YAML sidecar).
 *
 * Each saved view is ONE file at `{workspace}/.solomd/views/{slug}.yml`,
 * mirroring Tolaria's "one file per view" model. No note frontmatter is
 * touched — views are standalone documents that git-round-trip cleanly.
 *
 * The filter schema REUSES the already-generalized `bases.ts` engine: a view's
 * `filters` is a {@link FilterGroup} (`combinator: 'all' | 'any'`, recursive
 * `children`). As of v4.6 M0c `bases.ts` owns the recursive all/any tree, the
 * full operator set, and the `matchesGroup` evaluator, so this module NO LONGER
 * reimplements matching. It keeps only the view-layer concerns:
 *   - the `ViewFile` shape + slug derivation,
 *   - YAML <-> object serialization (stable, round-trippable),
 *   - normalization of loosely-typed parsed YAML into a well-formed ViewFile,
 *   - the friendlier view op VOCABULARY (`not_contains`, `any_of`, `regex`, …)
 *     which is translated down to bases' canonical ops before evaluation,
 *   - ReDoS-safe regex compilation (the view UI accepts raw user patterns).
 *
 * `matchesGroup` / `matchesLeaf` below are thin adapters: they lower a view
 * `FilterGroup` into a bases `FilterGroup` and delegate to `bases.matchesGroup`.
 *
 * Relationship operators (`linksTo` / `backlinksTo`) live on the leaf as
 * regular ops; bases.ts doesn't evaluate them, so the store rewrites those
 * leaves against a precomputed wikilink adjacency map before evaluation
 * (see savedViews store). Persisting them verbatim keeps the YAML expressive.
 */
import yaml from 'js-yaml';
import {
  matchesGroup as basesMatchesGroup,
  type ColumnDef,
  type SortSpec,
  type FilterGroup as BasesFilterGroup,
  type FilterNode as BasesFilterNode,
  type FilterLeaf as BasesFilterLeaf,
  type FilterOp as BasesFilterOp,
} from './bases';
import type { IndexEntry } from '../stores/workspaceIndex';

// ---------------------------------------------------------------------------
// Recursive all/any filter tree (the Tolaria-parity vocabulary on top of
// bases.ts). The TREE SHAPE is structurally identical to bases'; only the
// op vocabulary differs, and `toBasesNode` translates it.
// ---------------------------------------------------------------------------

/** Extended operator set understood by the view layer (a friendly alias set). */
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
// Operator vocabulary (UI)
// ---------------------------------------------------------------------------

/** Whether an op compares ordered values (date / number). */
export function opIsOrdered(op: ViewOp): boolean {
  return op === 'before' || op === 'after';
}

/** Whether an op takes a list (comma-separated) value. */
export function opIsMultiValue(op: ViewOp): boolean {
  return op === 'any_of' || op === 'none_of';
}

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

/** Split a multi-value (`any_of`) input into a trimmed string list. */
export function toList(v: unknown): string[] {
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

/**
 * True when a regex leaf's source is non-empty AND fails the ReDoS-safety
 * gate. Used by the builder to flag a bad pattern in the UI.
 */
export function isRegexLeafInvalid(leaf: FilterLeaf): boolean {
  if (leaf.op !== 'regex') return false;
  const v = String(leaf.value ?? '');
  return v.length > 0 && compileSafeUserRegex(v) === null;
}

// ---------------------------------------------------------------------------
// View → bases translation. The view vocabulary is a friendly superset of
// bases' canonical ops; we lower it so the SINGLE bases engine does matching.
// ---------------------------------------------------------------------------

/** A sentinel that can never equal a real file name (always-false leaf). */
const NEVER_LEAF: BasesFilterLeaf = { column: 'name', op: 'eq', value: ' __no_match__' };
/**
 * Always-TRUE leaf (a file `name` is never empty). Used to lower a "no-op"
 * view leaf — an empty `any_of`/`none_of`/`regex` value — so it doesn't filter
 * anything out (the historical F5 semantics: a blank value = no constraint).
 */
const ALWAYS_LEAF: BasesFilterLeaf = { column: 'name', op: 'isNotEmpty' };

/**
 * Lower a single view leaf into a bases `FilterNode`. Most ops are a direct
 * alias; `any_of`/`none_of` expand into a nested group; `regex` is validated
 * (a dangerous/invalid pattern becomes an always-false leaf so it can't hang
 * or accidentally match); relationship ops should already be lowered by the
 * store, so any that slip through here become always-false.
 */
function leafToBases(leaf: FilterLeaf): BasesFilterNode {
  const { column, value } = leaf;
  switch (leaf.op) {
    case 'contains':
      return { column, op: 'contains', value };
    case 'not_contains':
      return { column, op: 'notContains', value };
    case 'equals':
      return { column, op: 'eq', value };
    case 'not_equals':
      return { column, op: 'neq', value };
    case 'starts-with':
      return { column, op: 'startsWith', value };
    case 'has-tag':
      return { column, op: 'has-tag', value };
    case 'is-empty':
      return { column, op: 'isEmpty' };
    case 'is-not-empty':
      return { column, op: 'isNotEmpty' };
    // `before`/`after` are date-OR-number aware in bases via `lt`/`gt`.
    case 'before':
      return { column, op: 'lt', value };
    case 'after':
      return { column, op: 'gt', value };
    case 'any_of': {
      const wanted = toList(value);
      if (wanted.length === 0) return { ...ALWAYS_LEAF }; // empty list → no constraint
      return {
        combinator: 'any',
        children: wanted.map((w) => ({ column, op: 'eq' as BasesFilterOp, value: w })),
      };
    }
    case 'none_of': {
      const wanted = toList(value);
      if (wanted.length === 0) return { ...ALWAYS_LEAF };
      return {
        combinator: 'all',
        children: wanted.map((w) => ({ column, op: 'neq' as BasesFilterOp, value: w })),
      };
    }
    case 'regex': {
      const src = String(value ?? '');
      if (src === '') return { ...ALWAYS_LEAF }; // empty regex → no constraint
      // ReDoS-safe gate. A dangerous/invalid pattern matches nothing.
      return compileSafeUserRegex(src)
        ? { column, op: 'matches', value: src }
        : { ...NEVER_LEAF };
    }
    case 'linksTo':
    case 'backlinksTo':
      // Should have been lowered by the store; if not, never match.
      return { ...NEVER_LEAF };
    default:
      return { ...ALWAYS_LEAF };
  }
}

/**
 * Recursively lower a view `FilterGroup` into a bases `FilterGroup`.
 *
 * View semantics differ from bases for the empty case: an empty view group
 * matches EVERYTHING regardless of combinator ("an empty filter = all notes",
 * at any nesting depth). bases' empty `any` group is false, so we lower an
 * empty group to a single always-true leaf rather than an empty group, keeping
 * the historical F5 behavior while still using the one bases engine to match.
 */
export function toBasesGroup(group: FilterGroup): BasesFilterGroup {
  const rawChildren = group.children ?? [];
  if (rawChildren.length === 0) {
    return { combinator: 'all', children: [{ ...ALWAYS_LEAF }] };
  }
  const children: BasesFilterNode[] = rawChildren.map((child) =>
    isFilterGroup(child) ? toBasesGroup(child) : leafToBases(child),
  );
  return { combinator: group.combinator, children };
}

// ---------------------------------------------------------------------------
// Evaluation — thin adapters that delegate to the single bases engine.
// ---------------------------------------------------------------------------

/** Evaluate a single leaf against an entry (lowered to bases, then matched). */
export function matchesLeaf(
  entry: IndexEntry,
  leaf: FilterLeaf,
  columns: ColumnDef[],
): boolean {
  const node = leafToBases(leaf);
  const group: BasesFilterGroup = isBasesGroup(node)
    ? node
    : { combinator: 'all', children: [node] };
  // An empty lowered group (e.g. empty regex / empty any_of) is a no-op → true.
  if (group.children.length === 0) return true;
  return basesMatchesGroup(entry, group, columns);
}

/**
 * Recursively evaluate a view filter group. Translates the whole tree once,
 * then defers all matching to `bases.matchesGroup` — there is no separate
 * matching engine here.
 *
 * Note: a view `all`/`any` group with ZERO children matches EVERYTHING (the
 * historical F5 semantics: "an empty filter = all notes"). bases' `any` with
 * zero children would be false, so we short-circuit empties to true here
 * before delegating, preserving the documented view behavior.
 */
export function matchesGroup(
  entry: IndexEntry,
  group: FilterGroup,
  columns: ColumnDef[],
): boolean {
  if (!group.children || group.children.length === 0) return true;
  return basesMatchesGroup(entry, toBasesGroup(group), columns);
}

function isBasesGroup(node: BasesFilterNode): node is BasesFilterGroup {
  return (
    typeof node === 'object' &&
    node != null &&
    'combinator' in node &&
    Array.isArray((node as BasesFilterGroup).children)
  );
}

// ---------------------------------------------------------------------------
// Normalization of loosely-typed parsed YAML.
// ---------------------------------------------------------------------------

/**
 * Coerce arbitrary parsed input into a well-formed FilterGroup. Accepts:
 *   - a real group `{combinator, children}` (recursed),
 *   - a Tolaria-style `{all:[...]}` / `{any:[...]}` shorthand,
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
  // A leaf — require a column + op. Accept `key` as an alias for `column`
  // (matches bases' tolerant deserialization of external YAML/JSON).
  const column =
    typeof o.column === 'string' ? o.column : typeof o.key === 'string' ? o.key : undefined;
  if (column && typeof o.op === 'string') {
    const leaf: FilterLeaf = { column, op: o.op as ViewOp };
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
