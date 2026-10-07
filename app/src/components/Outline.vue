<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useTabsStore } from '../stores/tabs';
import { useSettingsStore } from '../stores/settings';
import { useI18n } from '../i18n';
import { extractOutline, type OutlineItem } from '../lib/markdown';
import Icons from './Icons.vue';
import PanelHeader from './panel/PanelHeader.vue';

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
const settings = useSettingsStore();
const { t } = useI18n();
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
  // v4.6.2 — marker style is user-configurable (Settings → Writing):
  //   'none'   → no marker
  //   'number' → clean sequential 1/2/3… (single-digit ones still keyboard-jump)
  //   'jump'   → a/b/c… keyboard-jump labels (default; mixes letters + digits)
  const marker = settings.outlineMarker;
  if (marker === 'none') return '';
  if (marker === 'number') return String(index + 1);
  if (index < LABEL_ALPHABET.length) return LABEL_ALPHABET[index];
  // Two-char fallback for very long docs: aa, ab, ..., zz. The alphabet skips
  // 'g' (reserved for the g+digits line-jump), so it is 25 chars — divide and
  // wrap by its real length, not 26, or every 25th label reads "aundefined"
  // (#206: the [25] lookup was out of bounds).
  const TWO_CHAR = 'abcdefhijklmnopqrstuvwxyz';
  const n = TWO_CHAR.length;
  const a = Math.floor((index - LABEL_ALPHABET.length) / n);
  const b = (index - LABEL_ALPHABET.length) % n;
  if (a >= n) return ''; // out of room — happens past ~650 entries
  return TWO_CHAR[a] + TWO_CHAR[b];
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
  <aside class="outline rp">
    <PanelHeader
      :title="t('toolbar.outline')"
      @close="tabs.activeId && tabs.toggleOutline(tabs.activeId)"
    />
    <div v-if="!visibleItems.length" class="rp-empty">{{ t('outline.empty') }}</div>
    <ul ref="listRef" class="outline__list rp-body rp-list" v-else>
      <li
        v-for="(it, i) in visibleItems"
        :key="`${it.line}-${it.text}`"
        :class="['outline__item', 'rp-row', `outline__item--h${it.level}`, { 'outline__item--active': i === activeIndex, 'is-active': i === activeIndex }]"
        :style="{ '--outline-pl': 4 + it.depth * 14 + 'px' }"
        @click="emit('goto', it.line)"
      >
        <button
          v-if="it.hasChildren"
          class="outline__twisty"
          :class="{ 'outline__twisty--collapsed': it.collapsed }"
          :title="it.collapsed ? t('outline.expandSection') : t('outline.collapseSection')"
          :aria-expanded="!it.collapsed"
          @click.stop="toggleCollapsed(it.line)"
        >
          <Icons name="chevron-down" :size="12" />
        </button>
        <span v-else class="outline__twisty outline__twisty--spacer" aria-hidden="true"></span>
        <button
          class="outline__label"
          @click.stop="emit('goto', it.line)"
          :title="it.text"
        >
          {{ it.text }}
        </button>
        <span
          v-if="labelAt(i)"
          class="outline__keylabel"
          :title="t('outline.pressToJump', { key: labelAt(i) })"
          aria-hidden="true"
        >{{ labelAt(i) }}</span>
      </li>
    </ul>
    <div v-if="jumpMode === 'line-jump'" class="outline__statusbar outline__statusbar--active">
      <span class="outline__statusbar-prefix">g</span><span class="outline__statusbar-buf">{{ lineBuffer || '_' }}</span>
      <span class="outline__statusbar-hint">{{ t('outline.hint') }}</span>
    </div>
    <div v-else-if="visibleItems.length" class="outline__statusbar outline__statusbar--idle">
      <span class="outline__statusbar-hint">{{ settings.outlineMarker === 'none' ? t('outline.jumpLineOnly') : (settings.outlineMarker === 'number' ? t('outline.jumpByNumber') : t('outline.jumpByLetter')) }}</span>
    </div>
  </aside>
</template>

<style scoped>
.outline {
  width: 100%;
  min-width: 0;
  user-select: none;
  -webkit-user-select: none;
}
.outline__item {
  gap: 2px;
  padding-left: var(--outline-pl, 4px);
  padding-right: 6px;
  color: var(--text-2);
}
.outline__item--h1,
.outline__item--h2 {
  color: var(--text);
}
.outline__item--active {
  font-weight: 500;
}
.outline__twisty {
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.outline__twisty:hover {
  background: var(--fill-2);
  color: var(--text);
}
.outline__twisty--collapsed {
  transform: rotate(-90deg);
}
.outline__twisty--spacer {
  pointer-events: none;
}
.outline__label {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.outline__keylabel {
  flex: 0 0 auto;
  min-width: 14px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  line-height: 1;
  text-align: center;
  color: var(--text-3);
  opacity: 0.75;
}
.outline__item:hover .outline__keylabel,
.outline__item--active .outline__keylabel {
  opacity: 1;
  color: inherit;
}
.outline__statusbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 12px;
  border-top: var(--bd-hair);
  font-size: 11px;
  color: var(--text-3);
}
.outline__statusbar--active {
  color: var(--text);
  font-family: var(--font-mono);
}
.outline__statusbar-prefix {
  color: var(--accent-text);
  font-weight: 600;
}
.outline__statusbar-buf {
  flex: 1;
  font-weight: 600;
}
.outline__statusbar-hint {
  margin-left: auto;
  font-family: var(--font-ui);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
