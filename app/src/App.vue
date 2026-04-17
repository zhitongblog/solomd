<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, watchEffect, computed, provide } from 'vue';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize, LogicalPosition } from '@tauri-apps/api/window';
import Toolbar from './components/Toolbar.vue';
import TabBar from './components/TabBar.vue';
import Editor from './components/Editor.vue';
import Preview from './components/Preview.vue';
import StatusBar from './components/StatusBar.vue';
import CommandPalette from './components/CommandPalette.vue';
import Outline from './components/Outline.vue';
import FileTree from './components/FileTree.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import MarkdownHelp from './components/MarkdownHelp.vue';
import GlobalSearch from './components/GlobalSearch.vue';
import AboutDialog from './components/AboutDialog.vue';
import UnsavedDialog from './components/UnsavedDialog.vue';
import Toast from './components/Toast.vue';
import { useTabsStore } from './stores/tabs';
import { useSettingsStore } from './stores/settings';
import { useFiles } from './composables/useFiles';
import { useShortcuts } from './composables/useShortcuts';
import { loadCustomTheme } from './lib/custom-theme';

const tabs = useTabsStore();
const settings = useSettingsStore();
const files = useFiles();

const cursorLine = ref(1);
const cursorCol = ref(1);
const paletteOpen = ref(false);
const settingsOpen = ref(false);
const helpOpen = ref(false);
const searchOpen = ref(false);
const aboutOpen = ref(false);

// Unsaved-changes dialog state
const unsavedOpen = ref(false);
const unsavedMode = ref<'tab' | 'window'>('tab');
const unsavedFileName = ref('');
const unsavedCount = ref(0);
let unsavedResolve: ((action: 'save' | 'discard' | 'cancel') => void) | null = null;

function showUnsavedDialog(mode: 'tab' | 'window', fileName: string, count: number): Promise<'save' | 'discard' | 'cancel'> {
  unsavedMode.value = mode;
  unsavedFileName.value = fileName;
  unsavedCount.value = count;
  unsavedOpen.value = true;
  return new Promise((resolve) => {
    unsavedResolve = resolve;
  });
}
function onUnsavedAction(action: 'save' | 'discard' | 'cancel') {
  unsavedOpen.value = false;
  if (unsavedResolve) {
    unsavedResolve(action);
    unsavedResolve = null;
  }
}

// Expose to child composables (useFiles) via provide/inject
provide('showUnsavedDialog', showUnsavedDialog);
// Also expose globally so non-component callers (shortcuts, menu events)
// can use it. inject() only works inside a component setup, and useFiles()
// is called from multiple places — some without an injection context.
(window as any).__solomd_showUnsavedDialog = showUnsavedDialog;
const editorRef = ref<InstanceType<typeof Editor> | null>(null);

useShortcuts({
  openPalette: () => (paletteOpen.value = true),
  openSettings: () => (settingsOpen.value = true),
  openHelp: () => (helpOpen.value = true),
  openGlobalSearch: () => (searchOpen.value = true),
});

// Esc closes the topmost modal
function onEsc(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  if (aboutOpen.value) aboutOpen.value = false;
  else if (searchOpen.value) searchOpen.value = false;
  else if (helpOpen.value) helpOpen.value = false;
  else if (paletteOpen.value) paletteOpen.value = false;
  else if (settingsOpen.value) settingsOpen.value = false;
}

function onCursor(line: number, col: number) {
  cursorLine.value = line;
  cursorCol.value = col;
}

function onOutlineGoto(line: number) {
  editorRef.value?.gotoLine(line);
}

import { dataThemeFor } from './lib/themes';

// Auto-persist tabs (list + active + per-tab content) on every change.
// Crash recovery + "close without saving" both depend on this.
watch(
  () => [tabs.tabs.map((t) => [t.id, t.fileName, t.filePath, t.content, t.savedContent, t.language].join('|')).join(';'), tabs.activeId],
  () => tabs.persist(),
  { deep: false },
);

// UI font size — applied via CSS var on <html> for all components to inherit.
watchEffect(() => {
  document.documentElement.style.setProperty('--ui-font-size', `${settings.uiFontSize}px`);
});

