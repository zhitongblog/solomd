<script setup lang="ts">
import { onMounted, ref, watchEffect, computed } from 'vue';
import { getCurrentWebview } from '@tauri-apps/api/webview';
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
import Toast from './components/Toast.vue';
import { useTabsStore } from './stores/tabs';
import { useSettingsStore } from './stores/settings';
import { useFiles } from './composables/useFiles';
import { useShortcuts } from './composables/useShortcuts';

const tabs = useTabsStore();
const settings = useSettingsStore();
const files = useFiles();

const cursorLine = ref(1);
const cursorCol = ref(1);
const paletteOpen = ref(false);
const settingsOpen = ref(false);
const helpOpen = ref(false);
const editorRef = ref<InstanceType<typeof Editor> | null>(null);

useShortcuts({
  openPalette: () => (paletteOpen.value = true),
  openSettings: () => (settingsOpen.value = true),
  openHelp: () => (helpOpen.value = true),
});

// Esc closes the topmost modal
function onEsc(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  if (helpOpen.value) helpOpen.value = false;
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

watchEffect(() => {
  document.documentElement.setAttribute('data-theme', settings.theme);
});

function onOpenHelpEvent() {
  helpOpen.value = true;
}

onMounted(async () => {
  if (tabs.tabs.length === 0) tabs.newTab();
  window.addEventListener('keydown', onEsc);
  window.addEventListener('solomd:open-help', onOpenHelpEvent as EventListener);
  try {
    const webview = getCurrentWebview();
    await webview.onDragDropEvent(async (event) => {
      if (event.payload.type === 'drop') {
        for (const path of event.payload.paths) {
          await files.openPath(path);
        }
      }
    });
  } catch (e) {
    console.warn('drag-drop not available', e);
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
    />
    <TabBar />
    <div class="workspace">
      <FileTree v-if="settings.showFileTree" />
      <Outline v-if="showOutlinePane" @goto="onOutlineGoto" />
      <div class="content">
        <div class="pane pane--editor" v-if="showEditor && tabs.activeTab">
          <Editor ref="editorRef" :tab="tabs.activeTab" @cursor="onCursor" />
        </div>
        <div class="pane pane--preview" v-if="showPreview && tabs.activeTab">
          <Preview :source="tabs.activeTab.content" />
        </div>
      </div>
    </div>
    <StatusBar :line="cursorLine" :col="cursorCol" />

    <CommandPalette :open="paletteOpen" @close="paletteOpen = false" />
    <SettingsPanel :open="settingsOpen" @close="settingsOpen = false" />
    <MarkdownHelp :open="helpOpen" @close="helpOpen = false" />
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
