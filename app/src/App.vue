<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, watchEffect, computed, provide, nextTick } from 'vue';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import Toolbar from './components/Toolbar.vue';
import TelemetryBanner from './components/TelemetryBanner.vue';
import TileRoot from './components/TileRoot.vue';
import StatusBar from './components/StatusBar.vue';
import CommandPalette from './components/CommandPalette.vue';
import QuickSwitcher from './components/QuickSwitcher.vue';
import Outline from './components/Outline.vue';
import BacklinksPanel from './components/BacklinksPanel.vue';
import NeighborhoodPanel from './components/NeighborhoodPanel.vue';
import RelationshipsPanel from './components/RelationshipsPanel.vue';
import TagsPanel from './components/TagsPanel.vue';
import TypesPanel from './components/TypesPanel.vue';
import HistoryPanel from './components/HistoryPanel.vue';
import PropertiesInspector from './components/PropertiesInspector.vue';
import AgentPanel from './components/AgentPanel.vue';
import RsSplitter from './components/RsSplitter.vue';
import { useAutoCommit } from './composables/useAutoCommit';
import { useGithubSync } from './composables/useGithubSync';
import { useSessionRestore } from './composables/useSessionRestore';
import SessionRestoreDialog from './components/SessionRestoreDialog.vue';
import WhiteboardOverlay from './components/WhiteboardOverlay.vue';
import AIRewriteOverlay from './components/AIRewriteOverlay.vue';
import BasesView from './components/BasesView.vue';
import { BASES_OPEN_EVENT, BASES_CLOSE_EVENT } from './composables/useBasesView';
import InboxView from './components/InboxView.vue';
import { INBOX_OPEN_EVENT, INBOX_CLOSE_EVENT } from './composables/useInboxView';
// v4.6.1 F2 — Type lens (center-pane filtered view of one type's members).
import TypeLensView from './components/TypeLensView.vue';
import { TYPE_LENS_OPEN_EVENT, TYPE_LENS_CLOSE_EVENT } from './composables/useTypeLens';
import FileTree from './components/FileTree.vue';
// v4.6 F5 — Saved filtered views (sidebar panel + filtered list + editor).
import ViewsPanel from './components/ViewsPanel.vue';
import ViewNoteList from './components/ViewNoteList.vue';
import ViewEditorDialog from './components/ViewEditorDialog.vue';
import { VIEW_OPEN_EVENT, VIEW_CLOSE_EVENT } from './composables/useSavedViews';
import SettingsPanel from './components/SettingsPanel.vue';
import MarkdownHelp from './components/MarkdownHelp.vue';
import GlobalSearch from './components/GlobalSearch.vue';
import RagSearch from './components/RagSearch.vue';
import CjkProofread from './components/CjkProofread.vue';
import ReadingView from './components/ReadingView.vue';
import AboutDialog from './components/AboutDialog.vue';
import AgentSetupWizard from './components/AgentSetupWizard.vue';
import UnsavedDialog from './components/UnsavedDialog.vue';
import FileChangedDialog from './components/FileChangedDialog.vue';
import Toast from './components/Toast.vue';
import { useTabsStore } from './stores/tabs';
import { useSettingsStore } from './stores/settings';
import { useWindowsStore, isAuxLabel } from './stores/windows';
import { useTilesStore } from './stores/tiles';
import { usePomodoroStore } from './stores/pomodoro';
import { useFiles } from './composables/useFiles';
import { useExport } from './composables/useExport';
import { useShortcuts } from './composables/useShortcuts';
import { useFileWatcher } from './composables/useFileWatcher';
import { loadCustomTheme } from './lib/custom-theme';
import { isIOS, isMacOS } from './lib/platform';
import { useI18n } from './i18n';
import { track } from './lib/telemetry';
import { openWelcomeTour } from './lib/welcome-tour';
import { useWorkspaceStore } from './stores/workspace';
import { useWorkspaceIndexStore } from './stores/workspaceIndex';
import { usePropertiesStore } from './stores/properties';
import { useRagStore } from './stores/rag';
import { IS_APP_STORE_BUILD } from './lib/app-build';
import UiPreview from './components/UiPreview.vue';

/* v4.6 dev-only UI gallery. `?uikit` renders ONLY the design-system preview
 * and skips the normal app, so the token layer can be eyeballed in isolation.
 * Pure read of location.search at module init — no effect on normal startup. */
const showUiKit = new URLSearchParams(location.search).has('uikit');

const tabs = useTabsStore();
const settings = useSettingsStore();
const windowsStore = useWindowsStore();
const tiles = useTilesStore();
const files = useFiles();
const exporter = useExport();
const workspace = useWorkspaceStore();
const workspaceIndex = useWorkspaceIndexStore();
const properties = usePropertiesStore();
const rag = useRagStore();
const autoCommit = useAutoCommit();
autoCommit.start();
// v2.6: GitHub sync rides on top of AutoGit — push commits AutoGit creates,
// pull on a timer. Dormant unless the workspace has a `.solomd/sync.json`.
const githubSync = useGithubSync();
githubSync.start();
// v2.6.1: session-restore listens for cloud-folder workspace changes and
// offers to pick up tabs from a sibling device when one is fresher.
const sessionRestore = useSessionRestore();
sessionRestore.start();
// v2.5 F4: pick up an in-progress focus session from before the reload.
// Fire-and-forget — the store handles the (rare) "session already past
// its end" case by short-circuiting into the completion path.
const pomodoro = usePomodoroStore();
pomodoro.rehydrate();
// Expose to the dev-bridge so the self-test harness can drive the store
// directly via window.usePomodoroStore() instead of fishing it out of
// Pinia internals. Dev-only convenience — release builds ignore the
// extra hook.
(window as any).usePomodoroStore = usePomodoroStore;
const { t } = useI18n();

const cursorLine = ref(1);
const cursorCol = ref(1);
// v4.3.0 issue #70: selection text from the editor, surfaced in StatusBar
// as "selected: N words / M chars". Empty string when nothing is selected.
const selectionText = ref('');
const paletteOpen = ref(false);
const quickSwitcherOpen = ref(false);
const settingsOpen = ref(false);
// When a caller wants the Settings panel to land on a specific category
// (e.g. the AI button → `integrations`), set this before opening; the
// SettingsPanel watches it and switches activeCategory accordingly.
const settingsInitialSection = ref<string | null>(null);
function openSettingsAt(section: string | null = null) {
  settingsInitialSection.value = section;
  settingsOpen.value = true;
}
const helpOpen = ref(false);
const searchOpen = ref(false);
// v4.0.2 — search is now a sidebar pane (PR #50 by @beihai23). Tag clicks
// from TagsPanel prefill `#tag` into the search box; the watcher in
// GlobalSearch refocuses on every prefill change.
const searchPrefill = ref<string | undefined>(undefined);

// v4.3.0 PR #75 (beihai23) — right-click context menu on the sidebar gives
// quick access to per-pane visibility toggles. Toggling off the last
// visible pane auto-hides the whole sidebar (snapshotting the layout for
// restore on next open); toggling one on while hidden brings it back.
const sidebarCtx = ref<{ x: number; y: number } | null>(null);
function openSidebarCtx(e: MouseEvent) {
  e.preventDefault();
  sidebarCtx.value = { x: e.clientX, y: e.clientY };
}
function closeSidebarCtx() { sidebarCtx.value = null; }

function rsPaneSnapshot() {
  return {
    showBacklinks: settings.showBacklinks,
    showRelationships: settings.showRelationships,
    showTagsPanel: settings.showTagsPanel,
    showNeighborhood: settings.showNeighborhood,
    showTypesPanel: settings.showTypesPanel,
    showHistoryPanel: settings.showHistoryPanel,
    showAgentPanel: settings.showAgentPanel,
  };
}
/** Run a pane toggle and reconcile sidebar visibility: hide it if the
 *  toggle left no panes on, restore it if a hidden sidebar gained a pane. */
