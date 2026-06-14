<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icons.vue';
import PomodoroPopover from './PomodoroPopover.vue';
import { useTabsStore } from '../stores/tabs';
import { useSettingsStore } from '../stores/settings';
import { useWorkspaceStore } from '../stores/workspace';
import { useTilesStore } from '../stores/tiles';
import { track } from '../lib/telemetry';
import { useFiles } from '../composables/useFiles';
import { useExport } from '../composables/useExport';
import { useToastsStore } from '../stores/toasts';
import { cleanAIArtifacts } from '../lib/clean-ai';
import { useI18n } from '../i18n';
import { openPath } from '@tauri-apps/plugin-opener';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { isIOS, isMacOS } from '../lib/platform';
import { IS_APP_STORE_BUILD } from '../lib/app-build';
import { EditorView } from '@codemirror/view';

const { t } = useI18n();

defineEmits<{
  (e: 'open-palette'): void;
  (e: 'open-settings'): void;
  (e: 'open-help'): void;
  (e: 'open-search'): void;
}>();

const tabs = useTabsStore();
const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const tiles = useTilesStore();
const files = useFiles();
const exporter = useExport();
const toasts = useToastsStore();

const isMarkdown = computed(() => tabs.activeTab?.language === 'markdown');

// v4.6 unified title bar (macOS only). With `titleBarStyle: "Overlay"` in
// tauri.conf, the red/yellow/green traffic lights float over the top-left of
// our toolbar instead of sitting in a separate native title bar above it —
// one combined bar (Tolaria-style). We reserve ~72px on the left for them and
// make the bar background draggable. Windows / Linux keep native decorations
// and get neither the pad nor the drag region. Computed once at module init
// (platform doesn't change at runtime).
const macTitleBar = isMacOS();

/**
 * v2.5 F6 — open the CJK proofread panel. App.vue listens for this
 * event (same pattern as `solomd:open-help` / `solomd:open-settings`).
 */
function onOpenCjkProofread() {
  window.dispatchEvent(new CustomEvent('solomd:open-cjk-proofread'));
}

function onCleanAI() {
  const t = tabs.activeTab;
  if (!t) {
    toasts.warning('No active document');
    return;
  }
  const cleaned = cleanAIArtifacts(t.content);
  if (cleaned === t.content) {
    toasts.info('No AI artifacts found');
    return;
  }
  tabs.setContent(t.id, cleaned);
  toasts.success('AI artifacts cleaned');
}

/**
 * Toolbar entry for v2.0 F4. Mirrors the Cmd+J keyboard binding —
 * builders the same `solomd:ai-rewrite-open` event off the active editor's
 * selection so both routes funnel into AIRewriteOverlay.
 */
function onAIRewrite() {
  const t = tabs.activeTab;
  if (!t) {
    toasts.warning('No active document');
    return;
  }
  if (!settings.aiEnabled) {
    toasts.info(t === undefined ? '' : 'Enable AI rewrite in Settings first (⌘,)');
    // AI settings live under the `integrations` category in
    // SettingsPanel; pass section via event detail so the panel jumps
    // there directly instead of opening at the default `basics` tab.
    window.dispatchEvent(
      new CustomEvent('solomd:open-settings', { detail: { section: 'integrations' } }),
    );
    return;
  }
  // Read selection from the focused CodeMirror view. We REFUSE to fall back
  // to the whole document — silently translating the entire file is almost
  // never what the user wants, and the overlay's accept path replaces using
  // the editor's current selection anyway, so a "whole doc" toolbar fire
  // would either replace the whole doc on accept (data loss surprise) or
  // splice the translation at the cursor (also surprising). Force explicit
  // selection.
  //
  // #95 fix: don't require .cm-focused. The user's complaint was that
  // after closing the rewrite overlay and clicking the toolbar button
  // again, "Select some text first" fired even though the selection
  // box was clearly still visible. The overlay's close path returns
  // focus to the editor on the next tick, so by the time the button
  // click event reaches this handler the .cm-focused class is briefly
  // absent — but the DOM Selection is unchanged. Accept any .cm-editor
  // on the page; the selection check below is what matters.
  // Read the selection from CodeMirror's state — NOT window.getSelection().
  // On Windows WebView2 the DOM Selection comes back empty for the CM editor
  // (its drawSelection-managed selection isn't exposed via getSelection), so
  // the old read made AI rewrite wrongly report "Select some text first" even
  // with text selected. CM state is the source of truth and matches the ⌘J
  // path (cm-ai-rewrite.ts dispatchOpen). Also lets us pass the real from/to
  // instead of 0/0.
  const editors = [
    document.querySelector<HTMLElement>('.cm-editor.cm-focused'),
    ...Array.from(document.querySelectorAll<HTMLElement>('.cm-editor')),
  ].filter((e): e is HTMLElement => e != null);
  let picked: { selection: string; from: number; to: number } | null = null;
  for (const el of editors) {
    const view = EditorView.findFromDOM(el);
    if (!view) continue;
    const main = view.state.selection.main;
    if (main.empty) continue;
    const text = view.state.sliceDoc(main.from, main.to);
    if (text.trim()) {
      picked = { selection: text, from: main.from, to: main.to };
      break;
    }
  }
  if (!picked) {
    toasts.info('Select some text first, then click AI rewrite (or press ⌘J).');
    return;
  }
  window.dispatchEvent(
    new CustomEvent('solomd:ai-rewrite-open', { detail: picked }),
  );
}

