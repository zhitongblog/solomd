<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import Editor from './Editor.vue';
import Preview from './Preview.vue';
import { useSettingsStore } from '../stores/settings';
import { useTilesStore } from '../stores/tiles';
import type { Tab } from '../types';
import { isWindowsEditorRuntime, shouldUsePlainWindowsEditor } from '../lib/platform';

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
const windowsEditorRuntime = isWindowsEditorRuntime();
// Preserve CodeMirror history/caret on macOS and Linux. Only Windows needs a
// remount because toggling Vim changes the editor implementation itself.
const editorImplementationKey = computed(() => {
  if (!windowsEditorRuntime) return `${props.paneId}:codemirror`;
  return `${props.paneId}:${shouldUsePlainWindowsEditor(true, settings.vimMode) ? 'plain' : 'vim'}`;
});

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

// Index of the last anchor at/before `line` (-1 when none). The anchor AFTER
// it brackets the viewport top, letting both sync directions interpolate
// between the two instead of snapping to the earlier one. Snapping kept the
// panes level only when an anchor sat exactly at the viewport top; anywhere
// inside a tall block (a long wrapped paragraph, an image) the panes were off
// by up to the block height difference — the 双栏内容上下错位 complaint.
function findAnchorIndex<T extends { line: number }>(list: T[], line: number): number {
  let lo = 0, hi = list.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].line <= line) { best = mid; lo = mid + 1; }
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
  // The editor's scroll container differs by platform: CodeMirror exposes
  // `.cm-scroller`, but on Windows the live editor is the native-textarea plain
  // editor (`usePlainWindowsEditor`, v4.7) which has no CodeMirror — it scrolls
  // via `.plain-editor` (source/split) or `.plain-block-editor` (live). Matching
  // only `.cm-scroller` silently dropped scroll-sync on Windows. The exposed
  // `getViewLine()` / `scrollToLine()` already handle both editor paths.
  const editor = paneEl.querySelector(
    '.pane--editor .cm-scroller, .pane--editor .plain-block-editor, .pane--editor .plain-editor',
  ) as HTMLElement | null;
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
    // Fractional: 12.5 = halfway down source line 12 (soft wrap included).
    let currentLine: number | null = null;
    if (cmRef?.getViewLine) {
      currentLine = cmRef.getViewLine();
    }
    if (!currentLine) return;

    const previewLines = getPreviewElementsByLine(preview);
    const idx = findAnchorIndex(previewLines, Math.floor(currentLine));
    if (idx < 0) {
      const emax = editor.scrollHeight - editor.clientHeight;
      const pmax = preview.scrollHeight - preview.clientHeight;
      if (emax > 0 && pmax > 0) {
        syncGuard = true;
        preview.scrollTop = (editor.scrollTop / emax) * pmax;
        requestAnimationFrame(() => { syncGuard = false; });
      }
      return;
    }
    const wrapRect = preview.getBoundingClientRect();
    const a = previewLines[idx];
    const aTop = a.el.getBoundingClientRect().top;
    // Interpolate toward the next anchor by the *pixel* fraction the editor
    // has scrolled between the two anchors' lines. Pixel fractions (rather
    // than source-line fractions) keep the panes level even when the blocks
    // between anchors have very different heights in each pane (tall wrapped
    // paragraphs, images).
    let target = aTop;
    const b = previewLines.find((e, i) => i > idx && e.line > a.line);
    if (b && currentLine > a.line) {
      let t: number | null = null;
      const yA = cmRef?.lineTopY ? cmRef.lineTopY(a.line) : null;
      const yB = cmRef?.lineTopY ? cmRef.lineTopY(b.line) : null;
      if (yA != null && yB != null && yB > yA) {
        t = Math.max(0, Math.min(1, (editor.scrollTop - yA) / (yB - yA)));
      } else {
        t = Math.min(1, (currentLine - a.line) / (b.line - a.line));
      }
      target = aTop + t * (b.el.getBoundingClientRect().top - aTop);
    }
    syncGuard = true;
    preview.scrollTop += target - wrapRect.top - 8;
    requestAnimationFrame(() => { syncGuard = false; });
  };

  const onPreviewScroll = () => {
    if (syncGuard || activePane === 'editor') return;
    const cmRef = editorRef.value as any;
    const previewLines = getPreviewElementsByLine(preview);
    const wrapTop = preview.getBoundingClientRect().top + 8;
    // Bracket the viewport top between two anchors, take the pixel fraction
    // scrolled between them, and scroll the editor to the same fraction
    // between the anchors' source lines — the mirror of onEditorScroll.
    for (let i = 0; i < previewLines.length; i++) {
      const r = previewLines[i].el.getBoundingClientRect();
      if (r.bottom < wrapTop) continue;
      const a = previewLines[i];
      let targetLine: number = a.line;
      let t = 0;
      let b: { line: number } | null = null;
      if (r.top < wrapTop && i + 1 < previewLines.length) {
        const next = previewLines[i + 1];
        const bTop = next.el.getBoundingClientRect().top;
        t = bTop > r.top ? Math.min(1, (wrapTop - r.top) / (bTop - r.top)) : 0;
        b = next;
        targetLine = a.line + t * (next.line - a.line);
      }
      const yA = cmRef?.lineTopY ? cmRef.lineTopY(a.line) : null;
      const yB = b && cmRef?.lineTopY ? cmRef.lineTopY(b.line) : null;
      syncGuard = true;
      if (yA != null && (t === 0 || (yB != null && yB > yA))) {
        editor.scrollTop = Math.max(0, yA + (yB != null ? t * (yB - yA) : 0) - 8);
      } else if (cmRef?.scrollToLine) {
        cmRef.scrollToLine(targetLine);
      }
      requestAnimationFrame(() => { syncGuard = false; });
      break;
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
  window.addEventListener('solomd:insert-image-url', onInsertImageUrlEvent);
  window.addEventListener('solomd:upload-local-images', onUploadLocalImagesEvent);
  window.addEventListener('solomd:editor-find', onEditorFindEvent);
  window.addEventListener('solomd:preview-search', onPreviewSearchEvent);
  window.addEventListener('solomd:fold', onFoldEvent);
  window.addEventListener('solomd:edit-table', onEditTableEvent);
});