function ctxToggle(toggleFn: () => void) {
  const before = rsPaneSnapshot();
  toggleFn();
  const noPanesVisible =
    !searchOpen.value &&
    !showOutlinePane.value &&
    !settings.showBacklinks &&
    !settings.showRelationships &&
    !settings.showTagsPanel &&
    !showNeighborhoodPane.value &&
    !settings.showTypesPanel &&
    !settings.showHistoryPanel &&
    (IS_APP_STORE_BUILD || !settings.showAgentPanel);
  if (noPanesVisible) {
    settings.hideRightSidebarFromPane(before);
  } else if (settings.rightSidebarHidden) {
    settings.ensureRightSidebarVisible();
  }
  closeSidebarCtx();
}

const ragSearchOpen = ref(false);
const cjkProofreadOpen = ref(false);
const aboutOpen = ref(false);
const wizardOpen = ref(false);

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
(window as any).__solomd_showUnsavedDialog = showUnsavedDialog;

// File-changed dialog state
const fileChangedOpen = ref(false);
const fileChangedFileName = ref('');
let fileChangedResolve: ((action: 'reload' | 'overwrite' | 'cancel') => void) | null = null;

function showFileChangedDialog(fileName: string): Promise<'reload' | 'overwrite' | 'cancel'> {
  fileChangedFileName.value = fileName;
  fileChangedOpen.value = true;
  return new Promise((resolve) => {
    fileChangedResolve = resolve;
  });
}
function onFileChangedAction(action: 'reload' | 'overwrite' | 'cancel') {
  fileChangedOpen.value = false;
  if (fileChangedResolve) {
    fileChangedResolve(action);
    fileChangedResolve = null;
  }
}

useShortcuts({
  openPalette: () => (paletteOpen.value = true),
  openSettings: () => (settingsOpen.value = true),
  openHelp: () => (helpOpen.value = true),
  openGlobalSearch: () => (searchOpen.value = !searchOpen.value),
  openRagSearch: () => (ragSearchOpen.value = true),
  openQuickSwitcher: () => (quickSwitcherOpen.value = true),
  openCjkProofread: () => (cjkProofreadOpen.value = true),
});

useFileWatcher(showFileChangedDialog);

// v4.6.2 — Ctrl/Cmd + mouse wheel zooms the whole app (Obsidian-style),
// reusing the globalZoom axis so ⌘0 still resets it and it works in edit +
// preview + split (window-level capture handler). Trackpad pinch also arrives
// here (browsers set ctrlKey on pinch), so pinch-to-zoom works too. passive:false
// lets us preventDefault so the page doesn't scroll while zooming.
function onWheelZoom(e: WheelEvent): void {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const dir = e.deltaY < 0 ? 1 : -1;
  settings.setGlobalZoom((settings.globalZoom || 1) + dir * 0.1);
}

// Esc closes the topmost modal
function onZoomShortcut(e: KeyboardEvent): boolean {
  // Three independent zoom axes (v4.3.0 issue #72 + PR #74 yzcj105):
  //   ⌘= / ⌘- / ⌘0           → globalZoom (whole app, CSS zoom)
  //   ⌘⇧= / ⌘⇧- / ⌘⇧0        → editor font size only
  //   ⌃⌘= / ⌃⌘- / ⌃⌘0        → preview font size only
  // On macOS the same shortcuts are also exposed via native View menu
  // accelerators (runner.rs) — this JS handler covers Linux/Windows and
  // catches keys before the WebView's built-in browser zoom intercepts them.
  const cmd = e.metaKey;          // macOS Cmd
  const ctrlOnly = e.ctrlKey && !e.metaKey; // Linux/Win Ctrl (no Cmd present)
  if (!cmd && !ctrlOnly) return false;
  if (e.altKey) return false;

  // Identify axis: Shift = editor; Cmd+Ctrl (both) = preview; otherwise UI.
  let axis: 'ui' | 'editor' | 'preview' = 'ui';
  if (e.shiftKey && !(e.metaKey && e.ctrlKey)) axis = 'editor';
  else if (e.metaKey && e.ctrlKey) axis = 'preview';

  const isIn = e.key === '=' || e.key === '+';
  const isOut = e.key === '-' || e.key === '_';
  const isReset = e.key === '0';
  if (!isIn && !isOut && !isReset) return false;
  e.preventDefault();
  if (axis === 'editor') {
    if (isIn) settings.editorFontIn();
    else if (isOut) settings.editorFontOut();
    else settings.resetEditorFontSize();
  } else if (axis === 'preview') {
    if (isIn) settings.previewFontIn();
    else if (isOut) settings.previewFontOut();
    else settings.resetPreviewFontSize();
  } else {
    if (isIn) settings.zoomIn();
    else if (isOut) settings.zoomOut();
    else settings.resetZoom();
  }
  return true;
}

function onEsc(e: KeyboardEvent) {
  if (onZoomShortcut(e)) return;
  if (e.key !== 'Escape') return;
  if (sidebarCtx.value) sidebarCtx.value = null;
  else if (aboutOpen.value) aboutOpen.value = false;
  else if (cjkProofreadOpen.value) cjkProofreadOpen.value = false;
  else if (ragSearchOpen.value) ragSearchOpen.value = false;
  else if (fileChangedOpen.value) fileChangedOpen.value = false;
  else if (searchOpen.value) searchOpen.value = false;
  else if (helpOpen.value) helpOpen.value = false;
  else if (quickSwitcherOpen.value) quickSwitcherOpen.value = false;
  else if (paletteOpen.value) paletteOpen.value = false;
  else if (settingsOpen.value) settingsOpen.value = false;
  // v2.4: reading mode is "modal-like" too — Esc exits back to the
  // previous view. Lowest priority so any open dialog beats it.
  else if (settings.viewMode === 'reading') settings.exitReadingMode();
}

function onCursor(line: number, col: number) {
  cursorLine.value = line;
  cursorCol.value = col;
}

function onSelection(text: string) {
  selectionText.value = text;
}

function onOutlineGoto(line: number) {
  // Dispatch a custom event that PaneContent listens for
  window.dispatchEvent(new CustomEvent('solomd:outline-goto', {
    detail: { line, paneId: tiles.focusedPaneId },
  }));
}

import { dataThemeFor } from './lib/themes';

// Auto-persist tabs and tiles on every change.
watch(
  () => [tabs.tabs.map((t) => [t.id, t.fileName, t.filePath, t.content, t.savedContent, t.language].join('|')).join(';'), tabs.activeId],
  () => {
    tabs.persist();
    tiles.persist();
  },
  { deep: false },
);

// Persist tiles when root structure changes
watch(
  () => JSON.stringify(tiles.root),
  () => tiles.persist(),
);

// Sync tabs.activeId changes to the focused pane's leaf.
// When newTab() or openFromDisk() set activeId, propagate it to the tile leaf.
watch(
  () => tabs.activeId,
  (newActiveId) => {
    if (newActiveId) tiles.syncFromTabs(newActiveId);
  },
);

// Window title — keep "<filename> — SoloMD" so the OS taskbar /
// dock / Cmd-Tab can distinguish multiple SoloMD windows. Falls back
// to "SoloMD" when no document is active. Issue #53.
//
// Win11-ARM regression (v4.5 report, but pre-existing since v4.4.x — the
// cold-start-with-file path is byte-identical): the document loaded but
// the title stayed "SoloMD". On Windows the JS `setTitle()` issued during
// the cold-start mount burst didn't land (the window isn't ready to accept
// it yet, and the rejected promise was swallowed), whereas macOS WKWebView
// applied it fine. Two-pronged, platform-agnostic fix:
//   1. Set `document.title` too — on Windows, WebView2 mirrors the native
//      window title from the page title, so this lands even when the
//      direct `setTitle()` call is dropped. (Also fixes the stale
//      "Tauri + Vue …" placeholder that index.html shipped with.)
//   2. Await `setTitle()` so a rejection is actually caught + logged,
//      instead of floating off as an unhandled promise.
const applyWindowTitle = async (name?: string) => {
  const title = name ? `${name} — SoloMD` : 'SoloMD';
  document.title = title;
  // macOS uses `titleBarStyle: "Overlay"` + `hiddenTitle: true` — the
  // document name is shown in the in-app toolbar (#MD brand + filename).
  // Calling setTitle() here would un-hide the native macOS title bar text,
  // which overlaps and obscures the in-app toolbar's document name.
  // Skip the native call on macOS; document.title above is enough for
  // taskbar / mission-control / window-switcher labels.
  if (isMacOS()) return;
  try {
    await getCurrentWindow().setTitle(title);
  } catch (err) {
    // Non-Tauri context (Vitest, SSR) — or a window not yet ready to
    // accept it; document.title above is the cross-platform fallback.
    console.debug('setTitle failed (document.title fallback applied)', err);
  }
};
watch(
  () => tabs.activeTab?.fileName,
  (name) => {
    void applyWindowTitle(name);
  },
  { immediate: true },
);

