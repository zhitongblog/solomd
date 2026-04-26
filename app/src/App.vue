<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, watchEffect, computed, provide } from 'vue';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import Toolbar from './components/Toolbar.vue';
import TelemetryBanner from './components/TelemetryBanner.vue';
import TileRoot from './components/TileRoot.vue';
import StatusBar from './components/StatusBar.vue';
import CommandPalette from './components/CommandPalette.vue';
import Outline from './components/Outline.vue';
import BacklinksPanel from './components/BacklinksPanel.vue';
import TagsPanel from './components/TagsPanel.vue';
import HistoryPanel from './components/HistoryPanel.vue';
import { useAutoCommit } from './composables/useAutoCommit';
import AIRewriteOverlay from './components/AIRewriteOverlay.vue';
import BasesView from './components/BasesView.vue';
import { BASES_OPEN_EVENT, BASES_CLOSE_EVENT } from './composables/useBasesView';
import FileTree from './components/FileTree.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import MarkdownHelp from './components/MarkdownHelp.vue';
import GlobalSearch from './components/GlobalSearch.vue';
import RagSearch from './components/RagSearch.vue';
import ReadingView from './components/ReadingView.vue';
import AboutDialog from './components/AboutDialog.vue';
import UnsavedDialog from './components/UnsavedDialog.vue';
import Toast from './components/Toast.vue';
import { useTabsStore } from './stores/tabs';
import { useSettingsStore } from './stores/settings';
import { useTilesStore } from './stores/tiles';
import { useFiles } from './composables/useFiles';
import { useExport } from './composables/useExport';
import { useShortcuts } from './composables/useShortcuts';
import { loadCustomTheme } from './lib/custom-theme';
import { isIOS } from './lib/platform';
import { useI18n } from './i18n';
import { track } from './lib/telemetry';
import { openWelcomeTour } from './lib/welcome-tour';
import { useWorkspaceStore } from './stores/workspace';
import { useWorkspaceIndexStore } from './stores/workspaceIndex';
import { useRagStore } from './stores/rag';

const tabs = useTabsStore();
const settings = useSettingsStore();
const tiles = useTilesStore();
const files = useFiles();
const exporter = useExport();
const workspace = useWorkspaceStore();
const workspaceIndex = useWorkspaceIndexStore();
const rag = useRagStore();
const autoCommit = useAutoCommit();
autoCommit.start();
const { t } = useI18n();

const cursorLine = ref(1);
const cursorCol = ref(1);
const paletteOpen = ref(false);
const settingsOpen = ref(false);
const helpOpen = ref(false);
const searchOpen = ref(false);
const ragSearchOpen = ref(false);
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
(window as any).__solomd_showUnsavedDialog = showUnsavedDialog;

useShortcuts({
  openPalette: () => (paletteOpen.value = true),
  openSettings: () => (settingsOpen.value = true),
  openHelp: () => (helpOpen.value = true),
  openGlobalSearch: () => (searchOpen.value = true),
  openRagSearch: () => (ragSearchOpen.value = true),
});

