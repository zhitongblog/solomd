/**
 * Bases-style YAML properties table (v2.0 F6).
 *
 * Pure data utilities over the workspace index. No Tauri / DOM access — these
 * helpers feed `BasesView.vue`. The single source of truth is the
 * `useWorkspaceIndexStore` `entries: IndexEntry[]` array; we infer columns
 * from front-matter, format cell values, filter, and sort.
 *
 * Built-in columns (always present):
 *   - `name`  : file name
 *   - `mtime` : modified time (formatted YYYY-MM-DD HH:mm)
 *   - `tags`  : comma-joined tags
 *
 * User columns are auto-discovered: any front-matter key that appears in 2+
 * entries becomes a column. Type is inferred from the values.
 */
import type { IndexEntry } from '../stores/workspaceIndex';

export type ColumnKind = 'text' | 'date' | 'number' | 'array' | 'boolean';

export type ColumnSource = 'builtin' | 'frontmatter';

export interface ColumnDef {
  /** Stable column id used in filters/sort/saved views. */
  id: string;
  /** Human-readable header label. Defaults to id. */
  label: string;
  /** What kind of value lives here. Drives renderer + filter UI. */
  kind: ColumnKind;
  /** Where to read the cell value from. */
  source: ColumnSource;
  /** Front-matter key (only when `source === 'frontmatter'`). */
  fmKey?: string;
}

/**
 * The full operator set. The first group is the original v2.0 vocabulary
 * (kept verbatim for backward compatibility); the second group is the
 * Tolaria-parity extension added in v4.6.
 */
export type FilterOp =
  // --- original v2.0 operators (do not rename / remove) ---
  | 'contains'
  | 'equals'
  | 'starts-with'
  | '>'
  | '<'
  | 'is-empty'
  | 'has-tag'
  // --- v4.6 Tolaria-parity extension ---
  | 'eq'
  | 'neq'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'matches' // regex
  | 'before' // date <
  | 'after' // date >
  | 'on' // date ==
  | 'inLast'; // relative date window, e.g. "7d", "2w", "3mo"

export interface Filter {
  /** Column id this filter applies to. */
  column: string;
  op: FilterOp;
  /** Value to compare against. Type depends on op. */
  value?: unknown;
}

/**
 * A single predicate in a recursive filter tree. Structurally identical to
 * the flat {@link Filter}, so any `Filter` is already a valid `FilterLeaf`.
 *
 * `column` is the canonical key (a {@link ColumnDef} id such as `mtime` or
 * `fm:status`). When deserializing external YAML/JSON that used `key`
 * instead, {@link normalizeFilterGroup} maps `key` → `column`.
 */
export interface FilterLeaf {
  /** Column id (a.k.a. `key` in serialized form) this predicate reads. */
  column: string;
  op: FilterOp;
  value?: unknown;
}

export type Combinator = 'all' | 'any';

/**
 * A recursive filter tree node. `all` = logical AND of children, `any` =
 * logical OR. Children may themselves be groups, so nesting is unbounded.
 * Plain serializable object: no class instances, no functions — round-trips
 * cleanly through `JSON.parse(JSON.stringify(group))` and YAML.
 */
export interface FilterGroup {
  combinator: Combinator;
  children: FilterNode[];
}

export type FilterNode = FilterGroup | FilterLeaf;

/** Type guard: is this node a group (vs. a leaf)? */
export function isFilterGroup(node: FilterNode): node is FilterGroup {
  return (
    typeof node === 'object' &&
    node != null &&
    'combinator' in node &&
    Array.isArray((node as FilterGroup).children)
  );
}

export interface SortSpec {
  column: string;
  dir: 'asc' | 'desc';
}

