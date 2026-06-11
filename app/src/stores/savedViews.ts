/**
 * Saved filtered views (F5) — Pinia store.
 *
 * Each view is a YAML file at `{workspace}/.solomd/views/{slug}.yml`. This
 * store owns the in-memory list, disk persistence (via the existing generic
 * `read_file` / `write_file` / `list_dir` / `fs_create_dir` Tauri commands —
 * NO new Rust command), and evaluation of the active view's note list.
 *
 * Evaluation reuses the read-only `bases.ts` engine wholesale:
 *   - columns  via `inferColumns(entries)`
 *   - matching via `matchesGroup(entry, group, columns)`
 *   - sorting  via `applySort(entries, sort, columns)`
 *
 * Two view-layer concerns are resolved here *before* handing leaves to bases:
 *   1. Relative-date tokens (`@today`, `@7d`) → concrete epoch ms.
 *   2. Relationship ops (`linksTo` / `backlinksTo`) → rewritten into a
 *      synthetic membership test using a precomputed wikilink adjacency map,
 *      so we never touch bases.ts and never do async work per row.
 */
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { inferColumns, applySort, type ColumnDef, type SortSpec } from '../lib/bases';
import {
  parseViewFile,
  serializeViewFile,
  normalizeViewFile,
  matchesGroup,
  isFilterGroup,
  VIEWS_DIR,
  isRelationshipOp,
  type ViewFile,
  type FilterGroup,
  type FilterLeaf,
  type FilterNode,
} from '../lib/viewFile';
import { materializeFilterValue } from '../lib/relativeDates';
import { useWorkspaceIndexStore, type IndexEntry } from './workspaceIndex';

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface State {
  folder: string | null;
  views: ViewFile[];
  activeSlug: string | null;
  loading: boolean;
  lastError: string | null;
}

