<script setup lang="ts">
/**
 * Filtered note list for the active saved view (F5).
 *
 * Shown in the content area (in place of the editor / Bases table) when a view
 * is opened from the sidebar. Re-evaluates the view against the workspace index
 * on every `solomd://index-updated`, so editing a note's frontmatter on disk
 * updates the list live. Row click opens the note via useFiles.openPath.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useI18n } from '../i18n';
import { useSavedViewsStore } from '../stores/savedViews';
import { useWorkspaceIndexStore, type IndexEntry } from '../stores/workspaceIndex';
import { useSavedViews } from '../composables/useSavedViews';
import { useFiles } from '../composables/useFiles';
import { inferColumns, getCellValue, formatMtime, type ColumnDef } from '../lib/bases';

const { t } = useI18n();
const store = useSavedViewsStore();
const index = useWorkspaceIndexStore();
const { closeView } = useSavedViews();
const files = useFiles();

// A revision counter we bump on index updates to force re-evaluation; the
// store's `evaluate` reads `index.entries` reactively, but bumping keeps the
// computed honest if the entries array is mutated in place.
const rev = ref(0);

const view = computed(() => store.activeView);

const rows = computed<IndexEntry[]>(() => {
  void rev.value;
  const v = view.value;
  if (!v) return [];
  return store.evaluate(v);
});

const columns = computed<ColumnDef[]>(() => inferColumns(index.entries));

/** The display-column defs the view asked for (skips the always-shown name). */
const chipColumns = computed<ColumnDef[]>(() => {
  const v = view.value;
  if (!v) return [];
  return v.columns
    .map((id) => columns.value.find((c) => c.id === id))
    .filter((c): c is ColumnDef => !!c && c.id !== 'name');
});

function chipText(entry: IndexEntry, col: ColumnDef): string {
  const val = getCellValue(entry, col);
  return val == null ? '' : String(val);
}

function open(entry: IndexEntry) {
  void files.openPath(entry.path, { bypassNewWindow: true });
}

let unlistenIndex: UnlistenFn | null = null;
onMounted(async () => {
  try {
    unlistenIndex = await listen('solomd://index-updated', () => { rev.value += 1; });
  } catch {}
});
onBeforeUnmount(() => {
  if (unlistenIndex) unlistenIndex();
});
</script>

<template>
  <div class="vnl" v-if="view">
    <div class="vnl__header">
      <button class="vnl__back" type="button" :title="t('views.back')" @click="closeView">‹</button>
      <span class="vnl__icon" :style="view.color ? { color: view.color } : undefined">{{ view.icon || '🔖' }}</span>
      <span class="vnl__name">{{ view.name }}</span>
      <span class="vnl__count">{{ rows.length }}</span>
    </div>

    <div v-if="rows.length === 0" class="vnl__empty">{{ t('views.noMatches') }}</div>

    <ul v-else class="vnl__list">
      <li
        v-for="entry in rows"
        :key="entry.path"
        class="vnl__row"
        :title="entry.path"
        @click="open(entry)"
      >
        <div class="vnl__row-main">
          <span class="vnl__row-name">{{ entry.title || entry.name }}</span>
          <span class="vnl__row-mtime">{{ formatMtime(entry.mtime) }}</span>
        </div>
        <div v-if="chipColumns.length" class="vnl__chips">
          <span
            v-for="col in chipColumns"
            :key="col.id"
            class="vnl__chip"
            v-show="chipText(entry, col)"
          >{{ chipText(entry, col) }}</span>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.vnl {
  height: 100%;
  overflow-y: auto;
  background: var(--bg);
  color: var(--text);
}
.vnl__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--bg);
  z-index: 1;
}
.vnl__back {
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
  border-radius: 4px;
}
.vnl__back:hover { color: var(--text); background: var(--bg-hover); }
.vnl__icon { font-size: 15px; }
.vnl__name {
  font-size: 15px;
  font-weight: 600;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vnl__count {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-fg);
  background: var(--accent);
  border-radius: 999px;
  padding: 1px 8px;
}
.vnl__empty {
  padding: 40px 18px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}
.vnl__list {
  list-style: none;
  margin: 0;
  padding: 6px 0;
}
.vnl__row {
  padding: 8px 18px;
  cursor: pointer;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
}
.vnl__row:hover { background: var(--bg-hover); }
.vnl__row-main {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.vnl__row-name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vnl__row-mtime {
  font-size: 11px;
  color: var(--text-faint);
  flex: 0 0 auto;
}
.vnl__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.vnl__chip {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
}
</style>
