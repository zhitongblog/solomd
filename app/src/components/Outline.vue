<script setup lang="ts">
import { computed } from 'vue';
import { useTabsStore } from '../stores/tabs';
import { extractOutline } from '../lib/markdown';

const emit = defineEmits<{ (e: 'goto', line: number): void }>();
const tabs = useTabsStore();

const items = computed(() => {
  const t = tabs.activeTab;
  if (!t || t.language !== 'markdown') return [];
  return extractOutline(t.content);
});
</script>

<template>
  <aside class="outline">
    <div class="outline__header">Outline</div>
    <div v-if="!items.length" class="outline__empty">No headings</div>
    <ul class="outline__list" v-else>
      <li
        v-for="(it, i) in items"
        :key="i"
        class="outline__item"
        :style="{ paddingLeft: 8 + (it.level - 1) * 12 + 'px' }"
        @click="emit('goto', it.line)"
        :title="it.text"
      >
        {{ it.text }}
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.outline {
  width: 240px;
  height: 100%;
  background: var(--bg-elev);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  user-select: none;
}
.outline__header {
  padding: 10px 14px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
}
.outline__list {
  list-style: none;
  margin: 0;
  padding: 6px 0;
  overflow-y: auto;
  flex: 1;
}
.outline__item {
  font-size: 12px;
  padding: 4px 14px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}
.outline__item:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
.outline__empty {
  padding: 14px;
  font-size: 12px;
  color: var(--text-faint);
}
</style>
