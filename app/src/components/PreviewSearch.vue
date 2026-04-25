<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useI18n } from '../i18n';

const props = defineProps<{ container: HTMLElement }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { t } = useI18n();

const inputRef = ref<HTMLInputElement | null>(null);
const query = ref('');
const matchCount = ref(0);
const currentIdx = ref(0);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let observer: MutationObserver | null = null;

function pauseObserver() {
  observer?.disconnect();
}

function resumeObserver() {
  if (!observer || !props.container) return;
  observer.observe(props.container, { childList: true, subtree: true });
}

function clearMarks() {
  if (!props.container) return;
  pauseObserver();
  const marks = props.container.querySelectorAll<HTMLElement>('mark.ps-mark');
  for (const mark of Array.from(marks)) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
  }
  props.container.normalize();
  matchCount.value = 0;
  currentIdx.value = 0;
  resumeObserver();
}

function doSearch() {
  clearMarks();
  const q = query.value.trim();
  if (!q || !props.container) return;

  pauseObserver();

  const lower = q.toLowerCase();
  const walker = document.createTreeWalker(
    props.container,
    NodeFilter.SHOW_TEXT,
    null,
  );

  // Collect match positions grouped by text node.
  const byNode = new Map<Text, Array<{ start: number; end: number }>>();
  let total = 0;
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const text = node.textContent || '';
    const lowerText = text.toLowerCase();
    let pos = 0;
    const hits: Array<{ start: number; end: number }> = [];
    while ((pos = lowerText.indexOf(lower, pos)) !== -1) {
      hits.push({ start: pos, end: pos + q.length });
      pos += 1;
    }
    if (hits.length > 0) {
      byNode.set(node, hits);
      total += hits.length;
    }
  }

  if (total > 0) {
    // Apply highlights per node, descending by offset to avoid shifts.
    for (const [textNode, hits] of byNode) {
      const sorted = [...hits].sort((a, b) => b.start - a.start);
      for (const { start, end } of sorted) {
        const range = document.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
        const mark = document.createElement('mark');
        mark.className = 'ps-mark';
        range.surroundContents(mark);
      }
    }
    matchCount.value = total;
    currentIdx.value = 0;
  }

  resumeObserver();

  if (total > 0) highlightCurrent();
}

function highlightCurrent() {
  if (!props.container) return;
  const marks = props.container.querySelectorAll<HTMLElement>('mark.ps-mark');
  marks.forEach((m, i) => {
    m.classList.toggle('ps-mark--current', i === currentIdx.value);
  });
  const current = marks[currentIdx.value];
  if (current) {
    current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function goNext() {
  if (matchCount.value === 0) return;
  currentIdx.value = (currentIdx.value + 1) % matchCount.value;
  highlightCurrent();
}

function goPrev() {
  if (matchCount.value === 0) return;
  currentIdx.value = (currentIdx.value - 1 + matchCount.value) % matchCount.value;
  highlightCurrent();
}

function onInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(doSearch, 150);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) goPrev(); else goNext();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    close();
  }
}

function close() {
  clearMarks();
  query.value = '';
  emit('close');
}

function setupObserver() {
  if (observer) observer.disconnect();
  observer = new MutationObserver(() => {
    if (query.value.trim()) {
      nextTick(doSearch);
    }
  });
  observer.observe(props.container, { childList: true, subtree: true });
}

watch(() => props.container, (el) => {
  if (el) setupObserver();
});

onMounted(() => {
  nextTick(() => {
    inputRef.value?.focus();
    if (props.container) setupObserver();
  });
});

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  observer?.disconnect();
  clearMarks();
});

function focusInput() {
  inputRef.value?.focus();
}

defineExpose({ focusInput });
</script>

<template>
  <div class="ps-bar" @click.stop @mousedown.stop>
    <input
      ref="inputRef"
      class="ps-input"
      type="text"
      :placeholder="t('previewSearchPlaceholder')"
      v-model="query"
      @input="onInput"
      @keydown="onKeydown"
    />
    <span class="ps-count" v-if="query.trim()">
      {{ matchCount > 0 ? `${currentIdx + 1}/${matchCount}` : t('noResults') }}
    </span>
    <button class="ps-btn" :disabled="matchCount === 0" @click="goPrev" title="Previous">&#9650;</button>
    <button class="ps-btn" :disabled="matchCount === 0" @click="goNext" title="Next">&#9660;</button>
    <button class="ps-btn ps-btn--close" @click="close" title="Close">&#10005;</button>
  </div>
</template>

<style scoped>
.ps-bar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  font-family: var(--font-ui);
}
.ps-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  font: 14px var(--font-ui);
  color: var(--text);
  min-width: 0;
}
.ps-input::placeholder {
  color: var(--text-faint);
}
.ps-count {
  font-size: 12px;
  color: var(--text-faint);
  white-space: nowrap;
  min-width: 40px;
  text-align: right;
}
.ps-btn {
  padding: 2px 6px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.ps-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}
.ps-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.ps-btn--close {
  font-size: 14px;
  padding: 2px 4px;
}
</style>