// Sync native menu bar language with settings (macOS top bar + Linux app menu).
watchEffect(() => {
  invoke('set_menu_language', { lang: settings.language }).catch(() => {});
  // Also persist to a file Rust reads on next launch — this is needed
  // because NSUserDefaults "AppleLanguages" only takes effect at app
  // startup (before AppKit loads), so native dialogs in the current
  // session still show the language active at launch time.
  invoke('save_language_preference', { lang: settings.language }).catch(() => {});
});

watchEffect(() => {
  document.documentElement.setAttribute('data-theme', dataThemeFor(settings.theme));
});

// Apply custom CSS theme whenever the path changes (and on first load).
watch(
  () => settings.customCssPath,
  (path) => {
    loadCustomTheme(path);
  },
  { immediate: true }
);

function onOpenHelpEvent() {
  helpOpen.value = true;
}
function onOpenSearchEvent() {
  searchOpen.value = true;
}

let unlistenOpened: UnlistenFn | null = null;
let unlistenMenu: UnlistenFn | null = null;

function dispatchMenuAction(id: string) {
  switch (id) {
    case 'file.new':
      files.newFile();
      break;
    case 'file.newText':
      files.newTextFile();
      break;
    case 'file.open':
      files.openFile();
      break;
    case 'file.openFolder':
      files.openFolder();
      break;
    case 'file.save':
      files.saveActive();
      break;
    case 'file.saveAs':
      files.saveActiveAs();
      break;
    case 'file.closeTab':
      if (tabs.activeId) files.closeTabSafe(tabs.activeId);
      break;
    case 'window.new':
      window.dispatchEvent(new CustomEvent('solomd:new-window'));
      break;
    case 'view.toggleTheme':
      settings.toggleTheme();
      break;
    case 'view.toggleFileTree':
      settings.toggleFileTree();
      break;
    case 'view.toggleOutline':
      settings.toggleOutline();
      break;
    case 'view.cycleView':
      settings.cycleViewMode();
      break;
    case 'view.cmdPalette':
      paletteOpen.value = true;
      break;
    case 'view.settings':
      settingsOpen.value = true;
      break;
    case 'search.global':
      searchOpen.value = true;
      break;
    case 'help.markdown':
      helpOpen.value = true;
      break;
    case 'help.about':
      aboutOpen.value = true;
      break;
    default:
      console.warn('unknown menu action', id);
  }
}

// ---- Window size + position persistence ----
const WINDOW_LS_KEY = 'solomd.window.v1';
interface SavedWindow { w: number; h: number; x?: number; y?: number }

async function restoreWindowSize() {
  try {
    const raw = localStorage.getItem(WINDOW_LS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw) as SavedWindow;
    if (typeof s.w !== 'number' || typeof s.h !== 'number') return;
    const win = getCurrentWindow();
    await win.setSize(new LogicalSize(s.w, s.h));
    if (typeof s.x === 'number' && typeof s.y === 'number') {
      await win.setPosition(new LogicalPosition(s.x, s.y));
    }
  } catch {}
}

async function saveWindowSize() {
  try {
    const win = getCurrentWindow();
    const scale = await win.scaleFactor();
    const phySize = await win.innerSize();
    const phyPos = await win.outerPosition();
    const s: SavedWindow = {
      w: phySize.width / scale,
      h: phySize.height / scale,
      x: phyPos.x / scale,
      y: phyPos.y / scale,
    };
    localStorage.setItem(WINDOW_LS_KEY, JSON.stringify(s));
  } catch {}
}

let saveWindowDebounce: number | undefined;
function scheduleSaveWindow() {
  if (saveWindowDebounce) clearTimeout(saveWindowDebounce);
  saveWindowDebounce = window.setTimeout(saveWindowSize, 400);
}

