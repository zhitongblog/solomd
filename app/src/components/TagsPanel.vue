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
import Icons from './Icons.vue';
import PanelHeader from './panel/PanelHeader.vue';

const idx = useWorkspaceIndexStore();
const daily = useDailyNotes();
const { t } = useI18n();

const emit = defineEmits<{
  (e: 'filter-tag', tag: string): void;
  (e: 'close'): void;
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
  <div class="tags-panel rp">
    <PanelHeader :title="t('tags.heading')" @close="emit('close')">
      <button
        class="rp-icon-btn"
        type="button"
        :title="t('tags.yesterdayBtn')"
        :aria-label="t('tags.yesterdayBtn')"
        @click="onYesterday"
      ><Icons name="chevron-left" :size="14" /></button>
      <button
        class="tags-panel__today"
        type="button"
        @click="onToday"
      >{{ t('tags.todayBtn') }}</button>
      <button
        class="rp-icon-btn"
        type="button"
        :title="t('tags.tomorrowBtn')"
        :aria-label="t('tags.tomorrowBtn')"
        @click="onTomorrow"
      ><Icons name="chevron-right" :size="14" /></button>
    </PanelHeader>

    <div v-if="!hasFolder" class="rp-empty">{{ t('tags.openFolder') }}</div>
    <div v-else-if="sortedTags.length === 0" class="rp-empty">{{ t('tags.empty') }}</div>

    <ul v-else class="rp-body rp-list">
      <li v-for="row in sortedTags" :key="row.tag">
        <button class="rp-row" type="button" @click="onClickTag(row.tag)">
          <Icons class="rp-row__icon" name="tag" :size="14" />
          <span class="rp-row__label">{{ row.tag }}</span>
          <span class="rp-count">{{ row.count }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.tags-panel__today {
  height: 22px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.tags-panel__today:hover {
  background: var(--fill-1);
  color: var(--text);
}
.tags-panel__today:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
</style>