// v2.4: on iOS / iPad, default to reading mode whenever a markdown tab
// becomes active (and the user hasn't opted out via the setting). Skips
// non-markdown docs so plaintext tabs still get the editor.
watch(
  () => tabs.activeId,
  (newActiveId) => {
    if (!newActiveId) return;
    if (!isIOS()) return;
    if (!settings.readingByDefaultOnMobile) return;
    const t = tabs.activeTab;
    if (!t || t.language !== 'markdown') return;
    if (settings.viewMode === 'reading') return;
    settings.lastNonReadingViewMode = settings.viewMode;
    settings.viewMode = 'reading';
    settings.persist();
  },
  { immediate: true },
);

// UI font size
watchEffect(() => {
  document.documentElement.style.setProperty('--ui-font-size', `${settings.uiFontSize}px`);
});

// v4.3.0 (issue #72): global zoom — scales everything for high-DPI screens.
// Uses CSS `zoom` so layout reflows rather than being scaled with transform
// (which would clip + break click targets). wry's webview on every platform
// supports it.
watchEffect(() => {
  const z = settings.globalZoom || 1;
  (document.documentElement.style as any).zoom = String(z);
});

// v4.3.0 (PR #74 — yzcj105): preview-pane font size, surfaced as a CSS
// custom property so Preview.vue can read it without re-rendering content.
watchEffect(() => {
  document.documentElement.style.setProperty(
    '--content-font-size',
    `${settings.previewFontSize || 15}px`,
  );
});

// Sync native menu bar language
watchEffect(() => {
  invoke('set_menu_language', { lang: settings.language }).catch(() => {});
  invoke('save_language_preference', { lang: settings.language }).catch(() => {});
});

watchEffect(() => {
  document.documentElement.setAttribute('data-theme', dataThemeFor(settings.theme));
});

// v2.0: keep the Rust workspace index in sync with the active folder.
watchEffect(() => {
  workspaceIndex.setFolder(workspace.currentFolder).catch(() => {});
});

// v4.6.1 F1: bind the properties store to the workspace so display-mode
// overrides + pinned list load/save from .solomd/properties.json (the store
// shipped in 4.6 but setFolder was never called → persistence silently no-op'd).
watchEffect(() => {
  properties.setFolder(workspace.currentFolder).catch(() => {});
});

// v2.4: push the active folder into the capture endpoint's view of the
// world, so the localhost HTTP server knows where to write captured notes
// (or returns 503 when no folder is open).
watchEffect(() => {
  const folder = workspace.currentFolder;
  invoke('capture_set_workspace', { folder: folder ?? null }).catch(() => {});
  // v4.0: same dance for the public REST API server. Both endpoints share
  // the "I 503 when no folder is open" contract, so they read from
  // independent state but get pushed together.
  invoke('rest_set_workspace', { folder: folder ?? null }).catch(() => {});
});

// v2.3: keep the RAG index in sync with the toggle + active folder. When
// `ragEnabled` flips on we trigger a background scan via the Rust side
// (`rag_set_enabled` already wraps run_indexer). When the folder
// changes we refresh the status line so the panel shows the right
// counters.
let ragLastFolder: string | null = null;
let ragLastEnabled = false;
watchEffect(() => {
  const folder = workspace.currentFolder;
  const enabled = settings.ragEnabled;
  if (folder === ragLastFolder && enabled === ragLastEnabled) return;
  ragLastFolder = folder;
  ragLastEnabled = enabled;
  if (!folder) {
    rag.refreshStatus(null);
    return;
  }
  if (enabled) {
    rag.setEnabled(folder, true).catch(() => {});
  } else {
    rag.refreshStatus(folder).catch(() => {});
  }
});

// v2.6: a successful GitHub pull touched files on disk under us. Refresh
// the workspace index so the file tree + backlinks pick up renames /
// deletions, and rebuild git history caches so the History panel reflects
// the merge commit. Active editor tabs reload from disk only if they're
// clean (we never blow away a user's unsaved edits, even from a sync).
window.addEventListener('solomd:remote-pulled', () => {
  void workspaceIndex.rescan();
  // gitHistory's own listener on `solomd://index-updated` rebuilds caches,
  // but rescan() above doesn't re-emit that event. Bust the caches here.
  // (Keep this scoped — we don't want to re-fetch every commit on every
  // remote-pull; the panel will lazy-reload as the user opens it.)
});

// Listen for the `solomd://index-updated` event the workspace_index
// emits on watcher debounces. When semantic search is on, mirror that
// event into a single-file rescan so the embeddings stay fresh without
// a full reindex on every save.
window.addEventListener(
  'solomd:rag-bus',
  (e) => {
    if (!settings.ragEnabled) return;
    const detail = (e as CustomEvent).detail || {};
    const path = detail.path;
    if (typeof path === 'string') {
      rag.reindexFile(workspace.currentFolder, path).catch(() => {});
    }
  },
);

// v2.0 F2: load Hunspell dict on demand. (Lang fixed at en_US in v2.0.)
let spellcheckLoaded = false;
watchEffect(async () => {
  if (settings.spellcheckEnabled && !spellcheckLoaded) {
    try {
      await invoke('spellcheck_init', { lang: 'en_US' });
      spellcheckLoaded = true;
    } catch (e) {
      console.warn('spellcheck_init failed', e);
    }
  }
});

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
  searchOpen.value = !searchOpen.value;
}
function onOpenCjkProofreadEvent() {
  cjkProofreadOpen.value = true;
}

// TagsPanel emits `filter-tag` when the user clicks a tag — open the search
// pane and prefill `#tag`. If the same tag is clicked while search is
// already open, clear/reset the prefill ref to retrigger the watcher.
function onFilterTag(tag: string) {
  const newPrefill = `#${tag}`;
  if (searchOpen.value && searchPrefill.value === newPrefill) {
    searchPrefill.value = undefined;
    nextTick(() => {
      searchPrefill.value = newPrefill;
    });
  } else {
    searchPrefill.value = newPrefill;
  }
  searchOpen.value = true;
}

let unlistenOpened: UnlistenFn | null = null;
let unlistenMenu: UnlistenFn | null = null;
let unlistenWindowDestroyed: UnlistenFn | null = null;

async function openExternalFile() {
  const filePath = tabs.activeTab?.filePath;
  if (!filePath) {
    console.warn('openExternal: no file path');
    return;
  }
  try {
    await openPath(filePath);
  } catch (e) {
    console.warn('openExternal failed', e);
  }
}

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
    case 'file.openExternal':
      openExternalFile();
      break;
    case 'file.print':
      exporter.exportPdfPrint();
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
      if (tabs.activeId) tabs.toggleOutline(tabs.activeId);
      break;
    case 'view.cycleView':
      settings.cycleViewMode();
      break;
    // v4.3.0 PR #74 — 3-axis zoom from the native View menu.
    case 'view.zoomUiIn':
      settings.zoomIn();
      break;
    case 'view.zoomUiOut':
      settings.zoomOut();
      break;
    case 'view.zoomUiReset':
      settings.resetZoom();
      break;
    case 'view.zoomEditorIn':
      settings.editorFontIn();
      break;
    case 'view.zoomEditorOut':
      settings.editorFontOut();
      break;
    case 'view.zoomEditorReset':
      settings.resetEditorFontSize();
      break;
    case 'view.zoomPreviewIn':
      settings.previewFontIn();
      break;
    case 'view.zoomPreviewOut':
      settings.previewFontOut();
      break;
    case 'view.zoomPreviewReset':
      settings.resetPreviewFontSize();
      break;
    case 'view.cmdPalette':
      paletteOpen.value = true;
      break;
    case 'view.settings':
      settingsOpen.value = true;
      break;
    case 'search.global':
      searchOpen.value = !searchOpen.value;
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