onMounted(async () => {
  window.addEventListener('keydown', onEsc);
  window.addEventListener('solomd:open-help', onOpenHelpEvent as EventListener);
  window.addEventListener('solomd:open-global-search', onOpenSearchEvent as EventListener);

  // Restore window size from last session (before any UI activity)
  await restoreWindowSize();

  // Persist on resize / move (debounced)
  try {
    const win = getCurrentWindow();
    await win.onResized(scheduleSaveWindow);
    await win.onMoved(scheduleSaveWindow);
  } catch {}

  // OS file association: when a file is passed via CLI / double-click,
  // runner.rs emits "solomd://opened-file" with the path string.
  try {
    unlistenOpened = await listen<string>('solomd://opened-file', async (e) => {
      if (e.payload) await files.openPath(e.payload);
    });
  } catch (err) {
    console.warn('opened-file listener not available', err);
  }

  // Drain any files queued by the backend BEFORE this listener was
  // set up (cold start from double-click on macOS / CLI args elsewhere).
  // This must happen before we decide whether to create a blank tab.
  try {
    const pending = await invoke<string[]>('drain_pending_opens');
    for (const p of pending || []) {
      await files.openPath(p);
    }
  } catch (err) {
    console.warn('drain_pending_opens failed', err);
  }

  // Only create a blank Untitled tab if nothing was restored AND nothing
  // was opened from the OS file-association path.
  if (tabs.tabs.length === 0) tabs.newTab();

  // Window close: Rust intercepts CloseRequested and emits this event.
  // We check unsaved tabs and either force-close or let the user cancel.
  // (JS onCloseRequested was broken on macOS, so we do it from Rust.)
  // Window close: no prompt. The user's unsaved work is persisted by
  // session restore (auto-save every 500ms) AND the tabs store (localStorage).
  // Next launch rehydrates everything, so closing is always safe.
  try {
    await listen('solomd://close-requested', async () => {
      // Ensure latest state is persisted before quitting.
      tabs.persist?.();
      await invoke('force_close_window');
    });
  } catch (err) {
    console.warn('close-requested listener failed', err);
  }

  // Native menu bar: runner.rs emits "solomd://menu" with the item id.
  try {
    unlistenMenu = await listen<string>('solomd://menu', (e) => {
      if (e.payload) dispatchMenuAction(e.payload);
    });
  } catch (err) {
    console.warn('menu listener not available', err);
  }

  // Drag-drop file open via Tauri's webview events.
  // For images we route through the editor's image-insert pipeline (copy
  // into _assets/ and insert markdown link). For everything else we open
  // the file as a new tab via the normal file pipeline.
  try {
    const webview = getCurrentWebview();
    await webview.onDragDropEvent(async (event) => {
      if (event.payload.type === 'drop') {
        for (const path of event.payload.paths) {
          if (isImagePath(path)) {
            try {
              await editorRef.value?.insertImageFromPath(path);
            } catch (err) {
              console.error('image insert failed', err);
            }
          } else {
            await files.openPath(path);
          }
        }
      }
    });
  } catch (e) {
    console.warn('drag-drop not available', e);
  }

  // Initial scroll sync (after panes are rendered)
  await new Promise((r) => setTimeout(r, 300));
  bindScrollSync();

  // Auto-check for updates (once per 24h if enabled)
  if (settings.autoCheckUpdate) {
    try {
      const { checkForUpdateOnStartup, openReleaseUrl } = await import('./lib/check-update');
      const result = await checkForUpdateOnStartup();
      if (result && result.hasUpdate) {
        const toastsStore = (await import('./stores/toasts')).useToastsStore();
        const { useI18n } = await import('./i18n');
        const { t: tr } = useI18n();
        toastsStore.success(tr('settings.updateAvailable', { version: result.latest || '' }), 8000);
        setTimeout(() => openReleaseUrl(result.url), 3000);
      }
    } catch { /* silent */ }
  }
});

const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp',
  'tiff', 'tif', 'heic', 'heif', 'avif', 'ico',
]);

function isImagePath(p: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  if (!m) return false;
  return IMAGE_EXTS.has(m[1].toLowerCase());
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onEsc);
  window.removeEventListener('solomd:open-help', onOpenHelpEvent as EventListener);
  window.removeEventListener('solomd:open-global-search', onOpenSearchEvent as EventListener);
  if (unlistenOpened) {
    unlistenOpened();
    unlistenOpened = null;
  }
  if (unlistenMenu) {
    unlistenMenu();
    unlistenMenu = null;
  }
});

// ---- Split-pane scroll sync (line-based) ----
// Uses data-source-line attributes injected by markdown-it to map editor
// viewport lines → preview DOM elements, so the same logical content line
// stays aligned across both panes (content-level sync, not just percentage).
let syncEditorScroll: (() => void) | null = null;
let syncPreviewScroll: (() => void) | null = null;
let syncGuard = false;

