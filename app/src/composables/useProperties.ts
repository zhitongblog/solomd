/**
 * v4.6 F1 — Properties inspector: read + write orchestration.
 *
 * READ: the active note's parsed frontmatter comes straight from the existing
 * workspace index (`IndexEntry.frontmatter`) — we never re-parse YAML on the JS
 * side. When the active tab has no index entry yet (e.g. a brand-new file not
 * scanned), we fall back to an empty map.
 *
 * WRITE: edits are optimistic and go through the Rust round-trip command
 * (`update_frontmatter_property` / `delete_frontmatter_property`) which owns
 * YAML serialization so the body stays byte-identical and key order is
 * preserved. The command writes to disk AND returns the rewritten file content;
 * we push that content into the open tab (content + savedContent) so the editor
 * reflows for free and the tab is NOT left falsely dirty. A toast confirms.
 *
 * The inspector is gated on the active tab being a real, on-disk markdown file:
 * we refuse to write to an Untitled (unsaved) tab because the Rust command
 * works against a path on disk.
 */
import { computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

export interface PropertyEntry {
  key: string;
  value: unknown;
}

export function useProperties() {
  const tabs = useTabsStore();
  const idx = useWorkspaceIndexStore();
  const toasts = useToastsStore();
  const { t } = useI18n();

  /** Absolute path of the active tab's on-disk file, or null. */
  const activePath = computed<string | null>(() => tabs.activeTab?.filePath ?? null);

  /** True when the inspector can read/write the active document. */
  const ready = computed<boolean>(
    () => !!activePath.value && tabs.activeTab?.language === 'markdown',
  );

  /**
   * The active note's parsed frontmatter as an ordered list of entries.
   * Sourced from the workspace index (single source of truth) so the
   * inspector and the table view never disagree.
   */
  const entries = computed<PropertyEntry[]>(() => {
    const p = activePath.value;
    if (!p) return [];
    const entry = idx.byPath.get(p);
    const fm = entry?.frontmatter;
    if (!fm || typeof fm !== 'object') return [];
    return Object.entries(fm as Record<string, unknown>).map(([key, value]) => ({
      key,
      value,
    }));
  });

  /** Lookup a single property's current value (undefined when absent). */
  function valueOf(key: string): unknown {
    return entries.value.find((e) => e.key === key)?.value;
  }

  /** True when the note already declares `key`. */
  function has(key: string): boolean {
    return entries.value.some((e) => e.key === key);
  }

  /**
   * Apply a rewritten file (returned by the Rust command) into the open tab so
   * the editor reflows and the tab is marked clean (it was just written to
   * disk). After the write the index will refresh off `solomd://index-updated`.
   */
  function applyRewritten(next: string) {
    const id = tabs.activeId;
    if (!id) return;
    tabs.applyExternalSave(id, next);
  }

  /** Insert or update a single frontmatter property. */
  async function update(key: string, value: unknown): Promise<boolean> {
    const path = activePath.value;
    if (!path) {
      toasts.warning(t('properties.saveFirst'));
      return false;
    }
    if (!key.trim()) {
      toasts.warning(t('properties.emptyKey'));
      return false;
    }
    try {
      const next = await invoke<string>('update_frontmatter_property', {
        path,
        key,
        value,
      });
      applyRewritten(next);
      // Refresh the index so vault-wide autocomplete + the inspector's own
      // read view pick up the change without waiting for the fs watcher.
      idx.refresh().catch(() => {});
      return true;
    } catch (e) {
      toasts.warning(t('properties.writeFailed', { error: String(e) }));
      return false;
    }
  }

  /** Delete a single frontmatter property. */
  async function remove(key: string): Promise<boolean> {
    const path = activePath.value;
    if (!path) {
      toasts.warning(t('properties.saveFirst'));
      return false;
    }
    try {
      const next = await invoke<string>('delete_frontmatter_property', {
        path,
        key,
      });
      applyRewritten(next);
      idx.refresh().catch(() => {});
      return true;
    } catch (e) {
      toasts.warning(t('properties.writeFailed', { error: String(e) }));
      return false;
    }
  }

  return { activePath, ready, entries, valueOf, has, update, remove };
}
