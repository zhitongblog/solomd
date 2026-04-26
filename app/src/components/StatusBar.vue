<script setup lang="ts">
import { computed } from 'vue';
import { useTabsStore } from '../stores/tabs';
import { useSettingsStore } from '../stores/settings';
import { useWritingSessionStore } from '../stores/writingSession';
import { cjkWordCount } from '../lib/chinese';
import { useInbox } from '../composables/useInbox';
import { useI18n } from '../i18n';
import WritingGoals from './WritingGoals.vue';

const props = defineProps<{ line: number; col: number }>();
const tabs = useTabsStore();
const settings = useSettingsStore();
const writingSession = useWritingSessionStore();
const inbox = useInbox();
const { t } = useI18n();

const stats = computed(() => {
  const c = tabs.activeTab?.content ?? '';
  return cjkWordCount(c);
});

const wordCount = computed(() => stats.value.total);
const cjkCount = computed(() => stats.value.cjk);
const charCount = computed(() => stats.value.chars);
const lineCount = computed(() => {
  const c = tabs.activeTab?.content ?? '';
  return c ? c.split('\n').length : 0;
});
const lang = computed(() => (tabs.activeTab?.language === 'markdown' ? 'Markdown' : 'Plain Text'));
const enc = computed(() => tabs.activeTab?.encoding ?? 'UTF-8');

const showTodayTotal = computed(
  () =>
    settings.showWritingStats &&
    settings.showWorkspaceDailyTotal &&
    writingSession.todayDocCount > 0,
);

function onPillClick() {
  // Click toggles off — same affordance as ⌘E.
  inbox.toggleActive();
}
</script>

<template>
  <div class="statusbar">
    <span class="seg">Ln {{ props.line }}, Col {{ props.col }}</span>
    <span class="sep">·</span>
    <span class="seg">{{ lineCount }} lines</span>
    <span class="sep">·</span>
    <span class="seg">{{ wordCount }} words</span>
    <span v-if="cjkCount > 0" class="seg seg--cjk" :title="`${cjkCount} CJK characters`">
      ({{ cjkCount }} 字)
    </span>
    <span class="sep">·</span>
    <span class="seg">{{ charCount }} chars</span>
    <WritingGoals v-if="settings.showWritingStats" />
    <span class="spacer"></span>
    <span
      v-if="showTodayTotal"
      class="seg seg--today"
      :title="t('writingStats.todayTooltip')"
    >
      {{
        t('writingStats.todayWorkspaceValue', {
          n: writingSession.todayTotal.toLocaleString(),
          docs: String(writingSession.todayDocCount),
        })
      }}
    </span>
    <button
      v-if="inbox.activeIsInbox.value"
      class="seg seg--inbox"
      :title="t('inbox.pillTooltip')"
      @click="onPillClick"
    >
      {{ t('inbox.pill') }}
    </button>
    <span class="seg">{{ enc }}</span>
    <span class="sep">·</span>
    <span class="seg seg--lang">{{ lang }}</span>
  </div>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--statusbar-h);
  padding: 0 12px;
  background: var(--bg-elev);
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-muted);
  user-select: none;
}
.spacer { flex: 1; }
.sep { color: var(--text-faint); }
.seg--lang { color: var(--accent); }
.seg--cjk { color: var(--accent); margin-left: -4px; }
.seg--inbox {
  background: var(--accent);
  color: var(--bg-elev);
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border: none;
  cursor: pointer;
}
.seg--inbox:hover {
  filter: brightness(1.1);
}
.seg--today {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
</style>