async function onOpenExternal() {
  const path = tabs.activeTab?.filePath;
  if (!path) {
    toasts.warning(t('toast.openExternalNoFile'));
    return;
  }
  // iOS: tauri-plugin-opener calls UIApplication.shared.open(URL:) which
  // doesn't handle `file://` URLs — and the JS plugin's scope check
  // (`$HOME/**`) rejects paths from deep-linked Files-app sources before
  // we even get to the native call. Route through the Web Share API
  // instead — iOS 15+ WKWebView surfaces the standard iOS share sheet
  // (AirDrop / Messages / Mail / Files / iCloud) for File payloads.
  if (isIOS()) {
    const tab = tabs.activeTab;
    const fileName = path.split(/[\\/]/).pop() ?? 'note.md';
    const content = tab?.content ?? '';
    try {
      if (navigator.share && typeof File === 'function') {
        const mime = fileName.endsWith('.md') || fileName.endsWith('.markdown')
          ? 'text/markdown'
          : 'text/plain';
        const file = new File([content], fileName, { type: mime });
        const data: ShareData = { title: fileName, files: [file] };
        // Must call `canShare` as a method on `navigator` — destructuring
        // the reference drops `this`, and WebKit throws:
        //   "Can only call Navigator.canShare on instances of Navigator".
        const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
        if (!nav.canShare || nav.canShare(data)) {
          await navigator.share(data);
          return;
        }
      }
      if (navigator.share) {
        await navigator.share({ title: fileName, text: content });
        return;
      }
    } catch (e) {
      // AbortError = user cancelled the share sheet; not an error.
      const name = (e as { name?: string }).name;
      if (name === 'AbortError') return;
      toasts.warning(`Share failed: ${e}`);
      return;
    }
    toasts.info('Sharing not supported on this iOS version');
    return;
  }
  try {
    await openPath(path);
  } catch (e) {
    toasts.warning(`Failed: ${e}`);
  }
}

const recentOpen = ref(false);
const exportOpen = ref(false);
const newOpen = ref(false);
const insertOpen = ref(false);
const pomoOpen = ref(false);

const newBtnRef = ref<HTMLElement | null>(null);
const recentBtnRef = ref<HTMLElement | null>(null);
const exportBtnRef = ref<HTMLElement | null>(null);
const insertBtnRef = ref<HTMLElement | null>(null);
const menuPos = ref<{ top: number; left?: number; right?: number } | null>(null);
const floatStyle = computed<Record<string, string | number> | undefined>(() => {
  if (!menuPos.value) return undefined;
  const s: Record<string, string | number> = {
    position: 'fixed',
    top: `${menuPos.value.top}px`,
    zIndex: 1000,
  };
  if (menuPos.value.left !== undefined) s.left = `${menuPos.value.left}px`;
  if (menuPos.value.right !== undefined) s.right = `${menuPos.value.right}px`;
  return s;
});
function positionMenuFromButton(btn: HTMLElement | null, align: 'left' | 'right' = 'left') {
  if (!btn) { menuPos.value = null; return; }
  const rect = btn.getBoundingClientRect();
  if (align === 'right') {
    menuPos.value = { top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) };
  } else {
    menuPos.value = { top: rect.bottom + 4, left: Math.min(rect.left, window.innerWidth - 16) };
  }
}

