<script setup lang="ts">
/**
 * F3 — Tags sidebar panel.
 *
 * Lists every tag found in the workspace index (`{ tag, count }`), sorted by
 * descending frequency then alphabetically. Clicking a row emits
 * `filter-tag` so the parent can filter the file list / open a tag view.
 *
 * Header buttons:
 *   - "Today" → open / create today's daily note (uses useDailyNotes).
 *   - "Yesterday" / "Tomorrow" — same composable, smaller affordance.
 *
 * i18n keys (must exist in en.ts + zh.ts; see SUMMARY.md):
 *   tags.heading        — panel header label
 *   tags.empty          — shown when the index has no tags
 *   tags.openFolder     — shown when no folder is open
 *   tags.todayBtn       — Today button label
 *   tags.yesterdayBtn   — Yesterday button label
 *   tags.tomorrowBtn    — Tomorrow button label
 */
import { computed } from 'vue';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';
import { useDailyNotes } from '../composables/useDailyNotes';
import { useI18n } from '../i18n';

const idx = useWorkspaceIndexStore();
const daily = useDailyNotes();
const { t } = useI18n();

const emit = defineEmits<{
  (e: 'filter-tag', tag: string): void;
}>();

/** Sorted tags: descending count, then alphabetical for stable display. */
const sortedTags = computed(() => {
  return [...idx.tags].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
});

const hasFolder = computed(() => idx.folder !== null);

function onClickTag(tag: string) {
  emit('filter-tag', tag);
}

function onToday() {
  daily.openTodayNote();
}
function onYesterday() {
  daily.openYesterday();
}
function onTomorrow() {
  daily.openTomorrow();
}
</script>

<template>
  <div class="tags-panel">
    <header class="tags-panel__head">
      <span class="tags-panel__title">{{ t('tags.heading') }}</span>
      <div class="tags-panel__actions">
        <button
          class="tags-panel__btn"
          :title="t('tags.yesterdayBtn')"
          @click="onYesterday"
        >‹</button>
        <button
          class="tags-panel__btn tags-panel__btn--primary"
          @click="onToday"
        >{{ t('tags.todayBtn') }}</button>
        <button
          class="tags-panel__btn"
          :title="t('tags.tomorrowBtn')"
          @click="onTomorrow"
        >›</button>
      </div>
    </header>

    <div v-if="!hasFolder" class="tags-panel__empty">{{ t('tags.openFolder') }}</div>
    <div v-else-if="sortedTags.length === 0" class="tags-panel__empty">{{ t('tags.empty') }}</div>

    <ul v-else class="tags-panel__list">
      <li v-for="row in sortedTags" :key="row.tag" class="tags-panel__item">
        <button class="tags-panel__row" @click="onClickTag(row.tag)">
          <span class="tags-panel__pill">#{{ row.tag }}</span>
          <span class="tags-panel__count">{{ row.count }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.tags-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  overflow: hidden;
}
.tags-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
  gap: 8px;
}
.tags-panel__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.tags-panel__actions {
  display: flex;
  gap: 4px;
}
.tags-panel__btn {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text-muted);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.tags-panel__btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.tags-panel__btn--primary {
  color: var(--accent, #ff9f40);
  font-weight: 600;
}
.tags-panel__empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
}
.tags-panel__list {
  list-style: none;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  flex: 1;
}
.tags-panel__item + .tags-panel__item {
  margin-top: 2px;
}
.tags-panel__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  background: transparent;
  border: 1px solid transparent;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.tags-panel__row:hover {
  background: var(--bg-hover);
  border-color: var(--border);
}
.tags-panel__pill {
  font-size: 12px;
  font-weight: 500;
  color: var(--accent, #ff9f40);
  font-family: var(--font-mono);
  word-break: break-all;
}
.tags-panel__count {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  margin-left: 8px;
  flex-shrink: 0;
}
</style>
