<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, watchEffect, computed } from 'vue';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
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

onMounted(async () => {
  window.addEventListener('keydown', onEsc);
  window.addEventListener('solomd:open-help', onOpenHelpEvent as EventListener);
  window.addEventListener('solomd:open-global-search', onOpenSearchEvent as EventListener);

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
      <Outline v-if="showOutlinePane" @goto="onOutlineGoto" />
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