function togglePomo() {
  // Mirror the same exclusive-open behaviour as the other dropdowns.
  closeAllDropdowns();
  pomoOpen.value = !pomoOpen.value;
}

function dispatchInsert(snippet: string) {
  window.dispatchEvent(
    new CustomEvent('solomd:insert-markdown', {
      detail: { snippet, paneId: tiles.focusedPaneId },
    })
  );
  insertOpen.value = false;
}

async function pickAndInsertImage() {
  insertOpen.value = false;
  const sel = await openFileDialog({
    multiple: false,
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tiff'] },
    ],
  });
  if (typeof sel !== 'string') return;
  window.dispatchEvent(
    new CustomEvent('solomd:insert-image-path', {
      detail: { path: sel, paneId: tiles.focusedPaneId },
    }),
  );
}

function shortPath(p: string) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// Close any open dropdown when user clicks outside.
// More reliable than @blur which doesn't fire consistently across browsers.
function closeAllDropdowns() {
  newOpen.value = false;
  recentOpen.value = false;
  exportOpen.value = false;
  insertOpen.value = false;
  pomoOpen.value = false;
}
// Exclusive open: opening one dropdown closes others.
function toggleDropdown(name: 'new' | 'recent' | 'export' | 'insert') {
  const isOpen =
    (name === 'new' && newOpen.value) ||
    (name === 'recent' && recentOpen.value) ||
    (name === 'export' && exportOpen.value) ||
    (name === 'insert' && insertOpen.value);
  closeAllDropdowns();
  if (!isOpen) {
    if (name === 'new') { positionMenuFromButton(newBtnRef.value); newOpen.value = true; }
    else if (name === 'recent') { positionMenuFromButton(recentBtnRef.value); recentOpen.value = true; }
    else if (name === 'export') { positionMenuFromButton(exportBtnRef.value); exportOpen.value = true; }
    else if (name === 'insert') { positionMenuFromButton(insertBtnRef.value); insertOpen.value = true; }
  }
}
function onDocClick(e: MouseEvent) {
  // Menus are teleported to <body>, so `.closest('.dropdown')` from a menu
  // item won't reach the original `.dropdown` wrapper — also check for the
  // menu's own marker class.
  const target = e.target as HTMLElement | null;
  if (target && (target.closest('.dropdown') || target.closest('.dropdown__menu'))) return;
  closeAllDropdowns();
}
function onViewportChange() {
  // Teleported menus position from the button's getBoundingClientRect at
  // open time; on resize / scroll those coords go stale.
  closeAllDropdowns();
}
onMounted(() => {
  document.addEventListener('click', onDocClick, true);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onViewportChange, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true);
  window.removeEventListener('resize', onViewportChange);
  window.removeEventListener('scroll', onViewportChange, true);
});
</script>