export interface SavedView {
  name: string;
  /** Column ids in display order. Empty array means "auto" (all inferred). */
  columns: string[];
  /**
   * Flat AND filter list (v2.0 shape, still the canonical form for the
   * current BasesView UI). For richer all/any trees (F5 saved views) use
   * {@link filterGroup}; when present it takes precedence over `filters`.
   */
  filters: Filter[];
  /**
   * Optional recursive filter tree. Serializable plain object; round-trips
   * to/from `.solomd/views/*.yml`. When set, evaluate via
   * {@link applyFilterGroup}; `filters` is the flat-fallback projection.
   */
  filterGroup?: FilterGroup;
  sort: SortSpec | null;
}

// ---------- column inference ----------

const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Returns true if a string looks like an ISO 8601 date or date-time. */
export function isIsoDate(s: unknown): boolean {
  return typeof s === 'string' && ISO_8601_RE.test(s);
}

function kindOfValue(v: unknown): ColumnKind {
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number' && Number.isFinite(v)) return 'number';
  if (typeof v === 'string') {
    if (isIsoDate(v)) return 'date';
    // Number stored as string?
    if (v.trim() !== '' && !isNaN(Number(v))) return 'number';
    return 'text';
  }
  return 'text';
}

/**
 * Pick the dominant kind across a list of seen values. Tiebreakers:
 *   array > date > number > boolean > text
 * (most informative wins; "text" is the catch-all fallback).
 */
