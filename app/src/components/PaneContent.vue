<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import Editor from './Editor.vue';
import Preview from './Preview.vue';
import { useSettingsStore } from '../stores/settings';
import { useTilesStore } from '../stores/tiles';
import type { Tab } from '../types';

const props = defineProps<{
  paneId: string;
  tab: Tab | undefined;
}>();

const emit = defineEmits<{
  (e: 'cursor', line: number, col: number): void;
  (e: 'selection', text: string): void;
}>();

const settings = useSettingsStore();
const tiles = useTilesStore();

const editorRef = ref<InstanceType<typeof Editor> | null>(null);
const previewRef = ref<InstanceType<typeof Preview> | null>(null);

const showEditor = computed(
  () => props.tab?.language !== 'markdown' || settings.viewMode !== 'preview'
);
// `liveEdit` mode is editor-only: the inline-rendered markdown IS the
// preview, so we don't show the separate Preview pane next to it.
const showPreview = computed(
  () =>
    props.tab?.language === 'markdown' &&
    settings.viewMode !== 'edit' &&
    settings.viewMode !== 'liveEdit'
);

const isFocused = computed(() => tiles.focusedPaneId === props.paneId);

function onCursor(line: number, col: number) {
  if (isFocused.value) {
    emit('cursor', line, col);
  }
}

function onSelection(text: string) {
  if (isFocused.value) {
    emit('selection', text);
  }
}

function gotoLine(line: number) {
  if (settings.viewMode === 'preview') {
    previewRef.value?.scrollToLine(line);
  } else {
    editorRef.value?.gotoLine(line);
  }
}

// ---- Pane-scoped scroll sync ----
let syncEditorScroll: (() => void) | null = null;
let syncPreviewScroll: (() => void) | null = null;
let syncGuard = false;

function getPreviewElementsByLine(preview: HTMLElement): Array<{ line: number; el: HTMLElement }> {
  const nodes = preview.querySelectorAll<HTMLElement>('[data-source-line]');
  const list: Array<{ line: number; el: HTMLElement }> = [];
  for (const el of Array.from(nodes)) {
    const n = Number(el.getAttribute('data-source-line') || '0');
    if (n > 0) list.push({ line: n, el });
  }
  list.sort((a, b) => a.line - b.line);
  return list;
}