<template>
  <div
    class="toolbar"
    :class="{ 'toolbar--mac': macTitleBar }"
    :data-tauri-drag-region="macTitleBar ? '' : undefined"
  >
    <div
      class="toolbar__brand"
      :data-tauri-drag-region="macTitleBar ? '' : undefined"
    >
      <span class="brand__hash">#</span><span class="brand__md">MD</span>
    </div>

    <span
      v-if="tabs.activeTab?.fileName"
      class="toolbar__title"
      :title="tabs.activeTab?.filePath || tabs.activeTab?.fileName"
      :data-tauri-drag-region="macTitleBar ? '' : undefined"
    >{{ tabs.activeTab.fileName }}</span>

    <div class="toolbar__group">
      <div class="dropdown">
        <button
          ref="newBtnRef"
          class="icon-btn"
          @click="toggleDropdown('new')"
          :title="t('toolbar.newFile')"
        >
          <Icon name="new" />
          <Icon name="chevron-down" :size="10" />
        </button>
        <Teleport to="body">
          <div v-if="newOpen" class="dropdown__menu dropdown__menu--narrow" :style="floatStyle">
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="files.newFile(); newOpen = false">
              <Icon name="new" />
              <span class="dropdown__name">{{ t('toolbar.newMarkdown') }}</span>
              <span class="dropdown__shortcut">Ctrl+N</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="files.newTextFile(); newOpen = false">
              <Icon name="new-text" />
              <span class="dropdown__name">{{ t('toolbar.newPlainText') }}</span>
              <span class="dropdown__shortcut">Ctrl+Alt+N</span>
            </button>
          </div>
        </Teleport>
      </div>
      <button class="icon-btn" @click="files.openFile" :title="t('toolbar.openFileTooltip')">
        <Icon name="open" />
      </button>
      <div class="dropdown">
        <button
          ref="recentBtnRef"
          class="icon-btn"
          @click="toggleDropdown('recent')"
          :title="t('toolbar.recent')"
        >
          <Icon name="recent" />
          <Icon name="chevron-down" :size="10" />
        </button>
        <Teleport to="body">
          <div v-if="recentOpen" class="dropdown__menu" :style="floatStyle">
            <div v-if="!workspace.recentFiles.length" class="dropdown__empty">{{ t('toolbar.noRecent') }}</div>
            <button
              v-for="p in workspace.recentFiles"
              :key="p"
              class="dropdown__item"
              @mousedown.prevent="files.openPath(p); recentOpen = false"
              :title="p"
            >
              <span class="dropdown__name">{{ shortPath(p) }}</span>
              <span class="dropdown__path">{{ p }}</span>
            </button>
            <div v-if="workspace.recentFiles.length" class="dropdown__sep"></div>
            <button
              v-if="workspace.recentFiles.length"
              class="dropdown__item dropdown__item--muted"
              @mousedown.prevent="workspace.clearRecent(); recentOpen = false"
            >{{ t('toolbar.clearRecent') }}</button>
          </div>
        </Teleport>
      </div>
      <button class="icon-btn" @click="files.openFolder" v-bind:title="t('toolbar.openFolder')">
        <Icon name="folder" />
      </button>
      <button class="icon-btn" @click="files.saveActive" v-bind:title="t('toolbar.save') + ' (Ctrl+S)'">
        <Icon name="save" />
      </button>
      <button class="icon-btn" @click="files.saveActiveAs" :title="t('toolbar.saveAsTooltip')">
        <Icon name="save-as" />
      </button>
      <button class="icon-btn" @click="onOpenExternal" :title="t('toolbar.openExternalTooltip')">
        <Icon name="external" />
      </button>
      <div class="dropdown">
        <button
          ref="exportBtnRef"
          class="icon-btn"
          @click="toggleDropdown('export')"
          :title="t('toolbar.exportTooltip')"
        >
          <Icon name="export" />
          <Icon name="chevron-down" :size="10" />
        </button>
        <Teleport to="body">
          <div v-if="exportOpen" class="dropdown__menu" :style="floatStyle">
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.exportHtml(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.exportHtml') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.exportDocx(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.exportDocx') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.exportPdf(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.exportPdf') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.exportPdfPrint(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.exportPdfPrint') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.exportImage(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.exportImage') }}</span>
            </button>
            <div class="dropdown__sep"></div>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.copyAsHtml(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.copyHtml') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.copyAsPlainText(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.copyPlain') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.copyAsMarkdown(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.copyMarkdown') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.copyAsImage(); exportOpen = false">
              <span class="dropdown__name">{{ t('toolbar.copyImage') }}</span>
            </button>
          </div>
        </Teleport>
      </div>
    </div>

    <span class="toolbar__divider"></span>

    <div class="toolbar__group">
      <button
        class="icon-btn"
        @click="settings.toggleFileTree"
        :class="{ active: settings.showFileTree }"
        :title="t('toolbar.fileTreeTooltip')"
      >
        <Icon name="sidebar" />
      </button>
      <button
        class="icon-btn"
        @click="settings.toggleRightSidebar"
        :class="{ active: !settings.rightSidebarHidden }"
        :title="t('toolbar.rightSidebarTooltip')"
      >
        <Icon name="sidebar-right" />
      </button>
    </div>

    <div class="toolbar__group" v-if="isMarkdown">
      <div class="dropdown">
        <button
          ref="insertBtnRef"
          class="icon-btn"
          @click="toggleDropdown('insert')"
          :title="t('toolbar.insertTooltip')"
        >
          <Icon name="insert" />
          <Icon name="chevron-down" :size="10" />
        </button>
        <Teleport to="body">
          <div v-if="insertOpen" class="dropdown__menu" :style="floatStyle">
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('\n```\n$|$\n```\n')">
              <span class="dropdown__name">{{ t('toolbar.insertCodeBlock') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('`$|$`')">
              <span class="dropdown__name">{{ t('toolbar.insertInlineCode') }}</span>
            </button>
            <div class="dropdown__sep"></div>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('\n$$\n$|$\n$$\n')">
              <span class="dropdown__name">{{ t('toolbar.insertMathBlock') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('$$|$$')">
              <span class="dropdown__name">{{ t('toolbar.insertMathInline') }}</span>
            </button>
            <div class="dropdown__sep"></div>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('\n| $|$ | Header |\n| --- | --- |\n| cell | cell |\n')">
              <span class="dropdown__name">{{ t('toolbar.insertTable') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('\n```mermaid\ngraph TD\n  A[$|$] --> B[End]\n```\n')">
              <span class="dropdown__name">{{ t('toolbar.insertMermaid') }}</span>
            </button>
            <div class="dropdown__sep"></div>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('[$|$](url)')">
              <span class="dropdown__name">{{ t('toolbar.insertLink') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="pickAndInsertImage()">
              <span class="dropdown__name">{{ t('toolbar.insertImage') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('> $|$')">
              <span class="dropdown__name">{{ t('toolbar.insertQuote') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('\n---\n')">
              <span class="dropdown__name">{{ t('toolbar.insertDivider') }}</span>
            </button>
          </div>
        </Teleport>
      </div>
    </div>

    <div class="toolbar__group">
      <button
        class="icon-btn clean-ai-btn"
        @click="onCleanAI"
        v-bind:title="t('toolbar.cleanAiTitle')"
      >
        <span class="clean-ai-broom">🧹</span>
        <span class="clean-ai-label">AI</span>
      </button>
      <button
        v-if="!IS_APP_STORE_BUILD"
        class="icon-btn ai-rewrite-btn"
        @mousedown.prevent
        @click="onAIRewrite"
        :title="t('toolbar.aiRewriteTooltip')"
      >
        <span class="ai-rewrite-label">AI</span>
        <span class="ai-rewrite-spark">✨</span>
      </button>
    </div>

    <div
      class="toolbar__spacer"
      :data-tauri-drag-region="macTitleBar ? '' : undefined"
    ></div>

    <div class="toolbar__group" v-if="isMarkdown">
      <button
        class="icon-btn"
        @click="() => { settings.setViewMode('edit'); track('view_mode', { mode: 'edit' }); }"
        :class="{ active: settings.viewMode === 'edit' }"
        :title="t('toolbar.editOnly')"
      >
        <Icon name="view-edit" />
      </button>
      <button
        class="icon-btn"
        @click="() => { settings.setViewMode('split'); track('view_mode', { mode: 'split' }); }"
        :class="{ active: settings.viewMode === 'split' }"
        :title="t('toolbar.splitPane')"
      >
        <Icon name="view-split" />
      </button>
      <button
        class="icon-btn"
        @click="() => { settings.setViewMode('liveEdit'); track('view_mode', { mode: 'liveEdit' }); }"
        :class="{ active: settings.viewMode === 'liveEdit' }"
        :title="t('toolbar.liveEditMode')"
      >
        <Icon name="view-live" />
      </button>
      <button
        class="icon-btn"
        @click="() => { settings.setViewMode('preview'); track('view_mode', { mode: 'preview' }); }"
        :class="{ active: settings.viewMode === 'preview' }"
        :title="t('toolbar.previewOnly')"
      >
        <Icon name="view-preview" />
      </button>
      <button
        class="icon-btn"
        @click="() => { settings.setViewMode('reading'); track('view_mode', { mode: 'reading' }); }"
        :class="{ active: settings.viewMode === 'reading' }"
        :title="t('toolbar.readingMode')"
      >
        <Icon name="view-reading" />
      </button>
      <span
        class="toolbar__divider"
        v-if="settings.viewMode !== 'preview' && settings.viewMode !== 'liveEdit'"
      ></span>
      <button
        v-if="settings.viewMode !== 'preview' && settings.viewMode !== 'liveEdit'"
        class="icon-btn"
        @click="() => { settings.toggleLivePreview(); track('live_preview_toggled', { on: settings.livePreview ? 1 : 0 }); }"
        :class="{ active: settings.livePreview }"
        :title="settings.livePreview ? t('toolbar.livePreviewOn') : t('toolbar.livePreviewOff')"
      >
        <Icon :name="settings.livePreview ? 'live' : 'source'" />
      </button>
      <button
        v-if="settings.viewMode === 'split' || settings.viewMode === 'preview'"
        class="icon-btn"
        @click="settings.togglePreviewFitWidth"
        :class="{ active: settings.previewFitWidth }"
        :title="t('toolbar.fitWidthTooltip')"
      >
        <Icon name="fit-width" />
      </button>
    </div>

    <span v-if="isMarkdown" class="toolbar__divider"></span>

    <div class="toolbar__group">
      <div class="dropdown focus-with-pomo">
        <button
          class="icon-btn"
          :disabled="settings.viewMode === 'preview'"
          @click="settings.toggleFocusMode"
          :class="{ active: settings.focusMode }"
          :title="t('toolbar.focusModeTooltip')"
        >
          <Icon name="focus" />
        </button>
        <button
          v-if="settings.pomodoroShowControls"
          class="icon-btn pomo-chevron"
          @click="togglePomo"
          :title="t('pomodoro.openMenu')"
          aria-haspopup="dialog"
          :aria-expanded="pomoOpen"
        >
          <Icon name="chevron-down" :size="10" />
        </button>
        <PomodoroPopover :open="pomoOpen" @close="pomoOpen = false" />
      </div>
      <button
        class="icon-btn"
        :disabled="settings.viewMode === 'preview'"
        @click="settings.toggleTypewriterMode"
        :class="{ active: settings.typewriterMode }"
        :title="t('toolbar.typewriterTooltip')"
      >
        <Icon name="typewriter" />
      </button>
      <button
        class="icon-btn"
        :disabled="settings.viewMode === 'preview'"
        @click="settings.toggleSpellCheck"
        :class="{ active: settings.spellCheck }"
        :title="t('toolbar.spellCheckTooltip')"
      >
        <Icon name="spellcheck" />
      </button>
      <button
        class="icon-btn cjk-proof-btn"
        :disabled="settings.viewMode === 'preview'"
        @click="onOpenCjkProofread"
        :title="t('toolbar.cjkProofreadTooltip')"
      >
        <span class="cjk-proof-glyph">中</span>
      </button>
      <span class="toolbar__divider"></span>
      <button class="icon-btn" @click="$emit('open-search')" :title="t('toolbar.searchTooltip')">
        <Icon name="search" />
      </button>
      <button class="icon-btn" @click="$emit('open-palette')" :title="t('toolbar.paletteTooltip')">
        <Icon name="palette" />
      </button>
      <button class="icon-btn" @click="$emit('open-help')" :title="t('toolbar.helpTooltip')">
        <Icon name="help" />
      </button>
      <button class="icon-btn" @click="$emit('open-settings')" :title="t('toolbar.settingsTooltip')">
        <Icon name="settings" />
      </button>
      <button
        class="icon-btn"
        @click="() => { settings.toggleTheme(); track('theme_changed', { theme: settings.theme }); }"
        :title="settings.theme === 'dark' ? t('toolbar.lightMode') : t('toolbar.darkMode')"
      >
        <Icon :name="settings.theme === 'dark' ? 'theme-light' : 'theme-dark'" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--titlebar-h);
  padding: 0 12px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  user-select: none;
  /* NB: do NOT set overflow on this element. Each toolbar group hosts
     `.dropdown__menu` items via `position: absolute`, which need to
     escape this strip downward into the editor area. v3.6.0 added
     `overflow-x: auto` here to address Mac narrow-window clipping
     (issue #181) — but the browser then escalated overflow-y to
     auto/clip too, so every dropdown (New / Open / Insert / Copy /
     Export) was silently truncated and click events fell through to
     the editor below. v3.6.1 reverts the overflow rule; the original
     #181 fix needs to be redone with `<Teleport>` for dropdowns or a
     media-query-based group collapse. Tracked for v3.7. */
}
/* v4.6 unified title bar — macOS only. The native traffic-light buttons are
   overlaid at the top-left by `titleBarStyle: "Overlay"`; reserve room for
   them so they don't sit on top of the brand / New button. ~72px clears the
   three 12px lights + their inset. Windows / Linux keep native decorations
   and never get this class, so their toolbar starts flush-left as before. */
.toolbar--mac {
  padding-left: 72px;
}
.toolbar > * { flex-shrink: 0; }
.toolbar__brand {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.02em;
  margin-right: 4px;
}
/* Let drag events bubble up to .toolbar__brand (which carries the drag-region
   attr on macOS) — Tauri reads the exact mousedown target, so the inner spans
   must be click-through for the brand to be draggable. */
.brand__hash { color: var(--accent); pointer-events: none; }
.brand__md { color: var(--text); pointer-events: none; }

.toolbar__group {
  display: flex;
  gap: 1px;
  align-items: center;
}
.toolbar__group button {
  font-size: 12px;
  padding: 4px 10px;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
}
.toolbar__group button.active {
  background: var(--bg-active);
  color: var(--accent);
}
.icon-btn {
  padding: 5px 7px !important;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.icon-btn:hover {
  color: var(--text);
}
.icon-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.icon-btn:disabled:hover {
  color: var(--text-muted);
}
.clean-ai-btn {
  position: relative;
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 11px !important;
  padding: 3px 10px !important;
  border: 1px solid var(--border);
  border-radius: 6px;
  gap: 2px;
  color: var(--text-muted);
  transition: all 0.15s;
}
.clean-ai-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft, rgba(255, 159, 64, 0.08));
}
.clean-ai-label {
  letter-spacing: 0.04em;
}
.clean-ai-broom {
  font-size: 11px;
  opacity: 0.85;
  margin-right: 1px;
}
.ai-rewrite-btn {
  position: relative;
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 11px !important;
  padding: 3px 10px !important;
  border: 1px solid var(--border);
  border-radius: 6px;
  gap: 2px;
  color: var(--text-muted);
  transition: all 0.15s;
}
.ai-rewrite-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft, rgba(255, 159, 64, 0.08));
}
.ai-rewrite-label { letter-spacing: 0.04em; }
.ai-rewrite-spark { font-size: 11px; opacity: 0.85; margin-left: 2px; }

/* v2.5 F6 — CJK proofread toolbar button. Uses the literal "中"
 * glyph instead of an SVG icon: it telegraphs the feature's CJK
 * scope at a glance and matches Spell-check (a small icon-as-mark
 * style sits in the same toolbar group). */
.cjk-proof-btn {
  font-family: var(--font-zh, 'PingFang SC', 'Hiragino Sans GB', sans-serif);
  font-size: 13px !important;
  font-weight: 700;
  padding: 4px 8px !important;
  line-height: 1;
}
.cjk-proof-glyph {
  display: inline-block;
}

.toolbar__spacer { flex: 1 1 0; min-width: 0; }
/* Document title sits right after the #MD brand, mirroring a native window
   title (VSCode / macOS Notes style). min-width:0 + flex-shrink:1 lets it
   ellipsis-shrink on narrow windows instead of pushing tool groups off the
   right edge (overrides `.toolbar > * { flex-shrink: 0 }`). */
.toolbar__title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  margin-left: 4px;
  padding-right: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 280px;
  min-width: 0;
  flex-shrink: 1;
  cursor: default;
}
.toolbar__divider {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 4px;
}

.dropdown {
  position: relative;
}
.focus-with-pomo {
  display: inline-flex;
  align-items: center;
  gap: 0;
}
.pomo-chevron {
  padding: 5px 4px !important;
  color: var(--text-faint);
}
.pomo-chevron:hover { color: var(--text); }
.dropdown__menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 280px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--sh-pop);
  z-index: var(--z-pop);
  padding: 4px;
  max-height: 360px;
  overflow-y: auto;
}
.dropdown__menu--narrow {
  min-width: 200px;
}
.dropdown__item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  padding: 6px 10px;
  font-size: 12px;
  text-align: left;
  border-radius: 4px;
}
.dropdown__name {
  color: var(--text);
  font-weight: 500;
}
.dropdown__path {
  color: var(--text-faint);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}
.dropdown__shortcut {
  margin-left: auto;
  color: var(--text-faint);
  font-size: 10px;
  font-family: var(--font-mono);
}
.dropdown__item--muted {
  color: var(--text-muted);
  font-size: 11px;
}
.dropdown__item--single {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.dropdown__sep {
  height: 1px;
  background: var(--border);
  margin: 4px 6px;
}
.dropdown__empty {
  padding: 12px;
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
}
</style>
