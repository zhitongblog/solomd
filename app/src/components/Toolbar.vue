<script setup lang="ts">
import { computed, ref } from 'vue';
import { useTabsStore } from '../stores/tabs';
import { useSettingsStore } from '../stores/settings';
import { useWorkspaceStore } from '../stores/workspace';
import { useFiles } from '../composables/useFiles';
import { useExport } from '../composables/useExport';

defineEmits<{
  (e: 'open-palette'): void;
  (e: 'open-settings'): void;
  (e: 'open-help'): void;
}>();

const tabs = useTabsStore();
const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const files = useFiles();
const exporter = useExport();

const isMarkdown = computed(() => tabs.activeTab?.language === 'markdown');

const recentOpen = ref(false);
const exportOpen = ref(false);

function shortPath(p: string) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function closeRecentSoon() {
  setTimeout(() => (recentOpen.value = false), 150);
}
function closeExportSoon() {
  setTimeout(() => (exportOpen.value = false), 150);
}
</script>

<template>
  <div class="toolbar">
    <div class="toolbar__brand">
      <span class="brand__hash">#</span><span class="brand__md">MD</span>
    </div>

    <div class="toolbar__group">
      <button @click="files.newFile" title="New (Ctrl+N)">New</button>
      <button @click="files.openFile" title="Open (Ctrl+O)">Open</button>
      <div class="dropdown">
        <button
          @click="recentOpen = !recentOpen"
          @blur="closeRecentSoon"
          title="Recent files"
        >Recent ▾</button>
        <div v-if="recentOpen" class="dropdown__menu">
          <div v-if="!workspace.recentFiles.length" class="dropdown__empty">No recent files</div>
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
          >Clear recent</button>
        </div>
      </div>
      <button @click="files.openFolder" title="Open folder">Folder</button>
      <button @click="files.saveActive" title="Save (Ctrl+S)">Save</button>
      <button @click="files.saveActiveAs" title="Save As (Ctrl+Shift+S)">Save As</button>
      <div class="dropdown">
        <button
          @click="exportOpen = !exportOpen"
          @blur="closeExportSoon"
          title="Export / Copy"
        >Export ▾</button>
        <div v-if="exportOpen" class="dropdown__menu">
          <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.exportHtml(); exportOpen = false">
            <span class="dropdown__name">Export to HTML…</span>
          </button>
          <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.exportDocx(); exportOpen = false">
            <span class="dropdown__name">Export to Word (DOCX)…</span>
          </button>
          <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.exportPdf(); exportOpen = false">
            <span class="dropdown__name">Export to PDF…</span>
          </button>
          <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.exportPdfPrint(); exportOpen = false">
            <span class="dropdown__name">Export to PDF via Print…</span>
          </button>
          <div class="dropdown__sep"></div>
          <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.copyAsHtml(); exportOpen = false">
            <span class="dropdown__name">Copy as HTML</span>
          </button>
          <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.copyAsPlainText(); exportOpen = false">
            <span class="dropdown__name">Copy as Plain Text</span>
          </button>
          <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.copyAsMarkdown(); exportOpen = false">
            <span class="dropdown__name">Copy as Markdown</span>
          </button>
        </div>
      </div>
    </div>

    <div class="toolbar__spacer"></div>

    <div class="toolbar__group" v-if="isMarkdown">
      <button
        @click="settings.setViewMode('edit')"
        :class="{ active: settings.viewMode === 'edit' }"
        title="Edit only"
      >Edit</button>
      <button
        @click="settings.setViewMode('split')"
        :class="{ active: settings.viewMode === 'split' }"
        title="Split (Ctrl+Shift+P)"
      >Split</button>
      <button
        @click="settings.setViewMode('preview')"
        :class="{ active: settings.viewMode === 'preview' }"
        title="Preview only"
      >Preview</button>
      <span class="toolbar__divider"></span>
      <button
        @click="settings.toggleLivePreview"
        :class="{ active: settings.livePreview }"
        :title="settings.livePreview ? 'Live preview ON — click for raw source' : 'Raw source — click for live preview'"
      >{{ settings.livePreview ? '◉ Live' : '○ Raw' }}</button>
    </div>

    <div class="toolbar__group">
      <button
        @click="settings.toggleFileTree"
        :class="{ active: settings.showFileTree }"
        title="Toggle file tree (Ctrl+B)"
      >☰</button>
      <button
        v-if="isMarkdown"
        @click="settings.toggleOutline"
        :class="{ active: settings.showOutline }"
        title="Toggle outline (Ctrl+Shift+O)"
      >⌘</button>
      <button @click="$emit('open-palette')" title="Command palette (Ctrl+Shift+K)">⌕</button>
      <button @click="$emit('open-help')" title="Markdown cheatsheet (F1 or Ctrl+/)">?</button>
      <button @click="$emit('open-settings')" title="Settings (Ctrl+,)">⚙</button>
      <button @click="settings.toggleTheme" :title="settings.theme === 'dark' ? 'Light mode' : 'Dark mode'">
        {{ settings.theme === 'dark' ? '☀' : '☾' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--titlebar-h);
  padding: 0 12px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  user-select: none;
}
.toolbar__brand {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.02em;
  margin-right: 4px;
}
.brand__hash { color: var(--accent); }
.brand__md { color: var(--text); }

.toolbar__group {
  display: flex;
  gap: 2px;
  align-items: center;
}
.toolbar__group button {
  font-size: 12px;
  padding: 4px 10px;
  color: var(--text-muted);
}
.toolbar__group button.active {
  background: var(--bg-active);
  color: var(--text);
}
.toolbar__spacer { flex: 1; }
.toolbar__divider {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 4px;
}

.dropdown {
  position: relative;
}
.dropdown__menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 280px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  z-index: 100;
  padding: 4px;
  max-height: 360px;
  overflow-y: auto;
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
.dropdown__item--muted {
  color: var(--text-muted);
  font-size: 11px;
}
.dropdown__item--single {
  flex-direction: row;
  align-items: center;
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