// Window size + position are persisted by tauri-plugin-window-state on the
// Rust side. The plugin clamps restored coordinates to the current monitor
// set, which prevents the "window is off-screen, only taskbar thumbnail
// visible" bug that the old localStorage approach had.
// Remove stale localStorage entry from earlier versions on first run.
try {
  localStorage.removeItem('solomd.window.v1');
} catch {}

// #85 — auto-save dirty tabs when the app window loses focus. Gated on the
// `autoSaveOnBlur` setting (default off) inside autoSaveDirtyTabs().
function onWindowBlur() {
  void files.autoSaveDirtyTabs();
}

onMounted(async () => {
  // #87(3) — if a startup view mode is pinned, force it now (overrides the
  // persisted last-used `viewMode`). Empty/null = resume whatever the user
  // left in, as before.
  if (settings.startupViewMode && settings.startupViewMode !== settings.viewMode) {
    settings.setViewMode(settings.startupViewMode);
  }

  window.addEventListener('keydown', onEsc);
  window.addEventListener('wheel', onWheelZoom, { passive: false, capture: true });
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('solomd:open-help', onOpenHelpEvent as EventListener);
  window.addEventListener('solomd:open-global-search', onOpenSearchEvent as EventListener);
  window.addEventListener('solomd:open-cjk-proofread', onOpenCjkProofreadEvent as EventListener);

  track('app_launched', {
    locale: settings.language,
    theme: settings.theme,
    live_preview: settings.livePreview ? 1 : 0,
  });

  // OS file association — an OS-level file-open always belongs in the current
  // window (this window was just spawned for it). Bypass new-window routing.
  try {
    unlistenOpened = await listen<string>('solomd://opened-file', async (e) => {
      if (e.payload) await files.openPath(e.payload, { bypassNewWindow: true });
    });
  } catch (err) {
    console.warn('opened-file listener not available', err);
  }

  // iOS / Android — tauri-plugin-deep-link delivers incoming files
  // (Files app "Open with…", Mail attachments, AirDrop) as a list of URL
  // strings. file:// URLs point into our app's Documents dir (the OS
  // already copied the file there before launching us, or it's a
  // bookmark into a third-party cloud-folder we asked to open in place).
  try {
    const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link');
    const handleUrls = async (urls: string[] | null | undefined) => {
      if (!urls) return;
      for (const raw of urls) {
        try {
          const path = raw.startsWith('file://')
            ? decodeURIComponent(raw.slice('file://'.length))
            : raw;
          await files.openPath(path, { bypassNewWindow: true });
        } catch (err) {
          console.warn('deep-link openPath failed', raw, err);
        }
      }
    };
    // Live listener — files arriving while the app is already open.
    await onOpenUrl(handleUrls);
    // Initial payload — file that LAUNCHED the app (iOS cold start with
    // tap-on-file from Files / Mail).
    const initial = await getCurrent();
    await handleUrls(initial);
  } catch (err) {
    // Plugin only present on mobile + matching platforms; harmless to
    // skip on macOS/Linux/Windows (those use 'solomd://opened-file' above).
    console.debug('deep-link plugin not active', err);
  }

  try {
    const pending = await invoke<string[]>('drain_pending_opens');
    for (const p of pending || []) {
      await files.openPath(p, { bypassNewWindow: true });
    }
  } catch (err) {
    console.warn('drain_pending_opens failed', err);
  }

  // New-window launched via `?path=<encoded>` (used by the "open in new
  // window" setting). Same reasoning as above — bypass the setting.
  let initialPath: string | null = null;
  try {
    const params = new URLSearchParams(window.location.search);
    initialPath = params.get('path');
    if (initialPath) {
      await files.openPath(initialPath, { bypassNewWindow: true });
    }
  } catch {}

  // #103 follow-up — auxiliary windows ("Open file in new window") close
  // independently of the main window (handled in runner.rs, the original #103
  // fix). We intentionally do NOT auto-resurrect them on launch.
  //
  // An earlier version re-spawned every *registered* aux window on every
  // start. Entries left behind by a force-quit (onCloseRequested never fires)
  // or by a since-deleted/temp file were never pruned, so a "ghost" window
  // reappeared on every launch — even for paths that no longer exist (user
  // report: "每次打开都冒出一个额外窗口"). Closed windows now stay closed.
  //
  // On the main window we also clear any stale registry entries so users
  // already affected by the old behavior stop seeing the ghost window after
  // updating. (spawnAuxWindow still works for the current session; the
  // registry simply isn't replayed across restarts anymore.)
  try {
    if (!isAuxLabel(getCurrentWindow().label)) {
      windowsStore.reload();
      for (const label of [...windowsStore.auxLabels]) {
        windowsStore.unregister(label);
      }
    }
  } catch (err) {
    console.warn('aux-window registry cleanup failed', err);
  }

  // First-launch welcome tour: only when there are no tabs at all (fresh
  // install or user has cleared session) and we haven't shown it before.
  const isFreshLaunch = tabs.tabs.length === 0 && !settings.welcomeShown;
  if (isFreshLaunch) {
    openWelcomeTour();
    settings.markWelcomeShown();
  } else if (tabs.tabs.length === 0) {
    tabs.newTab();
  }

  // v4.0 first-run agent setup wizard. Fires after the welcome tour on a
  // fresh install — once. Re-openable from Settings → AI ("Run setup
  // wizard again") for users who skipped it. We wait one tick so the
  // welcome tour overlay (if any) shows first. App Store builds skip
  // entirely (Apple 3.1.1 — no AI surface).
  if (!IS_APP_STORE_BUILD && !settings.agentWizardSeen) {
    setTimeout(() => {
      wizardOpen.value = true;
    }, isFreshLaunch ? 800 : 0);
  }
  // Settings → AI's "Run setup wizard again" button asks here. Registered
  // as a named handler (see `onOpenAgentWizard` below) so onBeforeUnmount
  // can detach it — otherwise every HMR remount stacks another listener.
  window.addEventListener('solomd:open-agent-wizard', onOpenAgentWizard);

  // Initialize tile layout: validate persisted state or create default
  tiles.validate(tabs.tabs);
  if (!tiles.focusedLeaf?.activeTabId && tabs.tabs.length > 0) {
    tiles.initDefault(tabs.tabs[0].id);
  }
  tiles.syncActiveTab();

  // Window close
  try {
    await listen('solomd://close-requested', async () => {
      tabs.persist?.();
      tiles.persist();
      await invoke('force_close_window');
    });
  } catch (err) {
    console.warn('close-requested listener failed', err);
  }

  // #103 — backstop registry cleanup. The destroyed window normally
  // unregisters itself via onCloseRequested, but a webview teardown that
  // skips CloseRequested would leave a stale entry that resurrects on the
  // next launch. Rust emits `solomd://window-destroyed` with the label so
  // any surviving window drops it from the registry.
  try {
    unlistenWindowDestroyed = await listen<string>('solomd://window-destroyed', (e) => {
      if (e.payload && isAuxLabel(e.payload)) windowsStore.unregister(e.payload);
    });
  } catch (err) {
    console.warn('window-destroyed listener not available', err);
  }

  // Native menu bar
  try {
    unlistenMenu = await listen<string>('solomd://menu', (e) => {
      if (e.payload) dispatchMenuAction(e.payload);
    });
  } catch (err) {
    console.warn('menu listener not available', err);
  }

  // Drag-drop file open
  try {
    const webview = getCurrentWebview();
    const IMAGE_DROP_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tiff']);
    await webview.onDragDropEvent(async (event) => {
      if (event.payload.type === 'drop') {
        for (const path of event.payload.paths) {
          const ext = (path.split('.').pop() || '').toLowerCase();
          if (IMAGE_DROP_EXTS.has(ext)) {
            // An image file dropped onto the editor should be inserted, not
            // run through the markitdown document converter (png/jpg/etc are
            // in useFiles' CONVERT_CLI set). Route it to the focused editor's
            // insertImageFromPath, which copies it into the note's assets dir
            // and inserts a Markdown image link.
            window.dispatchEvent(
              new CustomEvent('solomd:insert-image-path', {
                detail: { path, paneId: tiles.focusedPaneId },
              }),
            );
            continue;
          }
          // Drop targets this window explicitly — bypass new-window routing.
          await files.openPath(path, { bypassNewWindow: true });
        }
      }
    });
  } catch (e) {
    console.warn('drag-drop not available', e);
  }

  // Auto-check for updates
  if (!isIOS() && settings.autoCheckUpdate) {
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

function onAIRewriteAccept(e: Event) {
  const detail = (e as CustomEvent).detail || {};
  const { from, to, replacement } = detail;
  if (typeof from !== 'number' || typeof to !== 'number' || typeof replacement !== 'string') return;
  // The Editor doesn't expose its EditorView directly, so route through the
  // existing insert-markdown channel — `cm-image-paste`'s insertMarkdown helper
  // replaces the current selection. We piggyback on the same convention.
  const ev = new CustomEvent('solomd:insert-markdown', {
    detail: { snippet: replacement, paneId: tiles.focusedPaneId, replaceFrom: from, replaceTo: to },
  });
  window.dispatchEvent(ev);
}
function onAIRewriteCancel() {
  // No-op for now; AIRewriteOverlay self-closes.
}
function onOpenBases() { basesOpen.value = true; viewOpen.value = false; typeLensOpen.value = false; }
function onCloseBases() { basesOpen.value = false; }
function onOpenInbox() { inboxViewOpen.value = true; typeLensOpen.value = false; }
function onCloseInbox() { inboxViewOpen.value = false; }
// v4.6.1 F2 — type lens content swap. Mutually exclusive with the other
// center-pane overlays (mirrors basesOpen / inboxViewOpen). The open event
// carries which type to focus; we pass it down as a prop so the view is
// ready on mount (the event fired before the component existed).
function onOpenTypeLens(e: Event) {
  const name = (e as CustomEvent).detail?.typeName;
  if (typeof name !== 'string' || !name) return;
  typeLensName.value = name;
  typeLensOpen.value = true;
  basesOpen.value = false;
  inboxViewOpen.value = false;
  viewOpen.value = false;
}
function onCloseTypeLens() { typeLensOpen.value = false; }
// v4.6 F5 — saved-view content swap.
function onOpenView() { viewOpen.value = true; basesOpen.value = false; typeLensOpen.value = false; }
function onCloseView() { viewOpen.value = false; }

async function onWikiOpen(e: Event) {
  const detail = (e as CustomEvent).detail || {};
  const target: string = detail.target || '';
  if (!target) return;
  // #116 — a path-like target (`./sub/foo.md`, `../notes/bar.md`, `dir/x.md`)
  // is a RELATIVE reference, not a bare wiki stem. Resolve it against the
  // active file's directory and open directly — the same logic Preview.vue
  // uses for rendered links. workspaceIndex.resolve() only matches bare
  // stems/titles, so it silently failed for these (the reported bug).
  if (/[\\/]/.test(target) || target.startsWith('.')) {
    const cur = tabs.activeTab?.filePath;
    if (cur) {
      const sep = Math.max(cur.lastIndexOf('/'), cur.lastIndexOf('\\'));
      const dir = sep >= 0 ? cur.slice(0, sep + 1) : '';
      const cleaned = target.replace(/^\.\//, '');
      try {
        await files.openPath(dir + cleaned, { bypassNewWindow: true });
        return;
      } catch (err) {
        console.warn('[wiki-open] relative openPath failed:', dir + cleaned, err);
        // fall through to stem resolution as a best effort
      }
    }
  }
  const path = await workspaceIndex.resolve(target);
  if (path) {
    await files.openPath(path, { bypassNewWindow: true });
  } else {
    // Unresolved: create a new tab with the wikilink target as filename.
    const fileName = /\.md$/i.test(target) ? target : `${target}.md`;
    const tab = tabs.newTab({ fileName, language: 'markdown' });
    tab.content = `# ${target}\n\n`;
    tabs.activate(tab.id);
  }
}
function onOpenSettingsEvent(e: Event) {
  // Optional `detail.section` lets callers (toolbar AI button, RAG
  // empty state, etc.) deep-link into a specific Settings category.
  const section = (e as CustomEvent).detail?.section ?? null;
  openSettingsAt(section);
}
function onOpenAgentWizard() {
  wizardOpen.value = true;
}

window.addEventListener('solomd:wiki-open', onWikiOpen as EventListener);
window.addEventListener('solomd:ai-rewrite-accept', onAIRewriteAccept as EventListener);
window.addEventListener('solomd:ai-rewrite-cancel', onAIRewriteCancel as EventListener);
window.addEventListener(BASES_OPEN_EVENT, onOpenBases as EventListener);
window.addEventListener(BASES_CLOSE_EVENT, onCloseBases as EventListener);
window.addEventListener(INBOX_OPEN_EVENT, onOpenInbox as EventListener);
window.addEventListener(INBOX_CLOSE_EVENT, onCloseInbox as EventListener);
window.addEventListener(TYPE_LENS_OPEN_EVENT, onOpenTypeLens as EventListener);
window.addEventListener(TYPE_LENS_CLOSE_EVENT, onCloseTypeLens as EventListener);
window.addEventListener(VIEW_OPEN_EVENT, onOpenView as EventListener);
window.addEventListener(VIEW_CLOSE_EVENT, onCloseView as EventListener);
window.addEventListener('solomd:open-settings', onOpenSettingsEvent as EventListener);

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onEsc);
  window.removeEventListener('wheel', onWheelZoom, { capture: true } as EventListenerOptions);
  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('solomd:open-help', onOpenHelpEvent as EventListener);
  window.removeEventListener('solomd:open-global-search', onOpenSearchEvent as EventListener);
  window.removeEventListener('solomd:open-cjk-proofread', onOpenCjkProofreadEvent as EventListener);
  window.removeEventListener('solomd:wiki-open', onWikiOpen as EventListener);
  window.removeEventListener('solomd:ai-rewrite-accept', onAIRewriteAccept as EventListener);
  window.removeEventListener('solomd:ai-rewrite-cancel', onAIRewriteCancel as EventListener);
  window.removeEventListener(BASES_OPEN_EVENT, onOpenBases as EventListener);
  window.removeEventListener(BASES_CLOSE_EVENT, onCloseBases as EventListener);
  window.removeEventListener(INBOX_OPEN_EVENT, onOpenInbox as EventListener);
  window.removeEventListener(INBOX_CLOSE_EVENT, onCloseInbox as EventListener);
  window.removeEventListener(TYPE_LENS_OPEN_EVENT, onOpenTypeLens as EventListener);
  window.removeEventListener(TYPE_LENS_CLOSE_EVENT, onCloseTypeLens as EventListener);
  window.removeEventListener(VIEW_OPEN_EVENT, onOpenView as EventListener);
  window.removeEventListener(VIEW_CLOSE_EVENT, onCloseView as EventListener);
  window.removeEventListener('solomd:open-settings', onOpenSettingsEvent as EventListener);
  window.removeEventListener('solomd:open-agent-wizard', onOpenAgentWizard);
  if (unlistenOpened) {
    unlistenOpened();
    unlistenOpened = null;
  }
  if (unlistenMenu) {
    unlistenMenu();
    unlistenMenu = null;
  }
  if (unlistenWindowDestroyed) {
    unlistenWindowDestroyed();
    unlistenWindowDestroyed = null;
  }
});

const showOutlinePane = computed(
  () => !!tabs.activeTab?.showOutline && tabs.activeTab?.language === 'markdown'
);
const showBacklinksPane = computed(
  () =>
    settings.showBacklinks &&
    tabs.activeTab?.language === 'markdown' &&
    !!workspace.currentFolder,
);
const showRelationshipsPane = computed(
  () =>
    settings.showRelationships &&
    tabs.activeTab?.language === 'markdown' &&
    !!workspace.currentFolder,
);
const showTagsPane = computed(
  () => settings.showTagsPanel && !!workspace.currentFolder,
);
// v4.6 F4 — Neighborhood relationship explorer. Markdown-only, needs a folder
// (frontmatter wikilink groups are resolved against the workspace index).
const showNeighborhoodPane = computed(
  () =>
    settings.showNeighborhood &&
    tabs.activeTab?.language === 'markdown' &&
    !!workspace.currentFolder,
);
// v4.6 F2 — Types pane (types-as-lenses). Workspace-scoped like Tags.
const showTypesPane = computed(
  () => settings.showTypesPanel && !!workspace.currentFolder,
);
const showHistoryPane = computed(
  // v4.0.2 — decoupled from autoGitEnabled (#55). Hiding the pane via
  // its × button no longer disables git sync; users can keep snapshots
  // running in the background while reclaiming vertical space.
  () =>
    settings.autoGitEnabled &&
    settings.showHistoryPanel &&
    tabs.activeTab?.language === 'markdown' &&
    !!workspace.currentFolder,
);
// v4.6 F1: Properties inspector — frontmatter editor for the active markdown
// note. Toggled via ⌘⇧I / command palette `view.toggleInspector`. Requires an
// open folder (reads parsed frontmatter from the workspace index).
const showInspectorPane = computed(
  () =>
    settings.showInspector &&
    tabs.activeTab?.language === 'markdown' &&
    !!workspace.currentFolder,
);
// v4.0 pillar 1: Agent Panel — workspace-level visibility (not per-tab).
// Toggled via command palette `view.toggleAgentPanel`; persists in settings.
// App Store builds strip the AI/Agent surface entirely (Apple 3.1.1).
const showAgentPane = computed(() => !IS_APP_STORE_BUILD && settings.showAgentPanel);
// v4.0.2 — search is a session-only pane (PR #50). ⌘⇧F toggles searchOpen;
// no setting persisted because users don't want search living in their
// sidebar across launches.
const showSearchPane = computed(() => searchOpen.value);
const showRightSidebar = computed(() => {
  // Master "hide" toggle wins over individual panes — preserves which panes
  // the user had on while still letting them dismiss the whole strip with
  // a single action (toolbar close button / ⌥⌘B / command palette).
  if (settings.rightSidebarHidden) return false;
  return (
    showSearchPane.value ||
    showOutlinePane.value ||
    showBacklinksPane.value ||
    showRelationshipsPane.value ||
    showTagsPane.value ||
    showNeighborhoodPane.value ||
    showTypesPane.value ||
    showHistoryPane.value ||
    showInspectorPane.value ||
    showAgentPane.value
  );
});

// v4.0.2 — ordered list of currently-visible right-sidebar panes. Drives
// the v-for that interleaves <RsSplitter> between adjacent panes (#6 / #52).
// Search slots in at the top because users typically want results visible
// while scanning the rest of the sidebar context.
const visibleRsPanes = computed(() => {
  // v4.3.0 issue #57b — order driven by settings.rsPaneOrder so users can
  // drag-reorder. Unknown ids (newly-shipped future panes) get appended at
  // the end so a SoloMD update doesn't blow away an existing user layout.
  const all: Record<'search' | 'outline' | 'backlinks' | 'relationships' | 'tags' | 'neighborhood' | 'types' | 'history' | 'inspector' | 'agent', boolean> = {
    search: showSearchPane.value,
    outline: showOutlinePane.value,
    backlinks: showBacklinksPane.value,
    relationships: showRelationshipsPane.value,
    tags: showTagsPane.value,
    neighborhood: showNeighborhoodPane.value,
    types: showTypesPane.value,
    history: showHistoryPane.value,
    inspector: showInspectorPane.value,
    agent: showAgentPane.value,
  };
  const known = ['search', 'outline', 'backlinks', 'relationships', 'tags', 'neighborhood', 'types', 'history', 'inspector', 'agent'] as const;
  const ordered: string[] = [];
  for (const id of settings.rsPaneOrder || []) {
    if (id in all && !ordered.includes(id)) ordered.push(id);
  }
  for (const id of known) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered
    .filter((id) => all[id as keyof typeof all])
    .map((id) => ({ id: id as 'search' | 'outline' | 'backlinks' | 'relationships' | 'tags' | 'neighborhood' | 'types' | 'history' | 'inspector' | 'agent' }));
});

// v4.3.0 issue #57b — HTML5 drag state for right-sidebar pane reordering.
// Holding null = nothing dragging; a string = the pane id currently being
// dragged. The drop target index is computed by the dragover handler.
const draggingPaneId = ref<string | null>(null);
const dragOverPaneId = ref<string | null>(null);
function onPaneDragStart(e: DragEvent, id: string) {
  draggingPaneId.value = id;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-solomd-rs-pane', id);
  }
}
function onPaneDragOver(e: DragEvent, id: string) {
  if (!draggingPaneId.value || draggingPaneId.value === id) return;
  e.preventDefault();
  dragOverPaneId.value = id;
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
}
function onPaneDragLeave(id: string) {
  if (dragOverPaneId.value === id) dragOverPaneId.value = null;
}
function onPaneDrop(_e: DragEvent, targetId: string) {
  const src = draggingPaneId.value;
  draggingPaneId.value = null;
  dragOverPaneId.value = null;
  if (!src || src === targetId) return;
  // Find the target's index in the full order list (not just the visible
  // subset) so reordering survives toggling pane visibility off + on.
  const order = [...(settings.rsPaneOrder || [])];
  const targetIdx = order.indexOf(targetId);
  if (targetIdx < 0) return;
  settings.moveRsPane(src, targetIdx);
}
function onPaneDragEnd() {
  draggingPaneId.value = null;
  dragOverPaneId.value = null;
}

