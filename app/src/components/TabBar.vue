<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useTabsStore } from '../stores/tabs';
import { useFiles } from '../composables/useFiles';
import { useI18n } from '../i18n';

const tabs = useTabsStore();
const files = useFiles();
const { t } = useI18n();

const tabsRef = ref<HTMLElement | null>(null);

function isDirty(id: string) {
  return tabs.isDirty(id);
}

// --- Right-click context menu ---------------------------------------------
interface MenuState { tabId: string; x: number; y: number }
const menu = ref<MenuState | null>(null);

function openMenu(e: MouseEvent, tabId: string) {
  e.preventDefault();
  menu.value = { tabId, x: e.clientX, y: e.clientY };
}
function closeMenu() {
  menu.value = null;
}
function onDocMouseDown(e: MouseEvent) {
  if (!menu.value) return;
  const el = e.target as HTMLElement | null;
  if (el && el.closest('.tab-menu')) return;
  closeMenu();
}
onMounted(() => document.addEventListener('mousedown', onDocMouseDown, true));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMouseDown, true));

// Menu availability flags.
const menuFlags = computed(() => {
  if (!menu.value) return null;
  const list = tabs.tabs;
  const idx = list.findIndex((t) => t.id === menu.value!.tabId);
  if (idx < 0) return null;
  return {
    hasLeft: idx > 0,
    hasRight: idx < list.length - 1,
    hasOthers: list.length > 1,
    hasSaved: list.some((t) => t.id !== menu.value!.tabId && t.content === t.savedContent),
    hasAll: list.length > 0,
  };
});

async function closeMany(ids: string[]) {
  // closeTabSafe shows unsaved dialog when needed; close sequentially so
  // prompts don't stack up. User can cancel at any step to stop the batch.
  for (const id of ids) {
    if (!tabs.tabs.find((t) => t.id === id)) continue;
    await files.closeTabSafe(id);
  }
}

async function onMenu(action: 'close' | 'closeLeft' | 'closeRight' | 'closeOthers' | 'closeSaved' | 'closeAll') {
  const m = menu.value;
  closeMenu();
  if (!m) return;
  const list = tabs.tabs;
  const idx = list.findIndex((t) => t.id === m.tabId);
  if (idx < 0) return;
  const ids = (() => {
    switch (action) {
      case 'close':       return [m.tabId];
      case 'closeLeft':   return list.slice(0, idx).map((t) => t.id);
      case 'closeRight':  return list.slice(idx + 1).map((t) => t.id);
      case 'closeOthers': return list.filter((t) => t.id !== m.tabId).map((t) => t.id);
      case 'closeSaved':  return list.filter((t) => t.content === t.savedContent).map((t) => t.id);
      case 'closeAll':    return list.map((t) => t.id);
    }
  })();
  await closeMany(ids);
}

// When the active tab changes (e.g., opening a new file that creates a tab
// off-screen), scroll it into view so the user actually sees the switch.
watch(
  () => tabs.activeId,
  async (id) => {
    if (!id) return;
    await nextTick();
    const el = tabsRef.value?.querySelector<HTMLElement>(`[data-tab-id="${id}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  },
);
</script>

<template>
  <div class="tabbar">
    <div class="tabs" ref="tabsRef">
      <div
        v-for="tab in tabs.tabs"
        :key="tab.id"
        :data-tab-id="tab.id"
        class="tab"
        :class="{ 'tab--active': tab.id === tabs.activeId }"
        @click="tabs.activate(tab.id)"
        @contextmenu="openMenu($event, tab.id)"
        :title="tab.filePath || tab.fileName"
      >
        <span class="tab__name">{{ tab.fileName }}</span>
        <span class="tab__outline" v-if="tab.showOutline && tab.language === 'markdown'" title="Outline on">≡</span>
        <span class="tab__dot" v-if="isDirty(tab.id)">●</span>
        <button
          class="tab__close"
          @click.stop="files.closeTabSafe(tab.id)"
          aria-label="Close tab"
        >×</button>
      </div>
    </div>
    <button class="tabbar__new" @click="files.newFile" title="New tab (Ctrl+N)">+</button>

    <!-- Context menu portal -->
    <ul
      v-if="menu"
      class="tab-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
    >
      <li><button @mousedown.prevent="onMenu('close')">{{ t('tabMenu.close') }}</button></li>
      <li class="tab-menu__sep"></li>
      <li><button :disabled="!menuFlags?.hasLeft"   @mousedown.prevent="onMenu('closeLeft')">{{ t('tabMenu.closeLeft') }}</button></li>
      <li><button :disabled="!menuFlags?.hasRight"  @mousedown.prevent="onMenu('closeRight')">{{ t('tabMenu.closeRight') }}</button></li>
      <li><button :disabled="!menuFlags?.hasOthers" @mousedown.prevent="onMenu('closeOthers')">{{ t('tabMenu.closeOthers') }}</button></li>
      <li class="tab-menu__sep"></li>
      <li><button :disabled="!menuFlags?.hasSaved" @mousedown.prevent="onMenu('closeSaved')">{{ t('tabMenu.closeSaved') }}</button></li>
      <li><button :disabled="!menuFlags?.hasAll"   @mousedown.prevent="onMenu('closeAll')">{{ t('tabMenu.closeAll') }}</button></li>
    </ul>
  </div>
</template>

<style scoped>
.tabbar {
  display: flex;
  align-items: stretch;
  height: var(--tabbar-h);
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  user-select: none;
  overflow: hidden;
  position: relative;
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
.tab__outline {
  font-size: 11px;
  color: var(--text-faint);
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

/* Right-click menu */
.tab-menu {
  position: fixed;
  list-style: none;
  margin: 0;
  padding: 4px 0;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  z-index: 1500;
  min-width: 180px;
}
.tab-menu li { padding: 0; }
.tab-menu button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 14px;
  border: 0;
  background: none;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
}
.tab-menu button:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--accent);
}
.tab-menu button:disabled {
  color: var(--text-faint);
  cursor: default;
}
.tab-menu__sep {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}
</style>
