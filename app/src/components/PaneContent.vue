<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import Editor from './Editor.vue';
import Preview from './Preview.vue';
import { useSettingsStore, clampSplitRatio, SPLIT_RATIO_MIN, SPLIT_RATIO_MAX } from '../stores/settings';
import { useI18n } from '../i18n';
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
const { t } = useI18n();

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

// Split view with live sync off: the preview renders what's on disk, so it
// only moves when the file is saved (manually or by autosave). A tab that
// has never been saved has nothing on disk yet — keep it live so the preview
// isn't blank. Other view modes always follow the buffer.
const previewSource = computed(() => {
  const tab = props.tab;
  if (!tab) return '';
  if (settings.viewMode !== 'split' || settings.splitLiveSync || !tab.filePath) {
    return tab.content;
  }
  return tab.savedContent;
});

const isFocused = computed(() => tiles.focusedPaneId === props.paneId);
const windowsEditorRuntime = isWindowsEditorRuntime();
// Preserve CodeMirror history/caret on macOS and Linux. Only Windows needs a
// remount because toggling Vim or the editor engine changes the editor
// implementation itself.
const editorImplementationKey = computed(() => {
  if (!windowsEditorRuntime) return `${props.paneId}:codemirror`;
  const plain = shouldUsePlainWindowsEditor(true, settings.vimMode, settings.windowsEditorEngine);
  return `${props.paneId}:${plain ? 'plain' : 'codemirror'}`;
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

// ---- #367 split divider ----
// Editor and preview both on screen → the divider between them is live and
// the editor takes `splitRatio`% of the width. Pointer events, not HTML5 DnD:
// the webview's native drag-drop handler swallows `draggable` drags.
const isSplit = computed(() => showEditor.value && showPreview.value);
const contentEl = ref<HTMLElement | null>(null);
// Live value while dragging; committed (and persisted) on pointerup so a drag
// writes localStorage once instead of on every pointermove.
const dragRatio = ref<number | null>(null);
const effectiveRatio = computed(() => dragRatio.value ?? settings.splitRatio);
const editorPaneStyle = computed(() =>
  isSplit.value ? { flex: `0 0 ${effectiveRatio.value}%` } : undefined,
);

function relayoutAfterResize() {
  window.dispatchEvent(new CustomEvent('solomd:relayout'));
}

// Ends the drag in progress, if any (also called on unmount).
let endDividerDrag: (() => void) | null = null;

function onDividerPointerDown(e: PointerEvent) {
  if (e.button !== 0 || !contentEl.value) return;
  e.preventDefault();
  endDividerDrag?.();
  const handle = e.currentTarget as HTMLElement;
  const rect = contentEl.value.getBoundingClientRect();
  if (rect.width <= 0) return;
  try { handle.setPointerCapture(e.pointerId); } catch {}
  handle.focus({ preventScroll: true });
  dragRatio.value = settings.splitRatio;
  document.body.classList.add('split-divider--dragging');

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    dragRatio.value = clampSplitRatio(((ev.clientX - rect.left) / rect.width) * 100);
  };
  // Listen on window, not just the captured handle, and treat a lost capture
  // as the end too: dragging past the clamp onto the file tree, Chrome was
  // seen dropping the capture right before pointerup and delivering the up to
  // the tree — a handle-only listener then left the drag stuck on.
  const onEnd = () => {
    endDividerDrag = null;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onEnd, true);
    window.removeEventListener('pointercancel', onEnd, true);
    handle.removeEventListener('lostpointercapture', onEnd);
    document.body.classList.remove('split-divider--dragging');
    const final = dragRatio.value;
    dragRatio.value = null;
    if (final != null && final !== settings.splitRatio) settings.setSplitRatio(final);
    relayoutAfterResize();
  };
  endDividerDrag = onEnd;
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onEnd, true);
  window.addEventListener('pointercancel', onEnd, true);
  handle.addEventListener('lostpointercapture', onEnd);
}

function resetSplitRatio() {
  settings.setSplitRatio(50);
  relayoutAfterResize();
}

function onDividerKeydown(e: KeyboardEvent) {
  const step = e.shiftKey ? 10 : 2;
  let next: number | null = null;
  if (e.key === 'ArrowLeft') next = settings.splitRatio - step;
  else if (e.key === 'ArrowRight') next = settings.splitRatio + step;
  else if (e.key === 'Home') next = SPLIT_RATIO_MIN;
  else if (e.key === 'End') next = SPLIT_RATIO_MAX;
  else if (e.key === 'Enter') next = 50;
  if (next == null) return;
  e.preventDefault();
  settings.setSplitRatio(next);
  relayoutAfterResize();
}

// ---- Pane-scoped scroll sync ----
let syncEditorScroll: (() => void) | null = null;
let syncPreviewScroll: (() => void) | null = null;
let syncGuard = false;
// Pane width changes (divider drag, sidebar resize, window resize) reflow both
// panes, so the line <-> pixel mapping the last scroll established is stale.
// Re-run the editor -> preview sync once per frame while the size changes.
let resizeObserver: ResizeObserver | null = null;

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
  resizeObserver?.disconnect();
  resizeObserver = null;

  if (settings.viewMode !== 'split' || !settings.splitLiveSync) return;

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

  if (typeof ResizeObserver !== 'undefined') {
    let raf = 0;
    let first = true;
    resizeObserver = new ResizeObserver(() => {
      // The initial callback fires on observe(); nothing has reflowed yet.
      if (first) { first = false; return; }
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (activePane) return;
        // At the very top the anchor math lands on the first heading, not on
        // the preview's own top padding — keep both panes flush instead.
        if (editor.scrollTop <= 0) {
          syncGuard = true;
          preview.scrollTop = 0;
          requestAnimationFrame(() => { syncGuard = false; });
          return;
        }
        onEditorScroll();
      });
    });
    resizeObserver.observe(editor);
    resizeObserver.observe(preview);
  }
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