// Esc closes the topmost modal
function onEsc(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  if (aboutOpen.value) aboutOpen.value = false;
  else if (ragSearchOpen.value) ragSearchOpen.value = false;
  else if (searchOpen.value) searchOpen.value = false;
  else if (helpOpen.value) helpOpen.value = false;
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

// v2.4: push the active folder into the capture endpoint's view of the
// world, so the localhost HTTP server knows where to write captured notes
// (or returns 503 when no folder is open).
watchEffect(() => {
  const folder = workspace.currentFolder;
  invoke('capture_set_workspace', { folder: folder ?? null }).catch(() => {});
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

// Window size + position are persisted by tauri-plugin-window-state on the
// Rust side. The plugin clamps restored coordinates to the current monitor
// set, which prevents the "window is off-screen, only taskbar thumbnail
// visible" bug that the old localStorage approach had.
// Remove stale localStorage entry from earlier versions on first run.
try {
  localStorage.removeItem('solomd.window.v1');
} catch {}

onMounted(async () => {
  window.addEventListener('keydown', onEsc);
  window.addEventListener('solomd:open-help', onOpenHelpEvent as EventListener);
  window.addEventListener('solomd:open-global-search', onOpenSearchEvent as EventListener);

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
  try {
    const params = new URLSearchParams(window.location.search);
    const initialPath = params.get('path');
    if (initialPath) {
      await files.openPath(initialPath, { bypassNewWindow: true });
    }
  } catch {}

  // First-launch welcome tour: only when there are no tabs at all (fresh
  // install or user has cleared session) and we haven't shown it before.
  const isFreshLaunch = tabs.tabs.length === 0 && !settings.welcomeShown;
  if (isFreshLaunch) {
    openWelcomeTour();
    settings.markWelcomeShown();
  } else if (tabs.tabs.length === 0) {
    tabs.newTab();
  }

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
    await webview.onDragDropEvent(async (event) => {
      if (event.payload.type === 'drop') {
        for (const path of event.payload.paths) {
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
function onOpenBases() { basesOpen.value = true; }
function onCloseBases() { basesOpen.value = false; }

async function onWikiOpen(e: Event) {
  const detail = (e as CustomEvent).detail || {};
  const target: string = detail.target || '';
  if (!target) return;
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
function onOpenSettingsEvent() { settingsOpen.value = true; }

window.addEventListener('solomd:wiki-open', onWikiOpen as EventListener);
window.addEventListener('solomd:ai-rewrite-accept', onAIRewriteAccept as EventListener);
window.addEventListener('solomd:ai-rewrite-cancel', onAIRewriteCancel as EventListener);
window.addEventListener(BASES_OPEN_EVENT, onOpenBases as EventListener);
window.addEventListener(BASES_CLOSE_EVENT, onCloseBases as EventListener);
window.addEventListener('solomd:open-settings', onOpenSettingsEvent as EventListener);

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onEsc);
  window.removeEventListener('solomd:open-help', onOpenHelpEvent as EventListener);
  window.removeEventListener('solomd:open-global-search', onOpenSearchEvent as EventListener);
  window.removeEventListener('solomd:wiki-open', onWikiOpen as EventListener);
  window.removeEventListener('solomd:ai-rewrite-accept', onAIRewriteAccept as EventListener);
  window.removeEventListener('solomd:ai-rewrite-cancel', onAIRewriteCancel as EventListener);
  window.removeEventListener(BASES_OPEN_EVENT, onOpenBases as EventListener);
  window.removeEventListener(BASES_CLOSE_EVENT, onCloseBases as EventListener);
  window.removeEventListener('solomd:open-settings', onOpenSettingsEvent as EventListener);
  if (unlistenOpened) {
    unlistenOpened();
    unlistenOpened = null;
  }
  if (unlistenMenu) {
    unlistenMenu();
    unlistenMenu = null;
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
const showTagsPane = computed(
  () => settings.showTagsPanel && !!workspace.currentFolder,
);
const showHistoryPane = computed(
  // One concept, one switch: AutoGit on = panel visible. The legacy
  // `showHistoryPanel` field is kept in the store for back-compat with
  // older persisted state but is no longer surfaced as a separate
  // toggle in Settings.
  () =>
    settings.autoGitEnabled &&
    tabs.activeTab?.language === 'markdown' &&
    !!workspace.currentFolder,
);
const showRightSidebar = computed(
  () =>
    showOutlinePane.value ||
    showBacklinksPane.value ||
    showTagsPane.value ||
    showHistoryPane.value,
);
const basesOpen = ref(false);
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
  <div class="app" :class="{ 'app--reading': settings.viewMode === 'reading' }">
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
        @open-settings="settingsOpen = true"
        @open-help="helpOpen = true"
        @open-search="searchOpen = true"
      />
      <TelemetryBanner />
      <div class="workspace">
        <FileTree v-if="settings.showFileTree" />
        <div class="content">
          <button
            v-if="tabs.activeTab?.language === 'markdown' && !showOutlinePane"
            class="outline-toggle"
            @click="tabs.activeId && tabs.toggleOutline(tabs.activeId)"
            :title="t('toolbar.outlineTooltip')"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
          <BasesView v-if="basesOpen" />
          <TileRoot v-else :node="tiles.root" @cursor="onCursor" />
        </div>
        <aside v-if="showRightSidebar" class="right-sidebar">
          <Outline v-if="showOutlinePane" :cursor-line="cursorLine" @goto="onOutlineGoto" />
          <BacklinksPanel v-if="showBacklinksPane" />
          <TagsPanel v-if="showTagsPane" />
          <HistoryPanel v-if="showHistoryPane" />
        </aside>
      </div>
      <StatusBar :line="cursorLine" :col="cursorCol" />
    </template>

    <AIRewriteOverlay
      :enabled="settings.aiEnabled"
      :provider="(settings.aiProvider as any)"
      :model="settings.aiModel"
      :base-url="settings.aiBaseUrl"
      :has-key="aiHasKey"
      @open-settings="settingsOpen = true"
    />
    <CommandPalette :open="paletteOpen" @close="paletteOpen = false" />
    <SettingsPanel
      :open="settingsOpen"
      @close="settingsOpen = false; refreshAiHasKey()"
    />
    <MarkdownHelp :open="helpOpen" @close="helpOpen = false" />
    <GlobalSearch :open="searchOpen" @close="searchOpen = false" />
    <RagSearch
      :open="ragSearchOpen"
      @close="ragSearchOpen = false"
      @open-settings="ragSearchOpen = false; settingsOpen = true"
    />
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
.right-sidebar {
  display: flex;
  flex-direction: column;
  width: 260px;
  flex: 0 0 260px;
  min-width: 0;
  border-left: 1px solid var(--border);
  background: var(--bg-soft, var(--bg));
}
.right-sidebar > :deep(*) {
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  /* Reset Outline's own width since it now lives in a sized container. */
}
.right-sidebar > :deep(.outline) {
  width: 100% !important;
  border-left: 0;
}
.right-sidebar > :deep(.backlinks) {
  border-top: 1px solid var(--border);
  border-left: 0;
}
.right-sidebar > :deep(*:first-child:nth-last-child(1)) {
  /* When only one panel is shown, ensure no top-border leak */
  border-top: 0;
}
.content {
  flex: 1;
  display: flex;
  min-width: 0;
  overflow: hidden;
  position: relative;
}
.outline-toggle {
  position: absolute;
  top: calc(var(--tabbar-h, 34px) + 6px);
  left: 6px;
  z-index: 10;
  padding: 4px 6px;
  border-radius: 4px;
  color: var(--text-faint);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  opacity: 0;
  transition: opacity 0.15s;
  cursor: pointer;
}
.outline-toggle:hover {
  opacity: 1 !important;
  color: var(--text-muted);
}
.content:hover > .outline-toggle {
  opacity: 0.5;
}
</style>