function getCMViewLine(editor: HTMLElement): number | null {
  // Find the CodeMirror line closest to the top of the viewport.
  const lines = editor.querySelectorAll('.cm-line');
  if (!lines.length) return null;
  const top = editor.getBoundingClientRect().top;
  for (let i = 0; i < lines.length; i++) {
    const rect = (lines[i] as HTMLElement).getBoundingClientRect();
    if (rect.bottom >= top) {
      // i is 0-indexed within visible lines — but CodeMirror only renders
      // visible lines, so we need the actual line number from the CM state.
      // Fallback: use the ratio (fraction of visible lines) * doc total.
      return i + 1; // will be corrected via editorRef below
    }
  }
  return lines.length;
}

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

  const editor = document.querySelector('.pane--editor .cm-scroller') as HTMLElement | null;
  const preview = document.querySelector('.pane--preview .preview-host') as HTMLElement | null;
  if (!editor || !preview) return;

  const onEditorScroll = () => {
    if (syncGuard) return;
    // Prefer exact line from CM if available via ref
    const cmRef = editorRef.value as any;
    let currentLine: number | null = null;
    if (cmRef?.getViewLine) {
      currentLine = cmRef.getViewLine();
    }
    if (!currentLine) {
      currentLine = getCMViewLine(editor);
    }
    if (!currentLine) return;

    const previewLines = getPreviewElementsByLine(preview);
    const entry = findNearestEntry(previewLines, currentLine);
    if (!entry) {
      // No mapped element — fall back to percentage
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
    if (syncGuard) return;
    const previewLines = getPreviewElementsByLine(preview);
    const wrapTop = preview.getBoundingClientRect().top;
    // Find the first element whose top is below the viewport top
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
  syncEditorScroll = () => editor.removeEventListener('scroll', onEditorScroll);
  syncPreviewScroll = () => preview.removeEventListener('scroll', onPreviewScroll);
}

watch(() => settings.viewMode, async () => {
  await new Promise((r) => setTimeout(r, 100)); // wait for DOM to update
  bindScrollSync();
}, { immediate: false });

watch(() => tabs.activeId, async () => {
  await new Promise((r) => setTimeout(r, 100));
  bindScrollSync();
});

const showEditor = computed(
  () => tabs.activeTab?.language !== 'markdown' || settings.viewMode !== 'preview'
);
const showPreview = computed(
  () => tabs.activeTab?.language === 'markdown' && settings.viewMode !== 'edit'
);
const showOutlinePane = computed(
  () => settings.showOutline && tabs.activeTab?.language === 'markdown'
);
</script>

<template>
  <div class="app">
    <Toolbar
      @open-palette="paletteOpen = true"
      @open-settings="settingsOpen = true"
      @open-help="helpOpen = true"
      @open-search="searchOpen = true"
    />
    <TabBar />
    <div class="workspace">
      <FileTree v-if="settings.showFileTree" />
      <Outline v-if="showOutlinePane" :cursor-line="cursorLine" @goto="onOutlineGoto" />
      <div class="content">
        <div class="pane pane--editor" v-if="showEditor && tabs.activeTab">
          <Editor
            ref="editorRef"
            :tab="tabs.activeTab"
            :focus-mode="settings.focusMode"
            :typewriter-mode="settings.typewriterMode"
            :spell-check="settings.spellCheck"
            @cursor="onCursor"
          />
        </div>
        <div class="pane pane--preview" v-if="showPreview && tabs.activeTab">
          <Preview :source="tabs.activeTab.content" :file-path="tabs.activeTab.filePath" />
        </div>
      </div>
    </div>
    <StatusBar :line="cursorLine" :col="cursorCol" />

    <CommandPalette :open="paletteOpen" @close="paletteOpen = false" />
    <SettingsPanel :open="settingsOpen" @close="settingsOpen = false" />
    <MarkdownHelp :open="helpOpen" @close="helpOpen = false" />
    <GlobalSearch :open="searchOpen" @close="searchOpen = false" />
    <AboutDialog :open="aboutOpen" @close="aboutOpen = false" />
    <UnsavedDialog
      :open="unsavedOpen"
      :mode="unsavedMode"
      :file-name="unsavedFileName"
      :count="unsavedCount"
      @save="onUnsavedAction('save')"
      @discard="onUnsavedAction('discard')"
      @cancel="onUnsavedAction('cancel')"
    />
    <Toast />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background: var(--bg);
  color: var(--text);
}
.workspace {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}
.content {
  flex: 1;
  display: flex;
  min-width: 0;
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
