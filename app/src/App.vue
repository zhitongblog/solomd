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
import FileTree from './components/FileTree.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import MarkdownHelp from './components/MarkdownHelp.vue';
import GlobalSearch from './components/GlobalSearch.vue';
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

const tabs = useTabsStore();
const settings = useSettingsStore();
const tiles = useTilesStore();
const files = useFiles();
const exporter = useExport();
const { t } = useI18n();

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
(window as any).__solomd_showUnsavedDialog = showUnsavedDialog;

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

  // OS file association
  try {
    unlistenOpened = await listen<string>('solomd://opened-file', async (e) => {
      if (e.payload) await files.openPath(e.payload);
    });
  } catch (err) {
    console.warn('opened-file listener not available', err);
  }

  try {
    const pending = await invoke<string[]>('drain_pending_opens');
    for (const p of pending || []) {
      await files.openPath(p);
    }
  } catch (err) {
    console.warn('drain_pending_opens failed', err);
  }

  if (tabs.tabs.length === 0) tabs.newTab();

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
          if (isImagePath(path)) {
            await files.openPath(path);
          } else {
            await files.openPath(path);
          }
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

const showOutlinePane = computed(
  () => !!tabs.activeTab?.showOutline && tabs.activeTab?.language === 'markdown'
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
    <TelemetryBanner />
    <div class="workspace">
      <FileTree v-if="settings.showFileTree" />
      <Outline v-if="showOutlinePane" :cursor-line="cursorLine" @goto="onOutlineGoto" />
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
        <TileRoot :node="tiles.root" @cursor="onCursor" />
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
  position: relative;
}
.outline-toggle {
  position: absolute;
  top: 6px;
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