// Sidebar visibility / pane composition changes the editor's available
// width. CodeMirror's ResizeObserver may lag for a frame, so dispatch
// solomd:relayout on the next paint and let Editor.vue requestMeasure().
watch(visibleRsPanes, () => {
  nextTick(() => {
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('solomd:relayout'));
    });
  });
});

// Per-pane height map → inline flex-basis. Panes without a stored height
// fall back to the CSS flex defaults (1× for read-only panes, 4× for
// Agent so chat keeps room when no splitter has been touched).
function paneStyle(id: string) {
  const h = settings.rightSidebarPaneHeights[id];
  if (h && h > 0) {
    return { flex: `0 0 ${h}px`, height: `${h}px` };
  }
  return {};
}

// Side sidebar width — user-resizable via drag handle. Defaults to 260
// for the read-only panes (outline/backlinks/tags/history), but auto-
// bumps to 440 when the agent panel is on (chat needs real estate).
// User resizes above the auto-bump are honored.
const sideSidebarStyle = computed(() => {
  const w =
    showAgentPane.value && settings.sideSidebarWidth <= 260
      ? 440
      : settings.sideSidebarWidth;
  return { width: `${w}px`, flexBasis: `${w}px` };
});

function onSidebarResize(side: 'left' | 'right', ev: MouseEvent) {
  ev.preventDefault();
  const startX = ev.clientX;
  const startW = parseInt(
    (sideSidebarStyle.value.width as string).replace('px', ''),
    10,
  );
  const onMove = (m: MouseEvent) => {
    const dx = m.clientX - startX;
    // Right sidebar: drag left = wider. Left sidebar: drag right = wider.
    const delta = side === 'right' ? -dx : dx;
    settings.setSideSidebarWidth(startW + delta);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  document.body.style.cursor = 'ew-resize';
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
const basesOpen = ref(false);
const inboxViewOpen = ref(false);
// v4.6.1 F2 — type lens (full-pane filtered list of one type's members).
const typeLensOpen = ref(false);
const typeLensName = ref('');
// v4.6 F5 — when a saved view is opened from the sidebar, the content area
// swaps to ViewNoteList (mirrors the basesOpen pattern).
const viewOpen = ref(false);
const aiHasKey = ref(false);
async function refreshAiHasKey() {
  if (!settings.aiEnabled) { aiHasKey.value = false; return; }
  try {
    aiHasKey.value = await invoke<boolean>('ai_has_key', { provider: settings.aiProvider });
  } catch {
    aiHasKey.value = false;
  }
}
watchEffect(() => { void settings.aiEnabled; void settings.aiProvider; refreshAiHasKey(); });
</script>

<template>
  <UiPreview v-if="showUiKit" />
  <div v-else class="app" :class="{ 'app--reading': settings.viewMode === 'reading' }">
    <!--
      v2.4 reading mode swaps out the entire toolbar / sidebar / status-bar
      stack for a single ReadingView component. We keep all the modal
      dialogs (settings, palette, etc.) mounted at the bottom so the user
      can still summon them from inside reading mode if needed.
    -->
    <template v-if="settings.viewMode === 'reading'">
      <ReadingView />
    </template>
    <template v-else>
      <Toolbar
        @open-palette="paletteOpen = true"
        @open-settings="openSettingsAt()"
        @open-help="helpOpen = true"
        @open-search="searchOpen = !searchOpen"
      />
      <TelemetryBanner />
      <div class="workspace">
        <div v-if="settings.showFileTree || settings.showViewsPanel" class="left-stack">
          <FileTree v-if="settings.showFileTree" />
          <ViewsPanel v-if="settings.showViewsPanel" />
        </div>
        <aside
          v-if="showRightSidebar && settings.outlineSide === 'left'"
          class="side-sidebar side-sidebar--left"
          :style="sideSidebarStyle"
          @contextmenu.prevent="openSidebarCtx"
        >
          <div class="side-sidebar__resize side-sidebar__resize--right" @mousedown="onSidebarResize('left', $event)" />
          <template v-for="(p, idx) in visibleRsPanes" :key="p.id">
            <RsSplitter v-if="idx > 0" :above="visibleRsPanes[idx-1].id" :below="p.id" />
            <div
              :data-rs-pane="p.id"
              :class="[
                'rs-pane-host',
                `rs-pane-host--${p.id}`,
                draggingPaneId === p.id ? 'rs-pane-host--dragging' : '',
                dragOverPaneId === p.id ? 'rs-pane-host--drop-target' : '',
              ]"
              :style="paneStyle(p.id)"
              @dragover="onPaneDragOver($event, p.id)"
              @dragleave="onPaneDragLeave(p.id)"
              @drop="onPaneDrop($event, p.id)"
            >
              <div
                class="rs-pane-grip"
                draggable="true"
                :title="t('rsPane.dragToReorder')"
                @dragstart="onPaneDragStart($event, p.id)"
                @dragend="onPaneDragEnd"
              >⋮⋮</div>
              <GlobalSearch
                v-if="p.id === 'search'"
                :prefill="searchPrefill"
                @close="searchOpen = false"
              />
              <Outline v-if="p.id === 'outline'" :cursor-line="cursorLine" @goto="onOutlineGoto" />
              <BacklinksPanel v-if="p.id === 'backlinks'" @close="ctxToggle(() => settings.toggleBacklinks())" />
              <RelationshipsPanel v-if="p.id === 'relationships'" @close="ctxToggle(() => settings.toggleRelationships())" />
              <TagsPanel
                v-if="p.id === 'tags'"
                @close="ctxToggle(() => settings.toggleTagsPanel())"
                @filter-tag="onFilterTag"
              />
              <NeighborhoodPanel
                v-if="p.id === 'neighborhood'"
                @close="ctxToggle(() => settings.toggleNeighborhood())"
              />
              <TypesPanel
                v-if="p.id === 'types'"
                @close="ctxToggle(() => settings.toggleTypesPanel())"
              />
              <HistoryPanel v-if="p.id === 'history'" @close="ctxToggle(() => settings.toggleHistoryPanel())" />
              <PropertiesInspector v-if="p.id === 'inspector'" @close="ctxToggle(() => settings.toggleInspector())" />
              <AgentPanel
                v-if="p.id === 'agent'"
                @open-settings="(section?: string) => openSettingsAt(section ?? 'integrations')"
                @close="ctxToggle(() => settings.toggleAgentPanel())"
              />
            </div>
          </template>
        </aside>
        <div class="content">
          <BasesView v-if="basesOpen" />
          <InboxView v-else-if="inboxViewOpen" />
          <TypeLensView v-else-if="typeLensOpen" :type-name="typeLensName" />
          <ViewNoteList v-else-if="viewOpen" />
          <TileRoot v-else :node="tiles.root" @cursor="onCursor" @selection="onSelection" />
        </div>
        <aside
          v-if="showRightSidebar && settings.outlineSide !== 'left'"
          class="side-sidebar side-sidebar--right"
          :style="sideSidebarStyle"
          @contextmenu.prevent="openSidebarCtx"
        >
          <div class="side-sidebar__resize side-sidebar__resize--left" @mousedown="onSidebarResize('right', $event)" />
          <template v-for="(p, idx) in visibleRsPanes" :key="p.id">
            <RsSplitter v-if="idx > 0" :above="visibleRsPanes[idx-1].id" :below="p.id" />
            <div
              :data-rs-pane="p.id"
              :class="[
                'rs-pane-host',
                `rs-pane-host--${p.id}`,
                draggingPaneId === p.id ? 'rs-pane-host--dragging' : '',
                dragOverPaneId === p.id ? 'rs-pane-host--drop-target' : '',
              ]"
              :style="paneStyle(p.id)"
              @dragover="onPaneDragOver($event, p.id)"
              @dragleave="onPaneDragLeave(p.id)"
              @drop="onPaneDrop($event, p.id)"
            >
              <div
                class="rs-pane-grip"
                draggable="true"
                :title="t('rsPane.dragToReorder')"
                @dragstart="onPaneDragStart($event, p.id)"
                @dragend="onPaneDragEnd"
              >⋮⋮</div>
              <GlobalSearch
                v-if="p.id === 'search'"
                :prefill="searchPrefill"
                @close="searchOpen = false"
              />
              <Outline v-if="p.id === 'outline'" :cursor-line="cursorLine" @goto="onOutlineGoto" />
              <BacklinksPanel v-if="p.id === 'backlinks'" @close="ctxToggle(() => settings.toggleBacklinks())" />
              <RelationshipsPanel v-if="p.id === 'relationships'" @close="ctxToggle(() => settings.toggleRelationships())" />
              <TagsPanel
                v-if="p.id === 'tags'"
                @close="ctxToggle(() => settings.toggleTagsPanel())"
                @filter-tag="onFilterTag"
              />
              <NeighborhoodPanel
                v-if="p.id === 'neighborhood'"
                @close="ctxToggle(() => settings.toggleNeighborhood())"
              />
              <TypesPanel
                v-if="p.id === 'types'"
                @close="ctxToggle(() => settings.toggleTypesPanel())"
              />
              <HistoryPanel v-if="p.id === 'history'" @close="ctxToggle(() => settings.toggleHistoryPanel())" />
              <PropertiesInspector v-if="p.id === 'inspector'" @close="ctxToggle(() => settings.toggleInspector())" />
              <AgentPanel
                v-if="p.id === 'agent'"
                @open-settings="(section?: string) => openSettingsAt(section ?? 'integrations')"
                @close="ctxToggle(() => settings.toggleAgentPanel())"
              />
            </div>
          </template>
        </aside>
      </div>
      <StatusBar :line="cursorLine" :col="cursorCol" :selection-text="selectionText" />
      <!-- v4.3.0 PR #75 — right-click context menu for sidebar pane toggles. -->
      <Teleport to="body">
        <div
          v-if="sidebarCtx"
          class="sidebar-ctx"
          :style="{ left: sidebarCtx.x + 'px', top: sidebarCtx.y + 'px' }"
          @click.stop
        >
          <label class="sidebar-ctx__item" @click="ctxToggle(() => { searchOpen = !searchOpen })">
            <span class="sidebar-ctx__check">{{ searchOpen ? '✓' : '' }}</span>
            {{ t('rsPane.search') }}
          </label>
          <label class="sidebar-ctx__item" @click="ctxToggle(() => { if (tabs.activeTab) tabs.toggleOutline(tabs.activeTab.id) })">
            <span class="sidebar-ctx__check">{{ showOutlinePane ? '✓' : '' }}</span>
            {{ t('rsPane.outline') }}
          </label>
          <label class="sidebar-ctx__item" @click="ctxToggle(() => { settings.toggleBacklinks() })">
            <span class="sidebar-ctx__check">{{ settings.showBacklinks ? '✓' : '' }}</span>
            {{ t('rsPane.backlinks') }}
          </label>
          <label class="sidebar-ctx__item" @click="ctxToggle(() => { settings.toggleRelationships() })">
            <span class="sidebar-ctx__check">{{ settings.showRelationships ? '✓' : '' }}</span>
            {{ t('rsPane.relationships') }}
          </label>
          <label class="sidebar-ctx__item" @click="ctxToggle(() => { settings.toggleTagsPanel() })">
            <span class="sidebar-ctx__check">{{ settings.showTagsPanel ? '✓' : '' }}</span>
            {{ t('rsPane.tags') }}
          </label>
          <label class="sidebar-ctx__item" @click="ctxToggle(() => { settings.toggleNeighborhood() })">
            <span class="sidebar-ctx__check">{{ settings.showNeighborhood ? '✓' : '' }}</span>
            {{ t('rsPane.neighborhood') }}
          </label>
          <label class="sidebar-ctx__item" @click="ctxToggle(() => { settings.toggleTypesPanel() })">
            <span class="sidebar-ctx__check">{{ settings.showTypesPanel ? '✓' : '' }}</span>
            {{ t('rsPane.types') }}
          </label>
          <label class="sidebar-ctx__item" @click="ctxToggle(() => { settings.toggleHistoryPanel() })">
            <span class="sidebar-ctx__check">{{ settings.showHistoryPanel ? '✓' : '' }}</span>
            {{ t('rsPane.history') }}
          </label>
          <label v-if="!IS_APP_STORE_BUILD" class="sidebar-ctx__item" @click="ctxToggle(() => { settings.toggleAgentPanel() })">
            <span class="sidebar-ctx__check">{{ settings.showAgentPanel ? '✓' : '' }}</span>
            {{ t('rsPane.agent') }}
          </label>
        </div>
        <div v-if="sidebarCtx" class="sidebar-ctx__backdrop" @click="closeSidebarCtx" />
      </Teleport>
    </template>

    <AIRewriteOverlay
      v-if="!IS_APP_STORE_BUILD"
      :enabled="settings.aiEnabled"
      :provider="(settings.aiProvider as any)"
      :model="settings.aiModel"
      :base-url="settings.aiBaseUrl"
      :has-key="aiHasKey"
      @open-settings="(section?: string) => openSettingsAt(section ?? 'integrations')"
    />
    <CommandPalette :open="paletteOpen" @close="paletteOpen = false" />
    <QuickSwitcher :open="quickSwitcherOpen" @close="quickSwitcherOpen = false" />
    <SettingsPanel
      :open="settingsOpen"
      :initial-section="settingsInitialSection"
      @close="settingsOpen = false; settingsInitialSection = null; refreshAiHasKey()"
    />
    <MarkdownHelp :open="helpOpen" @close="helpOpen = false" />
    <RagSearch
      :open="ragSearchOpen"
      @close="ragSearchOpen = false"
      @open-settings="(section?: string) => { ragSearchOpen = false; openSettingsAt(section ?? 'writing'); }"
    />
    <CjkProofread :open="cjkProofreadOpen" @close="cjkProofreadOpen = false" />
    <AboutDialog :open="aboutOpen" @close="aboutOpen = false" />
    <AgentSetupWizard v-if="!IS_APP_STORE_BUILD" :open="wizardOpen" @close="wizardOpen = false" />
    <UnsavedDialog
      :open="unsavedOpen"
      :mode="unsavedMode"
      :file-name="unsavedFileName"
      :count="unsavedCount"
      @save="onUnsavedAction('save')"
      @discard="onUnsavedAction('discard')"
      @cancel="onUnsavedAction('cancel')"
    />
    <SessionRestoreDialog />
    <!-- v4.6 F5 — saved-view create/edit modal (self-mounts via window events). -->
    <ViewEditorDialog />
    <WhiteboardOverlay />
    <FileChangedDialog
      :open="fileChangedOpen"
      :file-name="fileChangedFileName"
      @reload="onFileChangedAction('reload')"
      @overwrite="onFileChangedAction('overwrite')"
      @cancel="onFileChangedAction('cancel')"
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
  /* v4.3.x issue #73 — respect mobile system-bar insets so the toolbar
     doesn't render under the Android status bar (carrier signal / battery
     / clock) and the bottom status bar doesn't overlap the gesture-nav
     bar. `env(safe-area-inset-*)` returns 0 on desktops where the
     property isn't defined, so this is a no-op there. */
  padding-top: env(safe-area-inset-top, 0);
  padding-bottom: env(safe-area-inset-bottom, 0);
  padding-left: env(safe-area-inset-left, 0);
  padding-right: env(safe-area-inset-right, 0);
  box-sizing: border-box;
}
.workspace {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}
/* v4.6 F5 — left column stacks the file tree above the Saved Views panel. */
.left-stack {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 0 0 auto;
}
.left-stack > :deep(.ftree) {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
}
.side-sidebar {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 260px;
  flex: 0 0 260px;
  min-width: 240px;
  background: var(--bg-soft, var(--bg));
}
.side-sidebar--left {
  border-right: 1px solid var(--border);
}
.side-sidebar--right {
  border-left: 1px solid var(--border);
}
/* Drag handle for live-resize. Sits on the inner edge of the sidebar
   (right edge of left sidebar, left edge of right sidebar) as a 5px
   hit zone. v4.0 — agent panel chat needs more width than read-only
   panes. */
