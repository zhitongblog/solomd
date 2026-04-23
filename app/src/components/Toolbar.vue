<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icons.vue';
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

const recentOpen = ref(false);
const exportOpen = ref(false);
const newOpen = ref(false);
const copyOpen = ref(false);
const insertOpen = ref(false);

function dispatchInsert(snippet: string) {
  window.dispatchEvent(
    new CustomEvent('solomd:insert-markdown', {
      detail: { snippet, paneId: tiles.focusedPaneId },
    })
  );
  insertOpen.value = false;
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
  copyOpen.value = false;
  insertOpen.value = false;
}
// Exclusive open: opening one dropdown closes others.
function toggleDropdown(name: 'new' | 'recent' | 'export' | 'copy' | 'insert') {
  const isOpen =
    (name === 'new' && newOpen.value) ||
    (name === 'recent' && recentOpen.value) ||
    (name === 'export' && exportOpen.value) ||
    (name === 'copy' && copyOpen.value) ||
    (name === 'insert' && insertOpen.value);
  closeAllDropdowns();
  if (!isOpen) {
    if (name === 'new') newOpen.value = true;
    else if (name === 'recent') recentOpen.value = true;
    else if (name === 'export') exportOpen.value = true;
    else if (name === 'copy') copyOpen.value = true;
    else if (name === 'insert') insertOpen.value = true;
  }
}
function onDocClick(e: MouseEvent) {
  // If the click is inside any .dropdown, leave it to the dropdown's own
  // handlers (toggle on button, mousedown on item).
  const target = e.target as HTMLElement | null;
  if (target && target.closest('.dropdown')) return;
  closeAllDropdowns();
}
onMounted(() => {
  document.addEventListener('click', onDocClick, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true);
});
</script>

