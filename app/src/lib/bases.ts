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

export type FilterOp =
  | 'contains'
  | 'equals'
  | 'starts-with'
  | '>'
  | '<'
  | 'is-empty'
  | 'has-tag';

export interface Filter {
  /** Column id this filter applies to. */
  column: string;
  op: FilterOp;
  /** Value to compare against. Type depends on op. */
  value: unknown;
}

export interface SortSpec {
  column: string;
  dir: 'asc' | 'desc';
}

export interface SavedView {
  name: string;
  /** Column ids in display order. Empty array means "auto" (all inferred). */
  columns: string[];
  filters: Filter[];
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

function matchFilter(
  entry: IndexEntry,
  filter: Filter,
  columns: ColumnDef[],
): boolean {
  const col = columns.find((c) => c.id === filter.column);
  if (!col) return true; // unknown column → don't filter
  const raw = getRawValue(entry, col);

  switch (filter.op) {
    case 'is-empty':
      return isEmpty(raw);
    case 'contains': {
      const needle = String(filter.value ?? '').toLowerCase();
      if (!needle) return true;
      return asString(raw).toLowerCase().includes(needle);
    }
    case 'starts-with': {
      const needle = String(filter.value ?? '').toLowerCase();
      if (!needle) return true;
      return asString(raw).toLowerCase().startsWith(needle);
    }
    case 'equals': {
      const want = filter.value;
      if (Array.isArray(raw)) return raw.some((x) => String(x) === String(want));
      return String(raw ?? '') === String(want ?? '');
    }
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
    case '>': {
      // Date or number depending on column kind.
      if (col.kind === 'date' || (col.source === 'builtin' && col.id === 'mtime')) {
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
    case '<': {
      if (col.kind === 'date' || (col.source === 'builtin' && col.id === 'mtime')) {
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
  }
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
 * Apply all filters (AND-combined). The caller passes columns so we can look
 * up each filter's column kind once.
 */
export function applyFilters(
  entries: IndexEntry[],
  filters: Filter[],
  columns?: ColumnDef[],
): IndexEntry[] {
  if (filters.length === 0) return entries;
  const cols = columns ?? inferColumns(entries);
  return entries.filter((e) => filters.every((f) => matchFilter(e, f, cols)));
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
