<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useTabsStore } from '../stores/tabs';
import { useTilesStore } from '../stores/tiles';
import { useFiles } from '../composables/useFiles';
import { useI18n } from '../i18n';
import type { SplitDirection } from '../types';

const props = defineProps<{
  paneId: string;
  activeTabId: string;
}>();

const tabs = useTabsStore();
const tiles = useTilesStore();
const files = useFiles();
const { t } = useI18n();

const tabsEl = ref<HTMLElement | null>(null);

// When the active tab changes (e.g., opening a new file that creates a tab
// off-screen in a crowded tabbar), scroll it into view so the user sees
// the switch.
watch(
  () => props.activeTabId,
  async (id) => {
    if (!id) return;
    await nextTick();
    const el = tabsEl.value?.querySelector<HTMLElement>(`[data-tab-id="${id}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  },
);

// ---- Context menu ----
const ctxMenu = ref<{ x: number; y: number; tabId: string } | null>(null);

function onContextMenu(e: MouseEvent, tabId: string) {
  e.preventDefault();
  ctxMenu.value = { x: e.clientX, y: e.clientY, tabId };
}

function closeCtxMenu() {
  ctxMenu.value = null;
}

function splitPane(direction: SplitDirection) {
  tiles.splitPane(props.paneId, direction);
  closeCtxMenu();
}

function closePane() {
  tiles.closePane(props.paneId);
  closeCtxMenu();
}

// Tab-level close operations relative to the tab the menu was opened on.
const ctxFlags = computed(() => {
  if (!ctxMenu.value) return null;
  const list = tabs.tabs;
  const idx = list.findIndex((t) => t.id === ctxMenu.value!.tabId);
  if (idx < 0) return null;
  return {
    hasLeft: idx > 0,
    hasRight: idx < list.length - 1,
    hasOthers: list.length > 1,
    hasSaved: list.some((x) => x.id !== ctxMenu.value!.tabId && x.content === x.savedContent),
    hasAny: list.length > 0,
  };
});

async function closeMany(ids: string[]) {
  for (const id of ids) {
    if (!tabs.tabs.find((t) => t.id === id)) continue;
    await files.closeTabSafe(id);
  }
}

async function onTabAction(action: 'close' | 'closeLeft' | 'closeRight' | 'closeOthers' | 'closeSaved' | 'closeAll') {
  const m = ctxMenu.value;
  closeCtxMenu();
  if (!m) return;
  const list = tabs.tabs;
  const idx = list.findIndex((t) => t.id === m.tabId);
  if (idx < 0) return;
  const ids = (() => {
    switch (action) {
      case 'close':       return [m.tabId];
      case 'closeLeft':   return list.slice(0, idx).map((x) => x.id);
      case 'closeRight':  return list.slice(idx + 1).map((x) => x.id);
      case 'closeOthers': return list.filter((x) => x.id !== m.tabId).map((x) => x.id);
      case 'closeSaved':  return list.filter((x) => x.content === x.savedContent).map((x) => x.id);
      case 'closeAll':    return list.map((x) => x.id);
    }
  })();
  await closeMany(ids);
}

// ---- Drag to split ----
function onDragStart(e: DragEvent, tabId: string) {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData('text/plain', tabId);
  e.dataTransfer.effectAllowed = 'move';
}

// Close context menu on click outside
function onDocClick() {
  if (ctxMenu.value) closeCtxMenu();
}

import { onMounted, onBeforeUnmount } from 'vue';
onMounted(() => document.addEventListener('click', onDocClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocClick));
</script>

<template>
  <div class="pane-tabbar">
    <div class="tabs" ref="tabsEl">
      <div
        v-for="t in tabs.tabs"
        :key="t.id"
        :data-tab-id="t.id"
        class="tab"
        :class="{ 'tab--active': t.id === activeTabId }"
        @click="tiles.setActiveTab(paneId, t.id)"
        @contextmenu="onContextMenu($event, t.id)"
        draggable="true"
        @dragstart="onDragStart($event, t.id)"
        :title="t.filePath || t.fileName"
      >
        <span class="tab__name">{{ t.fileName }}</span>
        <span class="tab__dot" v-if="tabs.isDirty(t.id)">●</span>
        <button
          class="tab__close"
          @click.stop="files.closeTabSafe(t.id)"
          aria-label="Close tab"
        >×</button>
      </div>
    </div>
    <button class="tabbar__new" @click="files.newFile" title="New tab (Ctrl+N)">+</button>

    <!-- Context menu -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        class="ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @click.stop
      >
        <button class="ctx-item" @click="onTabAction('close')">{{ t('tabMenu.close') }}</button>
        <div class="ctx-sep" />
        <button class="ctx-item" :disabled="!ctxFlags?.hasLeft"   @click="onTabAction('closeLeft')">{{ t('tabMenu.closeLeft') }}</button>
        <button class="ctx-item" :disabled="!ctxFlags?.hasRight"  @click="onTabAction('closeRight')">{{ t('tabMenu.closeRight') }}</button>
        <button class="ctx-item" :disabled="!ctxFlags?.hasOthers" @click="onTabAction('closeOthers')">{{ t('tabMenu.closeOthers') }}</button>
        <div class="ctx-sep" />
        <button class="ctx-item" :disabled="!ctxFlags?.hasSaved" @click="onTabAction('closeSaved')">{{ t('tabMenu.closeSaved') }}</button>
        <button class="ctx-item" :disabled="!ctxFlags?.hasAny"   @click="onTabAction('closeAll')">{{ t('tabMenu.closeAll') }}</button>
        <div class="ctx-sep" />
        <button class="ctx-item" @click="splitPane('horizontal')">Split Right</button>
        <button class="ctx-item" @click="splitPane('vertical')">Split Down</button>
        <div class="ctx-sep" v-if="tiles.allLeaves.length > 1" />
        <button class="ctx-item" v-if="tiles.allLeaves.length > 1" @click="closePane">Close Pane</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.pane-tabbar {
  display: flex;
  align-items: stretch;
  height: var(--tabbar-h);
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  user-select: none;
  overflow: hidden;
  flex-shrink: 0;
}
.tabs {
  display: flex;
  flex: 1;
  overflow-x: auto;
  scrollbar-width: none;
}
.tabs::-webkit-scrollbar { display: none; }

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 200px;
  padding: 0 10px 0 14px;
  border-right: 1px solid var(--border);
  cursor: pointer;
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  position: relative;
}
.tab:hover {
  background: var(--bg-hover);
}
.tab--active {
  background: var(--bg);
  color: var(--text);
}
.tab--active::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 2px;
  background: var(--accent);
}
.tab__name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab__dot {
  color: var(--accent);
  font-size: 10px;
}
.tab__close {
  padding: 0 4px;
  font-size: 14px;
  line-height: 1;
  color: var(--text-faint);
  opacity: 0;
  transition: opacity 0.12s;
}
.tab:hover .tab__close,
.tab--active .tab__close {
  opacity: 1;
}
.tab__close:hover {
  color: var(--text);
  background: var(--bg-active);
}
.tabbar__new {
  width: 32px;
  padding: 0;
  font-size: 16px;
  color: var(--text-muted);
}
.ctx-menu {
  position: fixed;
  z-index: 9999;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 0;
  min-width: 140px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.2);
}
.ctx-item {
  display: block;
  width: 100%;
  padding: 6px 14px;
  text-align: left;
  font-size: 13px;
  color: var(--text);
  background: none;
  border: none;
  cursor: pointer;
}
.ctx-item:hover:not(:disabled) {
  background: var(--bg-hover);
}
.ctx-item:disabled {
  color: var(--text-faint);
  cursor: default;
}
.ctx-sep {
  height: 1px;
  margin: 4px 8px;
  background: var(--border);
}
</style>
