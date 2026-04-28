<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
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

// ---------------------------------------------------------------------------
// v3.1.x keyboard jump (vimium-style)
// ---------------------------------------------------------------------------
//
// When the outline is visible AND the editor isn't actively typing, single
// letters jump to the labeled section, and `g<digits><Enter>` jumps to a
// specific line. Letter labels skip `g` to keep that key reserved for the
// line-jump mode trigger.
//
// The jump emits `goto(line)` — same path the click handler uses — so the
// existing solomd:outline-goto event keeps everything else (scroll sync,
// preview-mode goto, focus restore) wired identically.

const LABEL_ALPHABET = 'abcdefhijklmnopqrstuvwxyz123456789'.split(''); // skip 'g'

function labelAt(index: number): string {
  if (index < LABEL_ALPHABET.length) return LABEL_ALPHABET[index];
  // Two-char fallback for very long docs: aa, ab, ..., zz
  const a = Math.floor((index - LABEL_ALPHABET.length) / 26);
  const b = (index - LABEL_ALPHABET.length) % 26;
  if (a >= 26) return ''; // out of room — happens past ~700 entries
  return 'abcdefhijklmnopqrstuvwxyz'[a] + 'abcdefhijklmnopqrstuvwxyz'[b];
}

type JumpMode = 'idle' | 'line-jump';
const jumpMode = ref<JumpMode>('idle');
const lineBuffer = ref('');

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

// Skip the keyboard handler when the user is actively typing. Editor
// (CodeMirror) lives in a contenteditable div; settings panels use
// <input>/<textarea>. We don't want `t` or `g` to fire while someone
// is writing the letter `g`.
function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

function jumpToLabel(label: string) {
  const items = visibleItems.value;
  for (let i = 0; i < items.length; i++) {
    if (labelAt(i) === label) {
      emit('goto', items[i].line);
      return true;
    }
  }
  return false;
}

function commitLineJump() {
  const n = parseInt(lineBuffer.value, 10);
  jumpMode.value = 'idle';
  lineBuffer.value = '';
  if (Number.isFinite(n) && n >= 1) emit('goto', n);
}

function onWindowKey(e: KeyboardEvent) {
  if (isTypingTarget(e.target)) return;
  // Don't intercept while the user holds a modifier — those are reserved
  // for the global ⌘/Ctrl shortcut palette.
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (jumpMode.value === 'line-jump') {
    if (e.key >= '0' && e.key <= '9') {
      lineBuffer.value += e.key;
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      commitLineJump();
      return;
    }
    if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault();
      jumpMode.value = 'idle';
      lineBuffer.value = '';
      return;
    }
    return; // swallow other keys silently
  }

  // Idle mode
  if (e.key === 'g') {
    e.preventDefault();
    jumpMode.value = 'line-jump';
    lineBuffer.value = '';
    return;
  }
  if (e.key === 'Escape') {
    return; // let other components close their UIs
  }
  // Single label letter or digit
  if (e.key.length === 1 && /[a-z0-9]/.test(e.key)) {
    if (jumpToLabel(e.key)) e.preventDefault();
  }
}

onMounted(() => window.addEventListener('keydown', onWindowKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKey));
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
        <span
          v-if="labelAt(i)"
          class="outline__keylabel"
          :title="`Press ${labelAt(i)} to jump`"
          aria-hidden="true"
        >{{ labelAt(i) }}</span>
        <button
          class="outline__label"
          @click="emit('goto', it.line)"
          :title="it.text"
        >
          {{ it.text }}
        </button>
      </li>
    </ul>
    <div v-if="jumpMode === 'line-jump'" class="outline__statusbar">
      <span class="outline__statusbar-prefix">: g</span><span class="outline__statusbar-buf">{{ lineBuffer || '_' }}</span>
      <span class="outline__statusbar-hint">Enter ↵ goto · Esc cancel</span>
    </div>
    <div v-else-if="visibleItems.length" class="outline__statusbar outline__statusbar--idle">
      <span class="outline__statusbar-hint">letter → jump · g+digits → line</span>
    </div>
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
.outline__keylabel {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  flex: 0 0 auto;
  padding: 2px 4px;
  border-radius: 3px;
  background: var(--bg-active);
  color: var(--text-muted);
  letter-spacing: 0.04em;
  user-select: none;
}
.outline__item:hover .outline__keylabel,
.outline__item--active .outline__keylabel {
  background: var(--accent);
  color: var(--accent-fg, #1a1a1a);
}
.outline__statusbar {
  border-top: 1px solid var(--border);
  padding: 6px 10px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  color: var(--text);
  background: var(--bg-active);
  display: flex;
  align-items: center;
  gap: 8px;
}
.outline__statusbar--idle {
  color: var(--text-faint);
  background: transparent;
}
.outline__statusbar-prefix {
  color: var(--accent);
  font-weight: 600;
}
.outline__statusbar-buf {
  flex: 1;
  font-weight: 600;
}
.outline__statusbar-hint {
  margin-left: auto;
  color: var(--text-faint);
  font-size: 10px;
}
</style>