.side-sidebar__resize {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: ew-resize;
  z-index: 10;
  background: transparent;
}
.side-sidebar__resize--right {
  right: -4px;
}
.side-sidebar__resize--left {
  left: -4px;
}
.side-sidebar__resize:hover {
  background: var(--accent, #6366f1);
  opacity: 0.5;
}
/* v4.3.0 PR #75 — right-click context menu floats over the workspace via
   <Teleport to="body">. Toolbar's master-toggle is the canonical hide
   action; the per-sidebar × close button is gone, since the menu doubles
   as a hide path (uncheck every pane = sidebar auto-hides). */
.sidebar-ctx {
  position: fixed;
  z-index: 9999;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 0;
  min-width: 160px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
  font-size: 13px;
  user-select: none;
}
.sidebar-ctx__item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 12px;
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  cursor: pointer;
  font: inherit;
  box-sizing: border-box;
}
.sidebar-ctx__item:hover {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}
.sidebar-ctx__check {
  display: inline-block;
  width: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--accent);
  flex-shrink: 0;
}
.sidebar-ctx__backdrop {
  position: fixed;
  inset: 0;
  z-index: 9998;
}
/* v4.0.2 — each pane lives inside an .rs-pane-host wrapper so the
   <RsSplitter> can find adjacent panes via [data-rs-pane] and resize
   them. Direct children of .side-sidebar are now: the resize handle,
   .rs-pane-host wrappers, and .rs-splitter elements between them. */