function dominantKind(kinds: ColumnKind[]): ColumnKind {
  if (kinds.length === 0) return 'text';
  const order: ColumnKind[] = ['array', 'date', 'number', 'boolean', 'text'];
  const counts = new Map<ColumnKind, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  let best: ColumnKind = 'text';
  let bestN = -1;
  for (const k of order) {
    const n = counts.get(k) ?? 0;
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

/**
 * Inspect every entry's frontmatter and return the columns to display.
 *
 * Algorithm:
 *   1. Always include builtins: name, mtime, tags.
 *   2. Count frontmatter-key occurrences across entries.
 *   3. Any key seen in >=2 entries becomes a user column.
 *   4. Infer column kind from sampled values (majority vote).
 *
 * The order is deterministic: builtins first, then user columns sorted
 * alphabetically by key.
 */
export function inferColumns(entries: IndexEntry[]): ColumnDef[] {
  const builtin: ColumnDef[] = [
    { id: 'name', label: 'Name', kind: 'text', source: 'builtin' },
    { id: 'mtime', label: 'Modified', kind: 'date', source: 'builtin' },
    { id: 'tags', label: 'Tags', kind: 'array', source: 'builtin' },
  ];

  const counts = new Map<string, number>();
  const samples = new Map<string, ColumnKind[]>();

  for (const e of entries) {
    const fm = e.frontmatter;
    if (!fm || typeof fm !== 'object') continue;
    for (const key of Object.keys(fm)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const arr = samples.get(key) ?? [];
      arr.push(kindOfValue((fm as Record<string, unknown>)[key]));
      samples.set(key, arr);
    }
  }

  const userKeys = Array.from(counts.entries())
    .filter(([, n]) => n >= 2)
    .map(([k]) => k)
    .sort((a, b) => a.localeCompare(b));

  const userCols: ColumnDef[] = userKeys.map((k) => ({
    id: `fm:${k}`,
    label: k,
    kind: dominantKind(samples.get(k) ?? []),
    source: 'frontmatter',
    fmKey: k,
  }));

  return [...builtin, ...userCols];
}

// ---------- cell extraction ----------

/** Format an mtime (unix seconds OR ms) as `YYYY-MM-DD HH:mm`. */
export function formatMtime(mtime: number): string {
  if (!mtime || !Number.isFinite(mtime)) return '';
  // Heuristic: values < 1e12 are seconds, otherwise ms.
  const ms = mtime < 1e12 ? mtime * 1000 : mtime;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Format an ISO date string in the same canonical format as mtime. */
export function formatIsoDate(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const pad = (n: number) => String(n).padStart(2, '0');
  // If the original string had no time component, render date only.
  const hasTime = /[T ]\d{2}:/.test(s);
  if (!hasTime) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Read the raw (unformatted) value for a column, used for sorting/filtering. */
export function getRawValue(entry: IndexEntry, column: ColumnDef): unknown {
  if (column.source === 'builtin') {
    switch (column.id) {
      case 'name':
        return entry.name;
      case 'mtime':
        return entry.mtime;
      case 'tags':
        return entry.tags;
    }
  }
  if (column.source === 'frontmatter' && column.fmKey) {
    const fm = entry.frontmatter;
    if (!fm) return undefined;
    return (fm as Record<string, unknown>)[column.fmKey];
  }
  return undefined;
}

/**
 * Read the value for a cell, formatted for display. Returns:
 *   - string for text/date/number/boolean/missing
 *   - string (joined) for arrays
 */
export function getCellValue(entry: IndexEntry, column: ColumnDef): unknown {
  const raw = getRawValue(entry, column);
  if (raw == null || raw === '') return '';

  if (column.source === 'builtin' && column.id === 'mtime') {
    return formatMtime(typeof raw === 'number' ? raw : Number(raw));
  }
  if (column.kind === 'array') {
    if (Array.isArray(raw)) return raw.join(', ');
    return String(raw);
  }
  if (column.kind === 'date' && typeof raw === 'string') {
    return formatIsoDate(raw);
  }
  if (column.kind === 'boolean') {
    return raw ? 'true' : 'false';
  }
  if (column.kind === 'number') {
    if (typeof raw === 'number') return String(raw);
    const n = Number(raw);
    return Number.isFinite(n) ? String(n) : String(raw);
  }
  return String(raw);
}

// ---------- filtering ----------

function asString(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** True when a column is date-like (a `date` kind or the builtin mtime). */
function isDateColumn(col: ColumnDef): boolean {
  return col.kind === 'date' || (col.source === 'builtin' && col.id === 'mtime');
}

/**
 * Parse a relative-duration token used by the `inLast` operator into a
 * millisecond span. Accepts e.g. `7d`, `2w`, `3mo`, `1y`, `12h`, `30m`,
 * or a bare number (interpreted as days). Returns null if unparseable.
 */
export function parseRelativeDuration(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v * 24 * 3600 * 1000; // bare number → days
  }
  if (typeof v !== 'string') return null;
  const m = v.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(mo|ms|[smhdwy])?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2] ?? 'd';
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  switch (unit) {
    case 'ms':
      return n;
    case 's':
      return n * SEC;
    case 'm':
      return n * MIN;
    case 'h':
      return n * HOUR;
    case 'd':
      return n * DAY;
    case 'w':
      return n * 7 * DAY;
    case 'mo':
      return n * 30 * DAY;
    case 'y':
      return n * 365 * DAY;
    default:
      return null;
  }
}

function matchFilter(
  entry: IndexEntry,
  filter: FilterLeaf,
  columns: ColumnDef[],
): boolean {
  const col = columns.find((c) => c.id === filter.column);
  if (!col) return true; // unknown column → don't filter
  const raw = getRawValue(entry, col);

  switch (filter.op) {
    // ---- emptiness ----
    case 'is-empty':
    case 'isEmpty':
      return isEmpty(raw);
    case 'isNotEmpty':
      return !isEmpty(raw);

    // ---- substring / affix ----
    case 'contains': {
      const needle = String(filter.value ?? '').toLowerCase();
      if (!needle) return true;
      return asString(raw).toLowerCase().includes(needle);
    }
    case 'notContains': {
      const needle = String(filter.value ?? '').toLowerCase();
      if (!needle) return true;
      return !asString(raw).toLowerCase().includes(needle);
    }
    case 'starts-with':
    case 'startsWith': {
      const needle = String(filter.value ?? '').toLowerCase();
      if (!needle) return true;
      return asString(raw).toLowerCase().startsWith(needle);
    }
    case 'endsWith': {
      const needle = String(filter.value ?? '').toLowerCase();
      if (!needle) return true;
      return asString(raw).toLowerCase().endsWith(needle);
    }

    // ---- equality ----
    case 'equals':
    case 'eq': {
      const want = filter.value;
      if (Array.isArray(raw)) return raw.some((x) => String(x) === String(want));
      return String(raw ?? '') === String(want ?? '');
    }
    case 'neq': {
      const want = filter.value;
      if (Array.isArray(raw)) return !raw.some((x) => String(x) === String(want));
      return String(raw ?? '') !== String(want ?? '');
    }

    // ---- regex ----
    case 'matches': {
      const pattern = String(filter.value ?? '');
      if (!pattern) return true;
      let re: RegExp;
      try {
        re = new RegExp(pattern, 'i');
      } catch {
        return false; // invalid regex never matches
      }
      return re.test(asString(raw));
    }

    // ---- tags (OR-membership) ----
    case 'has-tag': {
      // `value` may be a single tag string or an array (multi-select).
      const tags = Array.isArray(raw)
        ? raw.map((x) => String(x))
        : asString(raw)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
      const wanted = Array.isArray(filter.value)
        ? (filter.value as unknown[]).map((x) => String(x))
        : [String(filter.value ?? '')].filter(Boolean);
      if (wanted.length === 0) return true;
      // Match if entry has ANY of the wanted tags (multi-select OR semantics).
      return wanted.some((w) => tags.includes(w));
    }

    // ---- ordered comparisons (date- or number-aware) ----
    case '>':
    case 'gt': {
      if (isDateColumn(col)) {
        const a = toEpochMs(raw);
        const b = toEpochMs(filter.value);
        if (a == null || b == null) return false;
        return a > b;
      }
      const a = asNumber(raw);
      const b = asNumber(filter.value);
      if (a == null || b == null) return false;
      return a > b;
    }
    case 'gte': {
      if (isDateColumn(col)) {
        const a = toEpochMs(raw);
        const b = toEpochMs(filter.value);
        if (a == null || b == null) return false;
        return a >= b;
      }
      const a = asNumber(raw);
      const b = asNumber(filter.value);
      if (a == null || b == null) return false;
      return a >= b;
    }
    case '<':
    case 'lt': {
      if (isDateColumn(col)) {
        const a = toEpochMs(raw);
        const b = toEpochMs(filter.value);
        if (a == null || b == null) return false;
        return a < b;
      }
      const a = asNumber(raw);
      const b = asNumber(filter.value);
      if (a == null || b == null) return false;
      return a < b;
    }
    case 'lte': {
      if (isDateColumn(col)) {
        const a = toEpochMs(raw);
        const b = toEpochMs(filter.value);
        if (a == null || b == null) return false;
        return a <= b;
      }
      const a = asNumber(raw);
      const b = asNumber(filter.value);
      if (a == null || b == null) return false;
      return a <= b;
    }

    // ---- explicit date operators (always epoch-compared) ----
    case 'after': {
      const a = toEpochMs(raw);
      const b = toEpochMs(filter.value);
      if (a == null || b == null) return false;
      return a > b;
    }
    case 'before': {
      const a = toEpochMs(raw);
      const b = toEpochMs(filter.value);
      if (a == null || b == null) return false;
      return a < b;
    }
    case 'on': {
      // Same calendar day (compare on the date portion only).
      const a = toEpochMs(raw);
      const b = toEpochMs(filter.value);
      if (a == null || b == null) return false;
      const da = new Date(a);
      const db = new Date(b);
      return (
        da.getFullYear() === db.getFullYear() &&
        da.getMonth() === db.getMonth() &&
        da.getDate() === db.getDate()
      );
    }
    case 'inLast': {
      const span = parseRelativeDuration(filter.value);
      if (span == null) return false;
      const a = toEpochMs(raw);
      if (a == null) return false;
      const now = Date.now();
      return a >= now - span && a <= now;
    }

    default:
      return true; // unknown op → don't filter
  }
}

/**
 * Recursively evaluate a {@link FilterGroup} against one entry.
 *   - `all`  → every child must match (logical AND). Empty group → true.
 *   - `any`  → at least one child must match (logical OR). Empty group → false.
 *
 * Leaves and nested groups are dispatched structurally. `columns` is the
 * resolved column set (so each leaf can look up its column kind once).
 */
export function matchesGroup(
  entry: IndexEntry,
  group: FilterGroup,
  columns: ColumnDef[],
): boolean {
  const children = group.children ?? [];
  if (group.combinator === 'any') {
    if (children.length === 0) return false;
    return children.some((child) =>
      isFilterGroup(child)
        ? matchesGroup(entry, child, columns)
        : matchFilter(entry, child, columns),
    );
  }
  // 'all' (default)
  return children.every((child) =>
    isFilterGroup(child)
      ? matchesGroup(entry, child, columns)
      : matchFilter(entry, child, columns),
  );
}

/**
 * Coerce arbitrary (possibly partial / external) input into a well-formed
 * {@link FilterGroup} tree. Accepts:
 *   - a flat `Filter[]` array       → `{ combinator:'all', children:[...] }`
 *   - an already-shaped group       → normalized recursively
 *   - a single leaf object          → wrapped in an `all` group
 *   - null/undefined/garbage        → empty `all` group
 *
 * Leaves accept either `column` or `key` for the field id (the latter is the
 * shape F5's `.solomd/views/*.yml` may use); output always uses `column`.
 * Always returns plain serializable objects.
 */
export function normalizeFilterGroup(raw: unknown): FilterGroup {
  const EMPTY: FilterGroup = { combinator: 'all', children: [] };

  // Flat array of leaves (the legacy Filter[] shape).
  if (Array.isArray(raw)) {
    return {
      combinator: 'all',
      children: raw.map(normalizeNode).filter((n): n is FilterNode => n != null),
    };
  }

  if (typeof raw !== 'object' || raw == null) return EMPTY;

  const obj = raw as Record<string, unknown>;

  // Group shape.
  if ('combinator' in obj || 'children' in obj) {
    const combinator: Combinator = obj.combinator === 'any' ? 'any' : 'all';
    const childrenRaw = Array.isArray(obj.children) ? obj.children : [];
    return {
      combinator,
      children: childrenRaw
        .map(normalizeNode)
        .filter((n): n is FilterNode => n != null),
    };
  }

  // Single leaf → wrap.
  const leaf = normalizeLeaf(obj);
  return leaf ? { combinator: 'all', children: [leaf] } : EMPTY;
}

function normalizeNode(raw: unknown): FilterNode | null {
  if (typeof raw !== 'object' || raw == null) return null;
  const obj = raw as Record<string, unknown>;
  if ('combinator' in obj || 'children' in obj) {
    return normalizeFilterGroup(obj);
  }
  return normalizeLeaf(obj);
}

function normalizeLeaf(obj: Record<string, unknown>): FilterLeaf | null {
  const column =
    typeof obj.column === 'string'
      ? obj.column
      : typeof obj.key === 'string'
        ? obj.key
        : undefined;
  if (!column) return null;
  const op = (obj.op as FilterOp) ?? 'contains';
  const leaf: FilterLeaf = { column, op };
  if ('value' in obj) leaf.value = obj.value;
  return leaf;
}

/** Convert a cell value or filter value to epoch ms, or null if not a date. */
function toEpochMs(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return null;
}

/**
 * Apply a flat AND-combined filter list. Back-compat entry point: a
 * `Filter[]` is treated as `{ combinator:'all', children:[...] }`. Thin
 * wrapper over {@link matchesGroup} so the flat and tree paths share one
 * evaluator. Signature is unchanged from v2.0.
 */
export function applyFilters(
  entries: IndexEntry[],
  filters: Filter[],
  columns?: ColumnDef[],
): IndexEntry[] {
  if (!filters || filters.length === 0) return entries;
  const cols = columns ?? inferColumns(entries);
  const group: FilterGroup = { combinator: 'all', children: filters };
  return entries.filter((e) => matchesGroup(e, group, cols));
}

/**
 * Apply a recursive {@link FilterGroup} tree (the v4.6 generalized path used
 * by saved filtered views). Accepts either a flat array or a tree via
 * {@link normalizeFilterGroup}, so callers can pass loosely-typed input.
 */
export function applyFilterGroup(
  entries: IndexEntry[],
  group: FilterGroup | Filter[] | unknown,
  columns?: ColumnDef[],
): IndexEntry[] {
  const tree = normalizeFilterGroup(group);
  if (tree.children.length === 0) return entries;
  const cols = columns ?? inferColumns(entries);
  return entries.filter((e) => matchesGroup(e, tree, cols));
}

// ---------- sorting ----------

function compareForSort(a: unknown, b: unknown, kind: ColumnKind): number {
  // Empty values sink to the bottom regardless of dir, so they don't pollute
  // the head of a sort. Caller can flip the result for desc.
  const aEmpty = isEmpty(a);
  const bEmpty = isEmpty(b);
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  if (kind === 'number') {
    const an = asNumber(a) ?? 0;
    const bn = asNumber(b) ?? 0;
    return an - bn;
  }
  if (kind === 'date') {
    const am = toEpochMs(a) ?? 0;
    const bm = toEpochMs(b) ?? 0;
    return am - bm;
  }
  if (kind === 'boolean') {
    const ab = a ? 1 : 0;
    const bb = b ? 1 : 0;
    return ab - bb;
  }
  return asString(a).localeCompare(asString(b));
}

/**
 * Stable sort by a single column. Returns a new array.
 * Empties always sink to the bottom (so descending name sort doesn't put
 * blank rows on top).
 */
export function applySort(
  entries: IndexEntry[],
  sort: SortSpec | null,
  columns?: ColumnDef[],
): IndexEntry[] {
  if (!sort) return entries;
  const cols = columns ?? inferColumns(entries);
  const col = cols.find((c) => c.id === sort.column);
  if (!col) return entries;
  const out = entries.slice();
  const sign = sort.dir === 'asc' ? 1 : -1;
  out.sort((a, b) => {
    const av = getRawValue(a, col);
    const bv = getRawValue(b, col);
    const cmp = compareForSort(av, bv, col.kind);
    // Empties always sink. compareForSort returns +1/-1 for emptiness; only
    // flip the dir for the real comparisons.
    const aEmpty = isEmpty(av);
    const bEmpty = isEmpty(bv);
    if (aEmpty || bEmpty) return cmp;
    return cmp * sign;
  });
  return out;
}

// ---------- saved views ----------

export const SAVED_VIEWS_KEY = 'solomd.basesViews.v1';

export function loadSavedViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(SAVED_VIEWS_KEY);
    if (!raw) return defaultViews();
    const parsed = JSON.parse(raw) as SavedView[];
    if (!Array.isArray(parsed)) return defaultViews();
    return parsed;
  } catch {
    return defaultViews();
  }
}

export function persistSavedViews(views: SavedView[]): void {
  try {
    localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views));
  } catch {
    /* localStorage full / disabled — silent */
  }
}

/**
 * The bundled defaults. "Tagged #project" is intentionally omitted unless
 * the workspace already uses that tag (it would otherwise always be empty
 * and confusing on first use). Callers that want the optional view should
 * conditionally extend this list.
 */
export function defaultViews(): SavedView[] {
  const sevenDaysAgoMs = Date.now() - 7 * 24 * 3600 * 1000;
  return [
    {
      name: 'All notes',
      columns: [],
      filters: [],
      sort: { column: 'mtime', dir: 'desc' },
    },
    {
      name: 'Modified this week',
      columns: [],
      filters: [{ column: 'mtime', op: '>', value: sevenDaysAgoMs }],
      sort: { column: 'mtime', dir: 'desc' },
    },
    // "Tagged #project" — uncomment / extend programmatically when the
    // workspace contains a `project` tag:
    // {
    //   name: 'Tagged #project',
    //   columns: [],
    //   filters: [{ column: 'tags', op: 'has-tag', value: 'project' }],
    //   sort: { column: 'mtime', dir: 'desc' },
    // },
  ];
}
