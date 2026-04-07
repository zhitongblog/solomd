<script setup lang="ts">
import { computed } from 'vue';
import { useTabsStore } from '../stores/tabs';
import { cjkWordCount } from '../lib/chinese';

const props = defineProps<{ line: number; col: number }>();
const tabs = useTabsStore();

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
    <span class="spacer"></span>
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
</style>
