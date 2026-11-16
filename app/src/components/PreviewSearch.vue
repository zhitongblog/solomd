<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useI18n } from '../i18n';
import {
  MAX_PREVIEW_MARKS,
  findPreviewHitsInText,
  type PreviewTextHit,
} from '../lib/preview-search-hits';

const props = defineProps<{ container: HTMLElement }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { t } = useI18n();

const inputRef = ref<HTMLInputElement | null>(null);
const query = ref('');
const matchCount = ref(0);
const matchTruncated = ref(false);
const currentIdx = ref(0);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let observer: MutationObserver | null = null;
let markElements: HTMLElement[] = [];
let activeMarkEl: HTMLElement | null = null;

function pauseObserver() {
  observer?.disconnect();
}

function resumeObserver() {
  if (!observer || !props.container) return;
  observer.observe(props.container, { childList: true, subtree: true });
}

function clearMarks() {
  activeMarkEl = null;
  if (!props.container) {
    markElements = [];
    matchCount.value = 0;
    matchTruncated.value = false;
    currentIdx.value = 0;
    return;
  }
  pauseObserver();
  try {
    const marks =
      markElements.length > 0
        ? markElements
        : Array.from(props.container.querySelectorAll<HTMLElement>('mark.ps-mark'));
    const dirtyParents = new Set<Node>();
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      dirtyParents.add(parent);
      parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
    }
    for (const parent of dirtyParents) {
      parent.normalize();
    }
    markElements = [];
    matchCount.value = 0;
    matchTruncated.value = false;
    currentIdx.value = 0;
  } finally {
    resumeObserver();
  }
}

function doSearch() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  clearMarks();
  const q = query.value.trim();
  if (!q || !props.container) return;

  pauseObserver();
  try {
    const walker = document.createTreeWalker(
      props.container,
      NodeFilter.SHOW_TEXT,
      null,
    );

    // Collect non-overlapping match positions grouped by text node, capped at
    // MAX_PREVIEW_MARKS so a 1-char query on a huge document never wraps
    // thousands of DOM nodes synchronously.
    const byNode = new Map<Text, PreviewTextHit[]>();
    let total = 0;
    let truncated = false;
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const text = node.textContent || '';
      if (!text) continue;
      const remaining = MAX_PREVIEW_MARKS - total;
      if (remaining <= 0) {
        if (findPreviewHitsInText(text, q, 1).hits.length > 0) {
          truncated = true;
          break;
        }
        continue;
      }
      const res = findPreviewHitsInText(text, q, remaining);
      if (res.hits.length > 0) {
        byNode.set(node, res.hits);
        total += res.hits.length;
      }
      if (res.truncated) {
        truncated = true;
        break;
      }
    }

    if (total > 0) {
      const createdMarks: HTMLElement[] = [];
      // Apply highlights per node, descending by offset to avoid shifts, then
      // reverse the node's marks back into document order.
      for (const [textNode, hits] of byNode) {
        const nodeMarks: HTMLElement[] = [];
        for (let idx = hits.length - 1; idx >= 0; idx -= 1) {
          const { start, end } = hits[idx];
          const nodeLen = textNode.nodeValue?.length ?? 0;
          if (start < 0 || end > nodeLen || start >= end) continue;
          const range = document.createRange();
          range.setStart(textNode, start);
          range.setEnd(textNode, end);
          const mark = document.createElement('mark');
          mark.className = 'ps-mark';
          range.surroundContents(mark);
          nodeMarks.push(mark);
        }
        nodeMarks.reverse();
        for (const m of nodeMarks) createdMarks.push(m);
      }
      markElements = createdMarks;
      matchCount.value = createdMarks.length;
      matchTruncated.value = truncated;
      currentIdx.value = 0;
    }
  } finally {
    resumeObserver();
  }

  if (matchCount.value > 0) highlightCurrent();
}

function highlightCurrent() {
  if (!props.container || markElements.length === 0) return;
  if (activeMarkEl) activeMarkEl.classList.remove('ps-mark--current');
  const current = markElements[currentIdx.value] ?? null;
  activeMarkEl = current;
  if (current) {
    current.classList.add('ps-mark--current');
    current.scrollIntoView({ block: 'center', behavior: 'auto' });
  }
}

function flushSearchIfPending(): boolean {
  if (debounceTimer !== null) {
    doSearch();
    return true;
  }
  return false;
}

function goNext() {
  const flushed = flushSearchIfPending();
  if (matchCount.value === 0) return;
  if (flushed) return;
  currentIdx.value = (currentIdx.value + 1) % matchCount.value;
  highlightCurrent();
}

function goPrev() {
  const flushed = flushSearchIfPending();
  if (matchCount.value === 0) return;
  if (flushed) {
    currentIdx.value = matchCount.value - 1;
    highlightCurrent();
    return;
  }
  currentIdx.value = (currentIdx.value - 1 + matchCount.value) % matchCount.value;
  highlightCurrent();
}

function onInput(e?: Event) {
  if ((e as InputEvent | undefined)?.isComposing) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    doSearch();
  }, 120);
}

function onKeydown(e: KeyboardEvent) {
  // CJK/IME guard — Enter during composition belongs to the IME.
  if (e.isComposing || e.keyCode === 229) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === 'f' || e.code === 'KeyF')) {
    e.preventDefault();
    e.stopPropagation();
    close();
    return;
  }
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
      :placeholder="t('toolbar.previewSearchPlaceholder')"
      v-model="query"
      @input="onInput"
      @compositionend="onInput"
      @keydown="onKeydown"
    />
    <span class="ps-count" v-if="query.trim()">
      {{ matchCount > 0 ? `${currentIdx + 1}/${matchTruncated ? `${matchCount}+` : matchCount}` : t('toolbar.noResults') }}
    </span>
    <button class="ps-btn" :disabled="matchCount === 0" :title="t('plainFind.prev')" @click="goPrev">&#9650;</button>
    <button class="ps-btn" :disabled="matchCount === 0" :title="t('plainFind.next')" @click="goNext">&#9660;</button>
    <button class="ps-btn ps-btn--close" :title="t('plainFind.close')" @click="close">&#10005;</button>
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
