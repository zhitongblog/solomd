/**
 * F2 — Type registry derivation (pure functions).
 *
 * SoloMD mirrors Tolaria's "types-as-lenses" model entirely in Markdown
 * frontmatter, so vaults stay cross-compatible. Two note roles, both ordinary
 * Markdown files:
 *
 *   1. TYPE-MEMBER — any note whose frontmatter has `type: <Name>` (aliases
 *      `is_a` / `Is A`, like Tolaria's Rust side). Membership is that one field.
 *   2. TYPE-DEFINITION — a note whose own `type` is literally `Type` and whose
 *      title (H1-or-stem) names the type. It carries presentation keys:
 *        icon, color, order, sidebar_label, pinned, template, visible
 *      (underscore-prefixed aliases `_icon`/`_color`/… accepted for Tolaria
 *      parity).
 *
 * These functions are intentionally framework-free (no Pinia / no DOM) so they
 * can be unit-tested under node — see /tmp/tolaria/checks/types-*.mjs. The
 * store (stores/types.ts) is a thin reactive wrapper over them.
 */

/** Minimal shape we need from a workspace IndexEntry (keeps this lib decoupled). */
export interface TypeIndexEntry {
  path: string;
  stem: string;
  title?: string | null;
  frontmatter: Record<string, unknown> | null;
}

/** Accent color keys SoloMD supports (map to --accent-* in the panel CSS). */
export type TypeColorKey =
  | 'orange'
  | 'red'
  | 'purple'
  | 'blue'
  | 'green'
  | 'yellow';

export const TYPE_COLORS: TypeColorKey[] = [
  'orange',
  'red',
  'purple',
  'blue',
  'green',
  'yellow',
];

/** Resolved presentation for one type definition note. */
export interface TypeDef {
  /** Canonical type name (the definition note's title-or-stem). */
  name: string;
  /** Path of the definition note on disk (null for a built-in fallback). */
  defPath: string | null;
  icon: string | null;
  color: TypeColorKey | null;
  order: number | null;
  sidebarLabel: string | null;
  /** Property keys to surface as chips on member rows. */
  pinned: string[];
  /** Markdown prefill for new notes of this type. */
  template: string | null;
  /** Whether the section is shown (default true). */
  visible: boolean;
}

/** A member note belonging to a type. */
export interface TypeMember {
  path: string;
  stem: string;
  title: string;
  frontmatter: Record<string, unknown>;
}

/** A fully-resolved sidebar section: a type + its members + label/icon/color. */
export interface TypeSection {
  /** Canonical (case-preserving) type name. */
  name: string;
  /** Display label (sidebarLabel || pluralized name). */
  label: string;
  icon: string;
  color: TypeColorKey;
  order: number;
  pinned: string[];
  /** Path of the definition note, if one exists (for customize/open). */
  defPath: string | null;
  members: TypeMember[];
}

/**
 * Built-in defaults so common types look good with zero config (Tolaria
 * parity with its BUILT_IN_SECTION_GROUPS fallback). Keyed by lowercase name.
 */
export const BUILT_IN_TYPES: Record<
  string,
  { icon: string; color: TypeColorKey; order: number }
> = {
  project: { icon: 'type-project', color: 'blue', order: 10 },
  person: { icon: 'type-person', color: 'purple', order: 20 },
  meeting: { icon: 'type-meeting', color: 'green', order: 30 },
  idea: { icon: 'type-idea', color: 'yellow', order: 40 },
  book: { icon: 'type-book', color: 'orange', order: 50 },
};

/** Fallback icon when neither a def-note icon nor a built-in is available. */
export const DEFAULT_TYPE_ICON = 'type-generic';

// ---------------------------------------------------------------------------
// frontmatter reading helpers (alias-tolerant)
// ---------------------------------------------------------------------------

/** First non-null value among the given frontmatter keys. */
function pick(fm: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (fm[k] != null && fm[k] !== '') return fm[k];
  }
  return undefined;
}

function asStr(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  return String(v);
}

function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asStrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    // Allow a comma-separated string as a convenience.
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** The note's membership type name, reading Tolaria aliases. Null if none. */
export function memberTypeOf(
  fm: Record<string, unknown> | null,
): string | null {
  if (!fm) return null;
  const v = pick(fm, 'type', 'is_a', 'Is A', 'isA');
  const s = asStr(v);
  if (!s) return null;
  // `type: Type` marks a DEFINITION note, not a member of a "Type" type.
  if (s === 'Type') return null;
  return s;
}

/** True when this note is a TYPE-DEFINITION note (`type: Type`). */
export function isTypeDefinition(
  fm: Record<string, unknown> | null,
): boolean {
  if (!fm) return false;
  return asStr(pick(fm, 'type', 'is_a', 'Is A', 'isA')) === 'Type';
}

/** Resolve a usable display title for an entry (H1-or-stem). */
export function entryTitle(e: TypeIndexEntry): string {
  return (e.title && e.title.trim()) || e.stem;
}

