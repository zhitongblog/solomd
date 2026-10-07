<script setup lang="ts">
/**
 * Filtered note list for the active saved view (F5).
 *
 * Shown in the content area (in place of the editor / Bases table) when a view
 * is opened from the sidebar. Re-evaluates the view against the workspace index
 * on every `solomd://index-updated`, so editing a note's frontmatter on disk
 * updates the list live. Row click opens the note via useFiles.openPath.
 *
 * Rows + chips use the design-system DsListRow / DsChip primitives.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useI18n } from '../i18n';
import { useSavedViewsStore } from '../stores/savedViews';
import { useWorkspaceIndexStore, type IndexEntry } from '../stores/workspaceIndex';
import { useSavedViews } from '../composables/useSavedViews';
import { useFiles } from '../composables/useFiles';
import { inferColumns, getCellValue, formatMtime, type ColumnDef } from '../lib/bases';
import Icons from './Icons.vue';
import '../styles/panels.css';

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
  <!-- #245 — the back button must exist even when the view doesn't resolve.
       `view` is `savedViews.activeView`, which the store nulls out whenever the
       active slug is no longer on disk. This template used to be entirely
       behind `v-if="view"`, so in that state it rendered nothing while the
       parent still suppressed the editor — a blank pane with no escape. App.vue
       now also refuses to swap in this component without a view, so this branch
       is the safety net rather than the only guard. -->
  <div class="vnl pg" v-if="!view">
    <div class="vnl__header pg-head">
      <button class="pg-icon-btn" type="button" :title="t('views.back')" :aria-label="t('views.back')" @click="closeView">
        <Icons name="chevron-left" :size="18" />
      </button>
      <h1 class="vnl__name pg-title">{{ t('views.heading') }}</h1>
    </div>
    <div class="vnl__empty pg-empty">{{ t('views.gone') }}</div>
  </div>
  <div class="vnl pg" v-else>
    <div class="vnl__header pg-head">
      <button class="pg-icon-btn" type="button" :title="t('views.back')" :aria-label="t('views.back')" @click="closeView">
        <Icons name="chevron-left" :size="18" />
      </button>
      <span class="vnl__icon" :style="view.color ? { color: view.color } : undefined">
        <template v-if="view.icon">{{ view.icon }}</template>
        <Icons v-else name="filter" :size="18" />
      </span>
      <h1 class="vnl__name pg-title">{{ view.name }}</h1>
      <span class="pg-subtitle vnl__count">{{ rows.length }}</span>
    </div>

    <div v-if="rows.length === 0" class="vnl__empty pg-empty">{{ t('views.noMatches') }}</div>

    <ul v-else class="vnl__list pg-body">
      <li v-for="entry in rows" :key="entry.path" class="vnl__li">
        <button type="button" class="vnl__row" :title="entry.path" @click="open(entry)">
          <span class="vnl__row-main">
            <span class="vnl__row-name">{{ entry.title || entry.name }}</span>
            <span class="vnl__row-mtime">{{ formatMtime(entry.mtime) }}</span>
          </span>
          <span v-if="chipColumns.length" class="vnl__chips">
            <template v-for="col in chipColumns" :key="col.id">
              <span v-if="chipText(entry, col)" class="rp-chip">{{ chipText(entry, col) }}</span>
            </template>
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.vnl__header {
  padding-left: 16px;
  gap: 8px;
  border-bottom: var(--bd-hair);
}
.vnl__icon {
  display: inline-flex;
  align-items: center;
  font-size: 17px;
  line-height: 1;
  color: var(--text-2);
  margin-left: 2px;
}
.vnl__name {
  flex: 0 1 auto;
}
.vnl__count {
  padding-top: 4px;
}
.vnl__list {
  list-style: none;
  margin: 0;
  padding-top: 8px;
  padding-left: 16px;
  padding-right: 16px;
}
.vnl__li {
  position: relative;
}
.vnl__li + .vnl__li::before {
  content: '';
  position: absolute;
  top: 0;
  left: 12px;
  right: 12px;
  border-top: var(--bd-hair);
  pointer-events: none;
}
.vnl__li:hover::before,
.vnl__li:hover + .vnl__li::before {
  border-color: transparent;
}
.vnl__row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  min-height: 44px;
  justify-content: center;
  padding: 8px 12px;
  box-sizing: border-box;
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.vnl__row:hover {
  background: var(--fill-1);
}
.vnl__row:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.vnl__row-main {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
  min-width: 0;
}
.vnl__row-name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vnl__row-mtime {
  font-size: 12px;
  color: var(--text-3);
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}
.vnl__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
}
.vnl__chips .rp-chip {
  cursor: inherit;
}
</style>
