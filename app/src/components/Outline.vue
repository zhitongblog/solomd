<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import { useTabsStore } from '../stores/tabs';
import { extractOutline, type OutlineItem } from '../lib/markdown';

interface OutlineNode {
  item: OutlineItem;
  children: OutlineNode[];
}

interface VisibleOutlineItem extends OutlineItem {
  hasChildren: boolean;
  collapsed: boolean;
  depth: number;
}

const props = defineProps<{ cursorLine?: number }>();
const emit = defineEmits<{ (e: 'goto', line: number): void }>();
const tabs = useTabsStore();
const listRef = ref<HTMLUListElement | null>(null);
const collapsedByTab = ref<Record<string, number[]>>({});

const activeMarkdownTab = computed(() => {
  const t = tabs.activeTab;
  if (!t || t.language !== 'markdown') return null;
  return t;
});

const items = computed(() => {
  if (!activeMarkdownTab.value) return [];
  return extractOutline(activeMarkdownTab.value.content);
});

function collapsedLinesFor(tabId: string | null | undefined): number[] {
  if (!tabId) return [];
  return collapsedByTab.value[tabId] ?? [];
}

function setCollapsedLines(tabId: string, lines: number[]) {
  collapsedByTab.value = {
    ...collapsedByTab.value,
    [tabId]: lines,
  };
}

function buildTree(list: OutlineItem[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const item of list) {
    const node: OutlineNode = { item, children: [] };
    while (stack.length && stack[stack.length - 1].item.level >= item.level) {
      stack.pop();
    }
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function flattenVisible(
  nodes: OutlineNode[],
  collapsed: Set<number>,
  depth = 0,
): VisibleOutlineItem[] {
  const out: VisibleOutlineItem[] = [];
  for (const node of nodes) {
    const hasChildren = node.children.length > 0;
    const isCollapsed = hasChildren && collapsed.has(node.item.line);
    out.push({
      ...node.item,
      hasChildren,
      collapsed: isCollapsed,
      depth,
    });
    if (hasChildren && !isCollapsed) {
      out.push(...flattenVisible(node.children, collapsed, depth + 1));
    }
  }
  return out;
}

const visibleItems = computed(() => {
  const tree = buildTree(items.value);
  const collapsed = new Set(collapsedLinesFor(activeMarkdownTab.value?.id));
  return flattenVisible(tree, collapsed);
});

function toggleCollapsed(line: number) {
  const tabId = activeMarkdownTab.value?.id;
  if (!tabId) return;
  const current = collapsedLinesFor(tabId);
  if (current.includes(line)) {
    setCollapsedLines(
      tabId,
      current.filter((n) => n !== line),
    );
  } else {
    setCollapsedLines(tabId, [...current, line].sort((a, b) => a - b));
  }
}

watch(
  [activeMarkdownTab, items],
  () => {
    const tabId = activeMarkdownTab.value?.id;
    if (!tabId) return;
    const valid = new Set(items.value.map((item) => item.line));
    const pruned = collapsedLinesFor(tabId).filter((line) => valid.has(line));
    if (pruned.length !== collapsedLinesFor(tabId).length) {
      setCollapsedLines(tabId, pruned);
    }
  },
  { immediate: true },
);

// Active index = the last visible heading whose line is <= cursor line.
const activeIndex = computed(() => {
  const line = props.cursorLine ?? 1;
  const list = visibleItems.value;
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
    <div v-if="!visibleItems.length" class="outline__empty">No headings</div>
    <ul ref="listRef" class="outline__list" v-else>
      <li
        v-for="(it, i) in visibleItems"
        :key="`${it.line}-${it.text}`"
        :class="['outline__item', { 'outline__item--active': i === activeIndex }]"
        :style="{ '--outline-pl': 8 + it.depth * 12 + 'px' }"
      >
        <button
          v-if="it.hasChildren"
          class="outline__twisty"
          :title="it.collapsed ? 'Expand section' : 'Collapse section'"
          @click.stop="toggleCollapsed(it.line)"
        >
          {{ it.collapsed ? '▸' : '▾' }}
        </button>
        <span v-else class="outline__twisty outline__twisty--spacer" aria-hidden="true"></span>
        <button
          class="outline__label"
          @click="emit('goto', it.line)"
          :title="it.text"
        >
          {{ it.text }}
        </button>
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
  padding: 2px 10px 2px var(--outline-pl, 8px);
  display: flex;
  align-items: center;
  gap: 4px;
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
.outline__twisty {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  line-height: 1;
  color: var(--text-faint);
  border-radius: 3px;
}
.outline__twisty:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
.outline__twisty--spacer {
  pointer-events: none;
}
.outline__label {
  min-width: 0;
  flex: 1;
  font: inherit;
  color: inherit;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.outline__empty {
  padding: 14px;
  font-size: 12px;
  color: var(--text-faint);
}
</style>
