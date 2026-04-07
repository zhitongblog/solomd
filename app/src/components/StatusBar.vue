<script setup lang="ts">
import { computed } from 'vue';
import { useTabsStore } from '../stores/tabs';

const props = defineProps<{ line: number; col: number }>();
const tabs = useTabsStore();

const wordCount = computed(() => {
  const c = tabs.activeTab?.content ?? '';
  if (!c) return 0;
  // Approximate: split on whitespace, but also count CJK chars as words.
  const ascii = (c.match(/[A-Za-z0-9_]+/g) || []).length;
  const cjk = (c.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return ascii + cjk;
});
const charCount = computed(() => tabs.activeTab?.content.length ?? 0);
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
</style>
