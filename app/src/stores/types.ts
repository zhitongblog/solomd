/**
 * F2 — Type registry store (types-as-lenses).
 *
 * A thin reactive Pinia wrapper over the pure derivation functions in
 * `lib/types-registry.ts`. It reads the already-cached workspace index
 * (`useWorkspaceIndexStore().entries`) and exposes:
 *
 *   - `sections`     — ordered TypeSection[] driving the sidebar panel
 *   - `typeDefs`     — resolved TypeDef[] (every definition note)
 *   - `membersOf()`  — the member notes of one type (lowercase-keyed)
 *   - `propertyKeysOf()` — union of member frontmatter keys (for the
 *                      pinned-properties multiselect in the customize popover)
 *
 * Write actions go through the existing `read_file` + `write_file` Tauri
 * commands and the frontmatter splice helpers in `lib/frontmatter.ts`, so we
 * never re-serialize a whole document or touch off-limits stores. The Rust
 * file-watcher emits `solomd://index-updated` after each write, which the
 * workspace-index store listens to — so the sidebar refreshes for free.
 */
import { defineStore } from 'pinia';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceIndexStore, type IndexEntry } from './workspaceIndex';
import {
  buildRegistry,
  buildSections,
  memberPropertyKeys,
  parseTypeDef,
  isTypeDefinition,
  type TypeIndexEntry,
  type TypeSection,
  type TypeDef,
  type TypeMember,
  type TypeColorKey,
} from '../lib/types-registry';
import { patchFrontmatter } from '../lib/frontmatter';

/** Narrow a full IndexEntry to the minimal shape the registry needs. */
function toTypeEntry(e: IndexEntry): TypeIndexEntry {
  return {
    path: e.path,
    stem: e.stem,
    title: e.title ?? null,
    frontmatter: e.frontmatter,
  };
}

/** Patch a single note's frontmatter on disk, preserving its body bytes. */
async function patchNoteFrontmatter(
  path: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const result = await invoke<{ content: string; encoding?: string }>(
    'read_file',
    { path },
  );
  const next = patchFrontmatter(result.content, patch);
  await invoke('write_file', {
    path,
    content: next,
    encoding: result.encoding || 'UTF-8',
  });
}

export const useTypesStore = defineStore('types', {
  getters: {
    /** Ordered sidebar sections derived from the live workspace index. */
    sections(): TypeSection[] {
      const idx = useWorkspaceIndexStore();
      const entries = idx.entries.map(toTypeEntry);
      return buildSections(buildRegistry(entries));
    },

    /** Every resolved type-definition note in the vault. */
    typeDefs(): TypeDef[] {
      const idx = useWorkspaceIndexStore();
      const defs: TypeDef[] = [];
      for (const e of idx.entries) {
        if (isTypeDefinition(e.frontmatter)) defs.push(parseTypeDef(toTypeEntry(e)));
      }
      return defs;
    },

    /** True once the underlying index is ready for the current folder. */
    ready(): boolean {
      return useWorkspaceIndexStore().ready;
    },

    /** True when a workspace folder is open. */
    hasFolder(): boolean {
      return useWorkspaceIndexStore().folder !== null;
    },
  },

  actions: {
    /** Members of a type by (case-insensitive) name. */
    membersOf(name: string): TypeMember[] {
      const target = name.toLowerCase();
      const sec = this.sections.find((s) => s.name.toLowerCase() === target);
      return sec ? sec.members : [];
    },

    /** The resolved section for a type name, if present. */
    sectionOf(name: string): TypeSection | undefined {
      const target = name.toLowerCase();
      return this.sections.find((s) => s.name.toLowerCase() === target);
    },

    /**
     * Union of frontmatter property keys across a type's members — used to
     * populate the pinned-properties picker in the customize popover.
     */
    propertyKeysOf(name: string): string[] {
      return memberPropertyKeys(this.membersOf(name));
    },

    /**
     * Create a new type-definition note at `Types/<Name>.md` carrying
     * `type: Type`. Returns the created path. No-op (returns the existing
     * path) if a definition for this type already exists.
     */
    async createType(name: string): Promise<string> {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Type name is required');

      const existing = this.typeDefs.find(
        (d) => d.name.toLowerCase() === trimmed.toLowerCase(),
      );
      if (existing && existing.defPath) return existing.defPath;

      const idx = useWorkspaceIndexStore();
      const folder = idx.folder;
      if (!folder) throw new Error('No workspace folder open');

      // Sanitise to a safe filename; keep the display name in the H1.
      const safe = trimmed.replace(/[\\/:*?"<>|]/g, '-');
      const sep = folder.includes('\\') ? '\\' : '/';
      const path = `${folder}${sep}Types${sep}${safe}.md`;

      const body =
        `---\ntype: Type\n---\n\n# ${trimmed}\n\n` +
        `Notes with \`type: ${trimmed}\` in their frontmatter appear in this ` +
        `type's sidebar section.\n`;
      await invoke('write_file', { path, content: body, encoding: 'UTF-8' });
      await idx.rescan();
      return path;
    },

    /**
     * Patch a type-definition note's presentation keys (icon/color/order/
     * sidebar_label/pinned/template/visible). Keys set to `undefined` are
     * removed. Body bytes are preserved. Creates the def note first if the
     * type has none yet.
     */
    async patchTypeDef(
      name: string,
      patch: {
        icon?: string | undefined;
        color?: TypeColorKey | undefined;
        order?: number | undefined;
        sidebar_label?: string | undefined;
        pinned?: string[] | undefined;
        template?: string | undefined;
        visible?: boolean | undefined;
      },
    ): Promise<void> {
      const idx = useWorkspaceIndexStore();
      let defPath = this.typeDefs.find(
        (d) => d.name.toLowerCase() === name.toLowerCase(),
      )?.defPath;
      if (!defPath) {
        defPath = await this.createType(name);
      }
      await patchNoteFrontmatter(defPath, patch as Record<string, unknown>);
      await idx.rescan();
    },

    /**
     * Assign (or replace) a member note's `type:` field. Splices only the
     * single key, leaving all other frontmatter + body untouched. Pass
     * `null` to remove the type membership.
     */
    async setMemberType(path: string, name: string | null): Promise<void> {
      const idx = useWorkspaceIndexStore();
      await patchNoteFrontmatter(path, {
        type: name == null || name === '' ? undefined : name,
      });
      await idx.rescan();
    },
  },
});
