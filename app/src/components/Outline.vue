<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import { useTabsStore } from '../stores/tabs';
import { extractOutline } from '../lib/markdown';

const props = defineProps<{ cursorLine?: number }>();
const emit = defineEmits<{ (e: 'goto', line: number): void }>();
const tabs = useTabsStore();
const listRef = ref<HTMLUListElement | null>(null);

const items = computed(() => {
  const t = tabs.activeTab;
  if (!t || t.language !== 'markdown') return [];
  return extractOutline(t.content);
});

// Active index = the last heading whose line is <= cursor line.
const activeIndex = computed(() => {
  const line = props.cursorLine ?? 1;
  const list = items.value;
  let idx = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i].line <= line) idx = i;
    else break;
  }
  return idx;
});

// Auto-scroll active item into view
watch(activeIndex, async () => {
  await nextTick();
  const list = listRef.value;
  if (!list) return;
  const el = list.querySelector('.outline__item--active') as HTMLElement | null;
  if (!el) return;
  const parentRect = list.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  if (elRect.top < parentRect.top || elRect.bottom > parentRect.bottom) {
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
});
</script>

<template>
  <aside class="outline">
    <div class="outline__header">
      <span>Outline</span>
      <button class="outline__close" @click="tabs.activeId && tabs.toggleOutline(tabs.activeId)">×</button>
    </div>
    <div v-if="!items.length" class="outline__empty">No headings</div>
    <ul ref="listRef" class="outline__list" v-else>
      <li
        v-for="(it, i) in items"
        :key="i"
        :class="['outline__item', { 'outline__item--active': i === activeIndex }]"
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
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.outline__close {
  padding: 0 4px;
  font-size: 16px;
  line-height: 1;
  color: var(--text-faint);
  border-radius: 3px;
}
.outline__close:hover {
  color: var(--text);
  background: var(--bg-hover);
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
.outline__item--active {
  background: var(--bg-active);
  color: var(--accent);
  font-weight: 600;
  border-left: 3px solid var(--accent);
  padding-left: calc(var(--outline-pl, 8px) - 3px);
}
.outline__empty {
  padding: 14px;
  font-size: 12px;
  color: var(--text-faint);
}
</style>