<template>
  <div class="toolbar">
    <div class="toolbar__brand">
      <span class="brand__hash">#</span><span class="brand__md">MD</span>
    </div>

    <div class="toolbar__group">
      <div class="dropdown">
        <button
          class="icon-btn"
          @click="toggleDropdown('new')"
          :title="t('toolbar.newFile')"
        >
          <Icon name="new" />
          <Icon name="chevron-down" :size="10" />
        </button>
        <div v-if="newOpen" class="dropdown__menu dropdown__menu--narrow">
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
      </div>
      <button class="icon-btn" @click="files.openFile" :title="t('toolbar.openFileTooltip')">
        <Icon name="open" />
      </button>
      <div class="dropdown">
        <button
          class="icon-btn"
          @click="toggleDropdown('recent')"
          :title="t('toolbar.recent')"
        >
          <Icon name="recent" />
          <Icon name="chevron-down" :size="10" />
        </button>
        <div v-if="recentOpen" class="dropdown__menu">
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
      <div class="dropdown">
        <button
          class="icon-btn"
          @click="toggleDropdown('export')"
          :title="t('toolbar.exportTooltip')"
        >
          <Icon name="export" />
          <Icon name="chevron-down" :size="10" />
        </button>
        <div v-if="exportOpen" class="dropdown__menu">
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
        </div>
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
    </div>

    <div class="toolbar__group" v-if="isMarkdown">
      <div class="dropdown">
        <button
          class="icon-btn"
          @click="toggleDropdown('insert')"
          :title="t('toolbar.insertTooltip')"
        >
          <Icon name="insert" />
          <Icon name="chevron-down" :size="10" />
        </button>
        <div v-if="insertOpen" class="dropdown__menu">
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
          <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('> $|$')">
            <span class="dropdown__name">{{ t('toolbar.insertQuote') }}</span>
          </button>
          <button class="dropdown__item dropdown__item--single" @mousedown.prevent="dispatchInsert('\n---\n')">
            <span class="dropdown__name">{{ t('toolbar.insertDivider') }}</span>
          </button>
        </div>
      </div>
    </div>

    <div class="toolbar__group">
      <button
        class="icon-btn clean-ai-btn"
        @click="onCleanAI"
        v-bind:title="t('toolbar.cleanAiTitle')"
      >
        <span class="clean-ai-label">AI</span>
        <span class="clean-ai-x">✕</span>
      </button>
    </div>

    <div class="toolbar__group">
      <div class="copy-split">
        <button
          class="copy-split__main"
          @click="exporter.copyAsHtml()"
          :title="t('toolbar.copyTooltip')"
        >
          <Icon name="export" :size="14" />
          {{ t('toolbar.copy') }}
        </button>
        <div class="dropdown">
          <button
            class="copy-split__arrow"
            @click="toggleDropdown('copy')"
            :title="t('toolbar.copyFormats')"
          >
            <Icon name="chevron-down" :size="10" />
          </button>
          <div v-if="copyOpen" class="dropdown__menu dropdown__menu--narrow copy-dropdown">
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.copyAsHtml(); copyOpen = false">
              <span class="dropdown__name">{{ '📋 ' + t('toolbar.copyHtml') }}</span>
              <span class="dropdown__shortcut">⇧⌘C</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.copyAsMarkdown(); copyOpen = false">
              <span class="dropdown__name">{{ '📝 ' + t('toolbar.copyMarkdown') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.copyAsPlainText(); copyOpen = false">
              <span class="dropdown__name">{{ '📄 ' + t('toolbar.copyPlain') }}</span>
            </button>
            <button class="dropdown__item dropdown__item--single" @mousedown.prevent="exporter.copyAsImage(); copyOpen = false">
              <span class="dropdown__name">{{ '🖼 ' + t('toolbar.copyImage') }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="toolbar__spacer"></div>

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
        @click="() => { settings.setViewMode('preview'); track('view_mode', { mode: 'preview' }); }"
        :class="{ active: settings.viewMode === 'preview' }"
        :title="t('toolbar.previewOnly')"
      >
        <Icon name="view-preview" />
      </button>
      <span class="toolbar__divider" v-if="settings.viewMode !== 'preview'"></span>
      <button
        v-if="settings.viewMode !== 'preview'"
        class="icon-btn"
        @click="() => { settings.toggleLivePreview(); track('live_preview_toggled', { on: settings.livePreview ? 1 : 0 }); }"
        :class="{ active: settings.livePreview }"
        :title="settings.livePreview ? t('toolbar.livePreviewOn') : t('toolbar.livePreviewOff')"
      >
        <Icon :name="settings.livePreview ? 'live' : 'source'" />
      </button>
      <button
        v-if="settings.viewMode !== 'edit'"
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
      <button
        class="icon-btn"
        @click="settings.toggleFocusMode"
        :class="{ active: settings.focusMode }"
        :title="t('toolbar.focusModeTooltip')"
      >
        <Icon name="focus" />
      </button>
      <button
        class="icon-btn"
        @click="settings.toggleTypewriterMode"
        :class="{ active: settings.typewriterMode }"
        :title="t('toolbar.typewriterTooltip')"
      >
        <Icon name="typewriter" />
      </button>
      <button
        class="icon-btn"
        @click="settings.toggleSpellCheck"
        :class="{ active: settings.spellCheck }"
        :title="t('toolbar.spellCheckTooltip')"
      >
        <Icon name="spellcheck" />
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
.clean-ai-x {
  font-size: 9px;
  opacity: 0.6;
  margin-left: 1px;
}

/* Split copy button: [Copy | ▾] */
.copy-split {
  display: inline-flex;
  align-items: stretch;
  border: 1px solid var(--border);
  border-radius: 6px;
  /* NOTE: no overflow:hidden here — it would clip the dropdown menu */
  position: relative;
}
.copy-split__main {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px !important;
  font-size: 12px !important;
  color: var(--text-muted);
  border: none;
  border-radius: 6px 0 0 6px;
  transition: all 0.15s;
}
.copy-split__main:hover {
  color: var(--accent);
  background: var(--bg-hover);
}
.copy-split__arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  padding: 0 !important;
  border: none;
  border-left: 1px solid var(--border);
  border-radius: 0 6px 6px 0;
  color: var(--text-faint);
}
.copy-split__arrow:hover {
  color: var(--accent);
  background: var(--bg-hover);
}
.copy-dropdown {
  right: 0;
  left: auto;
  min-width: 220px;
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