function findNearestEntry<T extends { line: number }>(list: T[], line: number): T | null {
  if (!list.length) return null;
  let lo = 0, hi = list.length - 1, best = list[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].line <= line) { best = list[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

function bindScrollSync() {
  if (syncEditorScroll) syncEditorScroll();
  if (syncPreviewScroll) syncPreviewScroll();
  syncEditorScroll = null;
  syncPreviewScroll = null;

  if (settings.viewMode !== 'split') return;

  const paneEl = document.querySelector(`[data-pane-id="${props.paneId}"]`);
  if (!paneEl) return;
  const editor = paneEl.querySelector('.pane--editor .cm-scroller') as HTMLElement | null;
  const preview = paneEl.querySelector('.pane--preview .preview-host') as HTMLElement | null;
  if (!editor || !preview) return;

  // Driver lock: only the pane the user is actively scrolling syncs to the
  // other. The one-frame `syncGuard` alone is too short — a programmatic
  // scroll spawns its own 'scroll' events a frame or two later, after the
  // guard clears, so the two handlers echo each other. That's most visible
  // at the bottom, where the line↔pixel mappings can't both be satisfied:
  // the echoes never converge and the view scrolls forever / bounces. By
  // tracking which pane the user actually drives (wheel / pointer / touch /
  // key) and ignoring the passive pane's induced scrolls, the loop can't
  // form. The window resets on each intent event so continuous scrolling and
  // momentum keep the same driver.
  let activePane: 'editor' | 'preview' | null = null;
  let activeTimer: ReturnType<typeof setTimeout> | null = null;
  const markActive = (which: 'editor' | 'preview') => {
    activePane = which;
    if (activeTimer) clearTimeout(activeTimer);
    activeTimer = setTimeout(() => { activePane = null; }, 250);
  };
  const intentEvents = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;
  const editorIntent = () => markActive('editor');
  const previewIntent = () => markActive('preview');
  for (const ev of intentEvents) {
    editor.addEventListener(ev, editorIntent, { passive: true });
    preview.addEventListener(ev, previewIntent, { passive: true });
  }

  const onEditorScroll = () => {
    if (syncGuard || activePane === 'preview') return;
    const cmRef = editorRef.value as any;
    let currentLine: number | null = null;
    if (cmRef?.getViewLine) {
      currentLine = cmRef.getViewLine();
    }
    if (!currentLine) return;

    const previewLines = getPreviewElementsByLine(preview);
    const entry = findNearestEntry(previewLines, currentLine);
    if (!entry) {
      const emax = editor.scrollHeight - editor.clientHeight;
      const pmax = preview.scrollHeight - preview.clientHeight;
      if (emax > 0 && pmax > 0) {
        syncGuard = true;
        preview.scrollTop = (editor.scrollTop / emax) * pmax;
        requestAnimationFrame(() => { syncGuard = false; });
      }
      return;
    }
    const elRect = entry.el.getBoundingClientRect();
    const wrapRect = preview.getBoundingClientRect();
    syncGuard = true;
    preview.scrollTop += elRect.top - wrapRect.top - 8;
    requestAnimationFrame(() => { syncGuard = false; });
  };

  const onPreviewScroll = () => {
    if (syncGuard || activePane === 'editor') return;
    const previewLines = getPreviewElementsByLine(preview);
    const wrapTop = preview.getBoundingClientRect().top;
    let targetLine: number | null = null;
    for (const { line, el } of previewLines) {
      const r = el.getBoundingClientRect();
      if (r.bottom >= wrapTop) { targetLine = line; break; }
    }
    if (targetLine == null) return;
    const cmRef = editorRef.value as any;
    if (cmRef?.scrollToLine) {
      syncGuard = true;
      cmRef.scrollToLine(targetLine);
      requestAnimationFrame(() => { syncGuard = false; });
    }
  };

  editor.addEventListener('scroll', onEditorScroll, { passive: true });
  preview.addEventListener('scroll', onPreviewScroll, { passive: true });
  syncEditorScroll = () => {
    editor.removeEventListener('scroll', onEditorScroll);
    for (const ev of intentEvents) editor.removeEventListener(ev, editorIntent);
  };
  syncPreviewScroll = () => {
    preview.removeEventListener('scroll', onPreviewScroll);
    for (const ev of intentEvents) preview.removeEventListener(ev, previewIntent);
    if (activeTimer) clearTimeout(activeTimer);
  };
}

// v4.3.0 issue #67: preserve scroll position across view-mode switches.
// User flow: scrolls down in preview → finds typo → flips to edit mode →
// previously snapped back to line 1, forcing them to find the spot again.
// We snapshot the "current top line" from whichever view is leaving the DOM,
// then scroll the newly mounted view(s) to that line so the cursor / reader
// stays in roughly the same place.
function getCurrentTopLine(paneEl: Element, fromMode: string): number | null {
  if (fromMode === 'preview' || fromMode === 'reading') {
    const preview = paneEl.querySelector('.pane--preview .preview-host') as HTMLElement | null;
    if (!preview) return null;
    const list = getPreviewElementsByLine(preview);
    const wrapTop = preview.getBoundingClientRect().top;
    for (const { line, el } of list) {
      const r = el.getBoundingClientRect();
      if (r.bottom >= wrapTop) return line;
    }
    return null;
  }
  // edit / liveEdit / split — use the editor's top visible line
  const cmRef = editorRef.value as any;
  return cmRef?.getViewLine ? cmRef.getViewLine() : null;
}

function restoreToLine(paneEl: Element, toMode: string, line: number) {
  if (toMode === 'edit' || toMode === 'liveEdit' || toMode === 'split') {
    const cmRef = editorRef.value as any;
    if (cmRef?.scrollToLine) cmRef.scrollToLine(line);
  }
  if (toMode === 'preview' || toMode === 'reading' || toMode === 'split') {
    const preview = paneEl.querySelector('.pane--preview .preview-host') as HTMLElement | null;
    if (preview) {
      const list = getPreviewElementsByLine(preview);
      const entry = findNearestEntry(list, line);
      if (entry) {
        const elRect = entry.el.getBoundingClientRect();
        const wrapRect = preview.getBoundingClientRect();
        preview.scrollTop += elRect.top - wrapRect.top - 8;
      }
    }
  }
}

watch(() => settings.viewMode, async (newMode, oldMode) => {
  // Snapshot the logical position from the OLD view while it's still mounted.
  const paneEl = document.querySelector(`[data-pane-id="${props.paneId}"]`);
  const savedLine = paneEl ? getCurrentTopLine(paneEl, oldMode) : null;
  // 100ms matches the existing settle window before bindScrollSync.
  await new Promise((r) => setTimeout(r, 100));
  if (savedLine != null) {
    const newPaneEl = document.querySelector(`[data-pane-id="${props.paneId}"]`);
    if (newPaneEl) restoreToLine(newPaneEl, newMode, savedLine);
  }
  bindScrollSync();
});

watch(() => props.tab?.id, async () => {
  await new Promise((r) => setTimeout(r, 100));
  bindScrollSync();
});

onMounted(() => {
  setTimeout(bindScrollSync, 300);
  window.addEventListener('solomd:outline-goto', onOutlineGotoEvent);
  window.addEventListener('solomd:insert-markdown', onInsertMarkdownEvent);
  window.addEventListener('solomd:insert-image-path', onInsertImagePathEvent);
  window.addEventListener('solomd:preview-search', onPreviewSearchEvent);
});

onBeforeUnmount(() => {
  syncEditorScroll?.();
  syncPreviewScroll?.();
  window.removeEventListener('solomd:outline-goto', onOutlineGotoEvent);
  window.removeEventListener('solomd:insert-markdown', onInsertMarkdownEvent);
  window.removeEventListener('solomd:insert-image-path', onInsertImagePathEvent);
  window.removeEventListener('solomd:preview-search', onPreviewSearchEvent);
});

defineExpose({ gotoLine, editorRef });

function onOutlineGotoEvent(e: Event) {
  const { line, paneId } = (e as CustomEvent).detail;
  if (paneId !== props.paneId) return;
  gotoLine(line);
}

function onInsertMarkdownEvent(e: Event) {
  const { snippet, paneId } = (e as CustomEvent).detail;
  if (paneId !== props.paneId) return;
  const ed = editorRef.value as unknown as { insertMarkdown?: (s: string) => void } | null;
  ed?.insertMarkdown?.(snippet);
}

function onInsertImagePathEvent(e: Event) {
  const { path, paneId } = (e as CustomEvent).detail;
  if (paneId !== props.paneId) return;
  const ed = editorRef.value as unknown as { insertImageFromPath?: (p: string) => void } | null;
  ed?.insertImageFromPath?.(path);
}

function onPreviewSearchEvent(e: Event) {
  const { paneId } = (e as CustomEvent).detail;
  if (paneId !== props.paneId) return;
  (previewRef.value as unknown as { openSearch?: () => void } | null)?.openSearch?.();
}
</script>

<template>
  <div class="pane-content">
    <div class="pane pane--editor" v-if="showEditor && tab">
      <Editor
        ref="editorRef"
        :tab="tab"
        :focus-mode="settings.focusMode"
        :typewriter-mode="settings.typewriterMode"
        :spell-check="settings.spellCheck"
        @cursor="onCursor"
        @selection="onSelection"
      />
    </div>
    <div class="pane pane--preview" v-if="showPreview && tab">
      <Preview
        ref="previewRef"
        :source="tab.content"
        :file-path="tab.filePath"
        :tab-id="tab.id"
      />
    </div>
  </div>
</template>

<style scoped>
.pane-content {
  flex: 1;
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.pane {
  flex: 1;
  min-width: 0;
  height: 100%;
}
.pane--editor + .pane--preview {
  border-left: 1px solid var(--border);
}
</style>