/** Parse a definition note's frontmatter into a TypeDef. */
export function parseTypeDef(e: TypeIndexEntry): TypeDef {
  const fm = e.frontmatter ?? {};
  const name = entryTitle(e);
  const colorRaw = asStr(pick(fm, 'color', '_color'));
  const color =
    colorRaw && (TYPE_COLORS as string[]).includes(colorRaw)
      ? (colorRaw as TypeColorKey)
      : null;
  const visibleRaw = pick(fm, 'visible', '_visible');
  return {
    name,
    defPath: e.path,
    icon: asStr(pick(fm, 'icon', '_icon')),
    color,
    order: asNum(pick(fm, 'order', '_order')),
    sidebarLabel: asStr(pick(fm, 'sidebar_label', '_sidebar_label')),
    pinned: asStrArray(pick(fm, 'pinned', '_pinned_properties', '_list_properties_display')),
    template: asStr(pick(fm, 'template', '_template')),
    visible: visibleRaw === false ? false : true,
  };
}

// ---------------------------------------------------------------------------
// pluralization (small, English-only; sidebar_label overrides it anyway)
// ---------------------------------------------------------------------------

export function pluralize(word: string): string {
  if (!word) return word;
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, 'ies');
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

// ---------------------------------------------------------------------------
// registry + section derivation
// ---------------------------------------------------------------------------

export interface TypeRegistry {
  /** Resolved definitions keyed by lowercase type name. */
  defs: Map<string, TypeDef>;
  /** Members keyed by lowercase type name. */
  members: Map<string, TypeMember[]>;
}

/**
 * Scan all entries once, collecting type-definition notes and member notes.
 * Both maps are keyed on the lowercase type name so member `type:` casing can
 * differ from the definition note's title (Tolaria does the same).
 */
export function buildRegistry(entries: TypeIndexEntry[]): TypeRegistry {
  const defs = new Map<string, TypeDef>();
  const members = new Map<string, TypeMember[]>();

  for (const e of entries) {
    const fm = e.frontmatter ?? {};
    if (isTypeDefinition(fm)) {
      const def = parseTypeDef(e);
      // First definition wins; later duplicates are ignored deterministically
      // (entries arrive in index order).
      const key = def.name.toLowerCase();
      if (!defs.has(key)) defs.set(key, def);
      continue;
    }
    const typeName = memberTypeOf(fm);
    if (typeName) {
      const key = typeName.toLowerCase();
      const arr = members.get(key) ?? [];
      arr.push({
        path: e.path,
        stem: e.stem,
        title: entryTitle(e),
        frontmatter: fm,
      });
      members.set(key, arr);
    }
  }
  return { defs, members };
}

/** Resolve icon: explicit def icon → built-in → generic fallback. */
function resolveIcon(def: TypeDef | undefined, key: string): string {
  if (def?.icon) return def.icon;
  return BUILT_IN_TYPES[key]?.icon ?? DEFAULT_TYPE_ICON;
}

function resolveColor(def: TypeDef | undefined, key: string): TypeColorKey {
  if (def?.color) return def.color;
  return BUILT_IN_TYPES[key]?.color ?? 'orange';
}

function resolveOrder(def: TypeDef | undefined, key: string): number {
  if (def?.order != null) return def.order;
  return BUILT_IN_TYPES[key]?.order ?? 1000;
}

/**
 * Build the ordered list of sidebar sections from a registry.
 *
 * A section appears when EITHER a definition note exists (even with 0 members,
 * Tolaria parity) OR at least one member note references the type. Hidden
 * definitions (`visible: false`) are dropped. Sorted by order then alpha.
 */
export function buildSections(reg: TypeRegistry): TypeSection[] {
  const keys = new Set<string>([...reg.defs.keys(), ...reg.members.keys()]);
  const sections: TypeSection[] = [];

  for (const key of keys) {
    const def = reg.defs.get(key);
    if (def && def.visible === false) continue;

    const members = (reg.members.get(key) ?? [])
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title));

    // Canonical name: prefer the definition note's title; else the casing of
    // the first member's `type:` value; else the lowercase key.
    let name = def?.name;
    if (!name) {
      const first = members[0];
      name =
        (first && memberTypeOf(first.frontmatter)) || key;
    }

    const label =
      def?.sidebarLabel || pluralize(name);

    sections.push({
      name,
      label,
      icon: resolveIcon(def, key),
      color: resolveColor(def, key),
      order: resolveOrder(def, key),
      pinned: def?.pinned ?? [],
      defPath: def?.defPath ?? null,
      members,
    });
  }

  sections.sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name),
  );
  return sections;
}

/**
 * Union of all property keys present across a set of member notes — used to
 * populate the "pinned properties" multiselect in the customize popover.
 * Excludes the membership key itself and underscore-prefixed app keys.
 */
export function memberPropertyKeys(members: TypeMember[]): string[] {
  const seen = new Set<string>();
  const skip = new Set(['type', 'is_a', 'Is A', 'isA']);
  for (const m of members) {
    for (const k of Object.keys(m.frontmatter)) {
      if (skip.has(k) || k.startsWith('_')) continue;
      seen.add(k);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}