watch(() => settings.splitLiveSync, bindScrollSync);

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
  window.addEventListener('solomd:edit-formula', onEditFormulaEvent);
});

onBeforeUnmount(() => {
  syncEditorScroll?.();
  syncPreviewScroll?.();
  resizeObserver?.disconnect();
  resizeObserver = null;
  document.body.classList.remove('split-divider--dragging');
  window.removeEventListener('solomd:outline-goto', onOutlineGotoEvent);
  window.removeEventListener('solomd:insert-markdown', onInsertMarkdownEvent);
  window.removeEventListener('solomd:insert-image-path', onInsertImagePathEvent);
  window.removeEventListener('solomd:insert-image-url', onInsertImageUrlEvent);
  window.removeEventListener('solomd:upload-local-images', onUploadLocalImagesEvent);
  window.removeEventListener('solomd:editor-find', onEditorFindEvent);
  window.removeEventListener('solomd:preview-search', onPreviewSearchEvent);
  window.removeEventListener('solomd:fold', onFoldEvent);
  window.removeEventListener('solomd:edit-table', onEditTableEvent);
  window.removeEventListener('solomd:edit-formula', onEditFormulaEvent);
});

defineExpose({ gotoLine, editorRef });

// #350 — preview mode has no editor cursor to follow, so hand the preview's
// reading position to the outline instead. Split mode keeps the cursor.
function onPreviewTopline(line: number) {
  if (settings.viewMode !== 'preview') return;
  window.dispatchEvent(new CustomEvent('solomd:preview-topline', {
    detail: { line, paneId: props.paneId },
  }));
}

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

/** Formula editor — same focused-pane routing as find. */
function onEditFormulaEvent(e: Event) {
  const { paneId } = (e as CustomEvent).detail || {};
  if (paneId && paneId !== props.paneId) return;
  if (!paneId && !isFocused.value) return;
  const ed = editorRef.value as unknown as { openFormulaAtCursor?: () => void } | null;
  ed?.openFormulaAtCursor?.();
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
  <!-- #279 — "现在都一样看着有点累": side by side, the two panes are the same
       surface, so the split reads as one wide column. The opt-in class lifts
       the preview a shade; it only applies when BOTH panes are on screen,
       because there is nothing to tell apart otherwise. -->
  <div
    ref="contentEl"
    class="pane-content"
    :class="{
      'pane-content--distinct': settings.distinctSplitPanes && showEditor && showPreview,
    }"
  >
    <div class="pane pane--editor" v-if="showEditor && tab" :style="editorPaneStyle">
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
    <!-- #367 — draggable divider between editor and preview. -->
    <div
      v-if="isSplit && tab"
      class="split-divider"
      :class="{ 'split-divider--active': dragRatio != null }"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      :aria-label="t('settings.splitDividerLabel')"
      :aria-valuenow="Math.round(effectiveRatio)"
      :aria-valuemin="SPLIT_RATIO_MIN"
      :aria-valuemax="SPLIT_RATIO_MAX"
      :title="t('rightSidebar.dragToResize')"
      @pointerdown="onDividerPointerDown"
      @dblclick="resetSplitRatio"
      @keydown="onDividerKeydown"
    />
    <div class="pane pane--preview" v-if="showPreview && tab">
      <Preview
        ref="previewRef"
        :source="previewSource"
        :file-path="tab.filePath"
        :tab-id="tab.id"
        @topline="onPreviewTopline"
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
  border-left: var(--bd-hair);
}
/* The divider is the line between the panes now; without this the preview
   host's own left border doubles it. */
.split-divider + .pane--preview :deep(.preview-host) {
  border-left: none;
}
/* #367 / 5.0 — a hairline with a small, always-visible grip in the middle
   (docs/v5-ui-spec.md, split board). 1px of layout so the editor's
   `splitRatio`% stays exact; the ::before is a 9px invisible hit zone. Hover
   and drag deepen the line and the grip rather than painting the accent —
   the divider is furniture, not a call to action. */
.split-divider {
  flex: 0 0 var(--hair-w, 1px);
  position: relative;
  z-index: 6;
  background: var(--hairline);
  cursor: col-resize;
  touch-action: none;
  outline: none;
  transition: background var(--dur-fast) var(--ease-out);
}
.split-divider::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -4px;
  right: -4px;
}
.split-divider::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 5px;
  height: 28px;
  transform: translate(-50%, -50%);
  border-radius: 3px;
  background: var(--fill-2);
  transition: background var(--dur-fast) var(--ease-out), height var(--dur-fast) var(--ease-out);
}
.split-divider:hover,
.split-divider--active {
  background: var(--fill-2);
}
.split-divider:hover::after,
.split-divider--active::after {
  background: var(--text-3);
  height: 36px;
}
.split-divider:focus-visible::after {
  background: var(--accent);
}
</style>
