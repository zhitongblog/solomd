/**
 * v4.6 F1 — Properties inspector: display-mode inference.
 *
 * Markdown-first: the YAML frontmatter block is the only source of truth. We
 * never write a property's "type" into the note. Instead the inspector infers
 * a *display mode* at render time, reusing the column-kind inference from
 * `lib/bases.ts` (`isIsoDate`/`ColumnKind`) so the table view and the
 * inspector agree on what each value is. A small layer of key/value heuristics
 * on top of the bases `ColumnKind` adds the inspector-only modes
 * (status / url / boolean / relation) that the Bases table doesn't need.
 *
 * User overrides of the inferred mode persist OUTSIDE notes in
 * `.solomd/properties.json` (see stores/properties.ts) — `getEffectiveMode`
 * = override ?? inferred.
 *
 * NOTE: `lib/bases.ts` is read-only for this feature; we import its inference
 * rather than re-porting it.
 */
import { isIsoDate } from './bases';

/**
 * The inspector's display modes. A superset of Bases `ColumnKind`, mapping:
 *   text → text, number → number, date → date, array → tags, boolean →
 *   boolean. Plus inspector-only: status, url, relation.
 */
export type DisplayMode =
  | 'text'
  | 'number'
  | 'date'
  | 'boolean'
  | 'status'
  | 'url'
  | 'tags'
  | 'relation';

export const DISPLAY_MODES: DisplayMode[] = [
  'text',
  'number',
  'date',
  'boolean',
  'status',
  'url',
  'tags',
  'relation',
];

/** Keys whose values are conventionally a multi-value tag list. */
const TAG_KEY_RE = /^(tags|keywords|categories|category|labels|aliases)$/i;
/** Keys that conventionally carry a workflow status. */
const STATUS_KEY_RE = /\b(status|state|stage|phase)\b/i;
/** Keys that conventionally carry a date. */
const DATE_KEY_RE = /\b(date|deadline|due|created|modified|updated|published|start|end|when)\b/i;
/** Keys that conventionally carry a URL / link. */
const URL_KEY_RE = /\b(url|link|website|homepage|source|href)\b/i;
/** Keys that conventionally point at another note (relationship). */
const RELATION_KEY_RE = /\b(related|parent|child|children|links|refs|see|author|project|up|down)\b/i;

/** Common workflow status vocabulary used as a weak value-side signal. */
const STATUS_VALUES = new Set(
  [
    'todo',
    'to-do',
    'doing',
    'in-progress',
    'in progress',
    'wip',
    'blocked',
    'review',
    'in-review',
    'done',
    'complete',
    'completed',
    'draft',
    'published',
    'archived',
    'backlog',
    'cancelled',
    'canceled',
    'open',
    'closed',
    'active',
    'inactive',
    'pending',
    'planned',
  ].map((s) => s.toLowerCase()),
);

const URL_VALUE_RE = /^(https?:\/\/|mailto:|ftp:\/\/|www\.)/i;
const WIKILINK_RE = /\[\[[^\[\]\n]+?\]\]/;

/** True when a string value contains at least one `[[wikilink]]`. */
export function hasWikilink(v: unknown): boolean {
  if (typeof v === 'string') return WIKILINK_RE.test(v);
  if (Array.isArray(v)) return v.some((x) => typeof x === 'string' && WIKILINK_RE.test(x));
  return false;
}

/**
 * Infer the display mode for a single (key, value) pair.
 *
 * Strategy (mirrors Tolaria's `detectPropertyType`):
 *   1. JS value type first (array → tags, boolean → boolean, number →
 *      number) — most reliable.
 *   2. Wikilink-bearing string → relation.
 *   3. Key-pattern + value heuristics (status / date / url / tags).
 *   4. ISO date string → date.
 *   5. Numeric string → number.
 *   6. Fallback → text.
 */
export function inferDisplayMode(key: string, value: unknown): DisplayMode {
  // 1. Hard JS types.
  if (Array.isArray(value)) {
    if (hasWikilink(value)) return 'relation';
    return 'tags';
  }
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';

  const sval = typeof value === 'string' ? value.trim() : '';

  // 2. Wikilink → relation.
  if (hasWikilink(sval)) return 'relation';

  // 3a. Key says relation and the value isn't obviously something else.
  if (RELATION_KEY_RE.test(key) && hasWikilink(sval)) return 'relation';

  // 3b. URL.
  if (URL_VALUE_RE.test(sval)) return 'url';
  if (URL_KEY_RE.test(key) && sval !== '') return 'url';

  // 3c. Tags key.
  if (TAG_KEY_RE.test(key)) return 'tags';

  // 3d. Status — key pattern OR a known status vocabulary value.
  if (STATUS_KEY_RE.test(key)) return 'status';
  if (sval !== '' && STATUS_VALUES.has(sval.toLowerCase())) return 'status';

  // 3e. Date — key pattern + ISO-ish value, or any ISO date value.
  if (isIsoDate(sval)) return 'date';
  if (DATE_KEY_RE.test(key) && sval !== '' && !isNaN(Date.parse(sval))) return 'date';

  // 5. Numeric string.
  if (sval !== '' && !isNaN(Number(sval))) return 'number';

  // 6. Fallback.
  return 'text';
}

/** Humanized label for a display mode (English; i18n keys live in en.ts). */
export const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  boolean: 'Checkbox',
  status: 'Status',
  url: 'URL',
  tags: 'Tags',
  relation: 'Relation',
};

/**
 * Coerce a raw frontmatter value into the JS shape a given mode's cell editor
 * expects, used when re-casting a property to a different display mode so the
 * value we persist matches the new mode.
 */
export function coerceForMode(mode: DisplayMode, value: unknown): unknown {
  switch (mode) {
    case 'number': {
      if (typeof value === 'number') return value;
      const n = Number(typeof value === 'string' ? value.trim() : value);
      return Number.isFinite(n) ? n : 0;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value ?? '').trim().toLowerCase();
      return s === 'true' || s === 'yes' || s === '1' || s === 'on';
    }
    case 'tags':
    case 'relation': {
      if (Array.isArray(value)) return value;
      if (value == null || value === '') return [];
      return String(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    case 'text':
    case 'status':
    case 'url':
    case 'date':
    default: {
      if (Array.isArray(value)) return value.join(', ');
      if (value == null) return '';
      return typeof value === 'string' ? value : String(value);
    }
  }
}