.rs-pane-host {
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
}
/* Agent Panel needs vertical room — chat scrollback, tool-call cards,
   compose box. Give it 4× the share Outline/Backlinks/Tags/History get
   when they coexist (so Agent ≈ 50% of sidebar height with all 5 on
   AND no splitter has been touched yet). Once the user drags a
   splitter the inline style overrides this. */
.rs-pane-host--agent {
  flex: 4 1 0;
  min-height: 240px;
}
.rs-pane-host > :deep(*) {
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  height: 100%;
}
.rs-pane-host :deep(.outline) {
  width: 100% !important;
  border-left: 0;
  border-right: 0;
}
.rs-pane-host :deep(.backlinks) {
  border-left: 0;
  border-right: 0;
}
.rs-pane-host :deep(.rel) {
  border-left: 0;
  border-right: 0;
}
/* v4.3.0 issue #57b — drag grip + drop-target highlight for right-sidebar
   reordering. Grip is intentionally subtle (8px dotted strip at the top of
   each pane); hovering surfaces it more clearly. Only the grip is draggable
   so text selection inside the pane still works. */
.rs-pane-grip {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 10px;
  flex: 0 0 10px;
  color: var(--text-faint);
  font-size: 8px;
  letter-spacing: 2px;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  background: transparent;
  transition: background 120ms, color 120ms;
}
.rs-pane-grip:hover {
  background: var(--bg-hover);
  color: var(--text-muted);
}
.rs-pane-grip:active {
  cursor: grabbing;
}
.rs-pane-host--dragging {
  opacity: 0.4;
}
.rs-pane-host--drop-target {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
}
/* Make sure the grip + content layout share vertical space cleanly. */
.rs-pane-host > .rs-pane-grip + :deep(*) {
  flex: 1 1 0;
  min-height: 0;
}
.content {
  flex: 1;
  display: flex;
  min-width: 0;
  overflow: hidden;
  position: relative;
}
</style>