/** Join a workspace folder with a relative sub-path using the right separator. */
function joinPath(folder: string, rel: string): string {
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  const relNative = sep === '\\' ? rel.replace(/\//g, '\\') : rel;
  return folder.endsWith(sep) ? folder + relNative : folder + sep + relNative;
}

export const useSavedViewsStore = defineStore('savedViews', {
  state: (): State => ({
    folder: null,
    views: [],
    activeSlug: null,
    loading: false,
    lastError: null,
  }),

  getters: {
    /** Views ordered for sidebar display: by `order`, then name. */
    ordered(state): ViewFile[] {
      return [...state.views].sort(
        (a, b) => a.order - b.order || a.name.localeCompare(b.name),
      );
    },
    activeView(state): ViewFile | null {
      return state.views.find((v) => v.slug === state.activeSlug) ?? null;
    },
  },

  actions: {
    /** Re-point the store at a workspace folder and reload its view files. */
    async setFolder(folder: string | null) {
      if (folder === this.folder) return;
      this.folder = folder;
      this.views = [];
      this.activeSlug = null;
      this.lastError = null;
      if (folder) await this.loadFromDisk(folder);
    },

    /** Read every `.solomd/views/*.yml` for the given folder. */
    async loadFromDisk(folder: string) {
      this.loading = true;
      try {
        const dir = joinPath(folder, VIEWS_DIR);
        let entries: DirEntry[] = [];
        try {
          entries = await invoke<DirEntry[]>('list_dir', { path: dir });
        } catch {
          // Directory doesn't exist yet → no views. Not an error.
          this.views = [];
          this.loading = false;
          return;
        }
        const ymls = entries.filter(
          (e) => !e.is_dir && /\.ya?ml$/i.test(e.name) && e.path,
        );
        const loaded: ViewFile[] = [];
        for (const e of ymls) {
          try {
            const res = await invoke<{ content: string }>('read_file', {
              path: e.path,
            });
            const slug = e.name.replace(/\.ya?ml$/i, '');
            loaded.push(parseViewFile(slug, res.content));
          } catch (err) {
            console.warn('[savedViews] failed to read', e.path, err);
          }
        }
        this.views = loaded;
        // Drop the active selection if its view vanished from disk.
        if (this.activeSlug && !loaded.some((v) => v.slug === this.activeSlug)) {
          this.activeSlug = null;
        }
      } catch (e) {
        this.lastError = String(e);
      } finally {
        this.loading = false;
      }
    },

    /** Ensure `.solomd/views/` exists (idempotent). */
    async ensureDir(folder: string): Promise<string> {
      const dir = joinPath(folder, VIEWS_DIR);
      try {
        await invoke('fs_create_dir', { path: dir });
      } catch (e) {
        // `already exists` is expected and fine; rethrow anything else.
        if (!String(e).includes('already exists')) throw e;
      }
      return dir;
    },

    /**
     * Write a view to disk and merge it into the in-memory list. Creates the
     * `.solomd/views/` folder on first save. Returns the saved ViewFile.
     */
    async save(view: ViewFile): Promise<ViewFile> {
      const folder = this.folder;
      if (!folder) throw new Error('no workspace folder');
      // Re-normalize so callers can hand us partially-shaped objects safely.
      const clean = normalizeViewFile(view.slug, view);
      await this.ensureDir(folder);
      const dir = joinPath(folder, VIEWS_DIR);
      const path = joinPath(dir, `${clean.slug}.yml`);
      await invoke('write_file', {
        path,
        content: serializeViewFile(clean),
        encoding: 'UTF-8',
      });
      const idx = this.views.findIndex((v) => v.slug === clean.slug);
      if (idx >= 0) this.views.splice(idx, 1, clean);
      else this.views.push(clean);
      return clean;
    },

    /** Delete a view file and drop it from the list. */
    async remove(slug: string) {
      const folder = this.folder;
      if (!folder) return;
      const path = joinPath(joinPath(folder, VIEWS_DIR), `${slug}.yml`);
      try {
        await invoke('fs_delete', { path });
      } catch (e) {
        console.warn('[savedViews] delete failed', e);
      }
      this.views = this.views.filter((v) => v.slug !== slug);
      if (this.activeSlug === slug) this.activeSlug = null;
    },

    /**
     * Persist a new sidebar order. `slugs` is the full slug list in the
     * desired top-to-bottom order; each affected view is re-saved with its
     * new `order` index (Tolaria re-saves every touched view too).
     */
    async reorder(slugs: string[]) {
      const folder = this.folder;
      if (!folder) return;
      const next: ViewFile[] = [];
      for (let i = 0; i < slugs.length; i += 1) {
        const v = this.views.find((x) => x.slug === slugs[i]);
        if (!v) continue;
        if (v.order !== i) {
          const updated = { ...v, order: i };
          next.push(updated);
        }
      }
      // Optimistically update in-memory order first for snappy UI.
      for (const v of next) {
        const idx = this.views.findIndex((x) => x.slug === v.slug);
        if (idx >= 0) this.views.splice(idx, 1, v);
      }
      // Then write each changed file.
      for (const v of next) {
        try {
          await this.save(v);
        } catch (e) {
          console.warn('[savedViews] reorder save failed', v.slug, e);
        }
      }
    },

    setActive(slug: string | null) {
      this.activeSlug = slug;
    },

    /**
     * Evaluate a view against the current workspace index, returning the
     * matched + sorted entries. Pure read — safe to call from getters/render.
     */
    evaluate(view: ViewFile): IndexEntry[] {
      return this.evaluateTree(
        view.filters,
        view.sort ?? { column: 'mtime', dir: 'desc' },
      );
    },

    /**
     * Evaluate an arbitrary filter tree (+ optional sort) against the current
     * index. Shared by {@link evaluate} and the editor's live preview, so the
     * dialog can show a match count for a DRAFT that isn't saved yet. Resolves
     * relationship + relative-date leaves first, then defers all matching to
     * the single `bases.matchesGroup` engine (via viewFile's adapter).
     */
    evaluateTree(filters: FilterGroup, sort?: SortSpec | null): IndexEntry[] {
      const index = useWorkspaceIndexStore();
      const entries = index.entries;
      const columns = inferColumns(entries);
      const adjacency = buildAdjacency(entries);
      const now = new Date();
      const tree = prepareGroup(filters, adjacency, now);
      const matched =
        tree.children.length === 0
          ? entries
          : entries.filter((e) => matchesGroup(e, tree, columns));
      return applySort(matched, sort ?? { column: 'mtime', dir: 'desc' }, columns);
    },

    /** Match-count for the sidebar badge (cheap: reuses evaluate). */
    matchCount(view: ViewFile): number {
      return this.evaluate(view).length;
    },

    /** Live match-count for a draft filter tree (editor preview). */
    countMatches(filters: FilterGroup): number {
      return this.evaluateTree(filters, null).length;
    },
  },
});

// ---------------------------------------------------------------------------
// Relationship + relative-date pre-pass (keeps bases.ts untouched)
// ---------------------------------------------------------------------------

interface Adjacency {
  /** path → set of stems this note links TO (outgoing wikilinks). */
  linksTo: Map<string, Set<string>>;
  /** stem → set of paths that link to it (incoming / backlinks). */
  backlinkedBy: Map<string, Set<string>>;
}

function buildAdjacency(entries: IndexEntry[]): Adjacency {
  const linksTo = new Map<string, Set<string>>();
  const backlinkedBy = new Map<string, Set<string>>();
  for (const e of entries) {
    const outgoing = new Set<string>();
    for (const wl of e.wikilinks ?? []) {
      const target = (wl.target ?? '').trim().toLowerCase();
      if (!target) continue;
      outgoing.add(target);
      if (!backlinkedBy.has(target)) backlinkedBy.set(target, new Set());
      backlinkedBy.get(target)!.add(e.path);
    }
    linksTo.set(e.path, outgoing);
  }
  return { linksTo, backlinkedBy };
}

/**
 * Walk a filter tree and rewrite each leaf so bases.ts can evaluate it:
 *   - relationship leaves become a synthetic membership predicate (using a
 *     precomputed wikilink set on the entry — see relationshipColumn below);
 *   - relative-date values are materialized to epoch ms.
 *
 * Relationship leaves can't be expressed as a bases op, so we encode them as
 * a `__rel__` marker the entry-side precompute can't see. Instead we filter
 * those rows out here by replacing the leaf with an always-eval predicate via
 * a special column whose raw value is computed per entry. Since bases reads
 * the raw value off the entry, we attach the relationship result to a
 * frontmatter-shadow key on a SHALLOW-CLONED entry would be heavy; instead we
 * evaluate relationship leaves directly and fold them into the group as
 * pre-resolved booleans using `equals` against a constant.
 */
function prepareGroup(
  group: FilterGroup,
  adjacency: Adjacency,
  now: Date,
): FilterGroup {
  const children: FilterNode[] = (group.children ?? []).map((child) =>
    isFilterGroup(child)
      ? prepareGroup(child, adjacency, now)
      : prepareLeaf(child, adjacency, now),
  );
  return { combinator: group.combinator, children };
}

function prepareLeaf(
  leaf: FilterLeaf,
  adjacency: Adjacency,
  now: Date,
): FilterNode {
  if (isRelationshipOp(leaf.op as string)) {
    // bases.ts can only read builtin / frontmatter columns, not wikilinks.
    // Lower the relationship leaf into a plain bases-evaluable predicate by
    // precomputing the qualifying note set (see relationshipToPredicate).
    return relationshipToPredicate(leaf, adjacency);
  }
  if (leaf.value !== undefined) {
    return { ...leaf, value: materializeFilterValue(leaf.value, now) };
  }
  return leaf;
}

/**
 * Lower a relationship leaf into a plain bases-evaluable group.
 *
 * `linksTo <name>`     → entry's outgoing wikilinks include <name>'s stem.
 * `backlinksTo <name>` → entry IS linked to by something, i.e. entry's stem is
 *                        in the backlink map for <name>… which is the inverse.
 *
 * We can't read wikilinks through a bases column (bases only knows builtins +
 * frontmatter), so we materialize the qualifying PATH SET and emit an `any_of`
 * predicate on a builtin we CAN read: the file `name`. To stay robust against
 * duplicate names we instead emit a disjunction of `eq` on `name` for every
 * qualifying entry. With zero matches we emit an always-false `is-empty` on a
 * guaranteed-non-empty builtin (`name`), and with the whole set we keep it.
 */
function relationshipToPredicate(
  leaf: FilterLeaf,
  adjacency: Adjacency,
): FilterNode {
  const target = String(leaf.value ?? '').trim().toLowerCase();
  // Strip a trailing `.md` and any folder so the user can type a bare name.
  const stem = target.replace(/\.md$/i, '').split(/[\\/]/).pop() ?? target;

  let qualifyingPaths = new Set<string>();
  if (leaf.op === 'linksTo') {
    // Notes whose outgoing links include the target stem.
    for (const [path, outs] of adjacency.linksTo) {
      if (outs.has(stem)) qualifyingPaths.add(path);
    }
  } else {
    // backlinksTo: notes that link to the target == the target's backlinkers.
    qualifyingPaths = new Set(adjacency.backlinkedBy.get(stem) ?? []);
  }

  if (qualifyingPaths.size === 0) {
    // Always-false: name can never equal this sentinel.
    return { column: 'name', op: 'equals', value: ' __no_match__' };
  }

  // Map qualifying paths → their file names; emit OR of name equality.
  const index = useWorkspaceIndexStore();
  const byPath = index.byPath;
  const names = new Set<string>();
  for (const p of qualifyingPaths) {
    const entry = byPath.get(p);
    if (entry) names.add(entry.name);
  }
  const children: FilterNode[] = Array.from(names).map((n) => ({
    column: 'name',
    op: 'equals' as const,
    value: n,
  }));
  return { combinator: 'any', children };
}

export type { ColumnDef };