onBeforeUnmount(() => {
  syncEditorScroll?.();
  syncPreviewScroll?.();
  window.removeEventListener('solomd:outline-goto', onOutlineGotoEvent);
  window.removeEventListener('solomd:insert-markdown', onInsertMarkdownEvent);
  window.removeEventListener('solomd:insert-image-path', onInsertImagePathEvent);
  window.removeEventListener('solomd:insert-image-url', onInsertImageUrlEvent);
  window.removeEventListener('solomd:upload-local-images', onUploadLocalImagesEvent);
  window.removeEventListener('solomd:editor-find', onEditorFindEvent);
  window.removeEventListener('solomd:preview-search', onPreviewSearchEvent);
  window.removeEventListener('solomd:fold', onFoldEvent);
  window.removeEventListener('solomd:edit-table', onEditTableEvent);
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

function onInsertImageUrlEvent(e: Event) {
  const { url, alt, paneId } = (e as CustomEvent).detail;
  if (paneId !== props.paneId) return;
  const ed = editorRef.value as unknown as { insertImageUrl?: (u: string, a?: string) => void } | null;
  ed?.insertImageUrl?.(url, alt || '');
}

function onUploadLocalImagesEvent(e: Event) {
  const { paneId } = (e as CustomEvent).detail;
  if (paneId !== props.paneId) return;
  const ed = editorRef.value as unknown as { uploadLocalImages?: () => void } | null;
  ed?.uploadLocalImages?.();
}

function onEditorFindEvent(e: Event) {
  const { paneId } = (e as CustomEvent).detail || {};
  // No paneId → the focused pane handles it.
  if (paneId && paneId !== props.paneId) return;
  if (!paneId && !isFocused.value) return;
  const ed = editorRef.value as unknown as { openFind?: () => void } | null;
  ed?.openFind?.();
}

/** Grid table editor — same focused-pane routing as find. */
function onEditTableEvent(e: Event) {
  const { paneId } = (e as CustomEvent).detail || {};
  if (paneId && paneId !== props.paneId) return;
  if (!paneId && !isFocused.value) return;
  const ed = editorRef.value as unknown as { openTableAtCursor?: () => void } | null;
  ed?.openTableAtCursor?.();
}

/** Heading folding — same focused-pane routing as find (#fold). */
function onFoldEvent(e: Event) {
  const { paneId, action, level } = (e as CustomEvent).detail || {};
  if (paneId && paneId !== props.paneId) return;
  if (!paneId && !isFocused.value) return;
  const ed = editorRef.value as unknown as {
    applyFold?: (a: string, l?: number) => void;
  } | null;
  ed?.applyFold?.(action || 'toggle', level);
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
        :key="editorImplementationKey"
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
/* #168 phone layout for these panes lives in styles/main.css — a scoped
   block can't reach it: `:global(.x) .y` compiles down to `.x` here. */
.pane {
  flex: 1;
  min-width: 0;
  height: 100%;
}
.pane--editor + .pane--preview {
  border-left: 1px solid var(--border);
}
</style>
