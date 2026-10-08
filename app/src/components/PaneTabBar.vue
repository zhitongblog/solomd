<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { revealInFileManager } from '../lib/reveal-in-file-manager';
import { useTabsStore } from '../stores/tabs';
import { useToastsStore } from '../stores/toasts';
import { useTilesStore } from '../stores/tiles';
import { useSettingsStore } from '../stores/settings';
import { useWorkspaceStore } from '../stores/workspace';
import { useFiles } from '../composables/useFiles';
import { requestRevealInTree } from '../composables/useFileTreeReveal';
import { shortcutLabel } from '../lib/keybindings';
import { usesCommandKey } from '../lib/platform';
import { useI18n } from '../i18n';
import Icon from './Icons.vue';
import type { SplitDirection } from '../types';

const props = withDefaults(
  defineProps<{
    paneId: string;
    activeTabId: string;
    /** 'pane': the strip at the top of a pane (default). 'header': rendered
     *  inside the 52px window header by the shell (5.0 §3). */
    placement?: 'pane' | 'header';
  }>(),
  { placement: 'pane' },
);

const tabs = useTabsStore();
const tiles = useTilesStore();
const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const files = useFiles();
const { t } = useI18n();
const macChord = usesCommandKey();
/** "New tab (Ctrl+N)" — the chord is read at render time so a rebind in
 *  Settings shows up here (same reason CommandPalette does it). */
const newTabChord = shortcutLabel('file.new', settings.keybindings, macChord);

const tabsEl = ref<HTMLElement | null>(null);

// #263 / #306 — dragging a tab onto the editor splits it, and the new pane
// had no visible way to close: closing its tab just refills the pane with
// another one, and "Close Pane" lived only in the command palette. The layout
// is also restored on the next launch, so people were left with panes they
// could not get rid of even across reinstalls. Every pane gets a close button
// while there is more than one.
const canClosePane = computed(() => tiles.allLeaves.length > 1);

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
  const target = list[idx];
  return {
    hasLeft: idx > 0,
    hasRight: idx < list.length - 1,
    hasOthers: list.length > 1,
    hasSaved: list.some((x) => x.id !== ctxMenu.value!.tabId && x.content === x.savedContent),
    hasAny: list.length > 0,
    // Issue #64 — "Open Enclosing Folder" only meaningful when the tab
    // is backed by a real on-disk path. Untitled / unsaved buffers have
    // no path, so the menu item is rendered disabled.
    hasFilePath: !!target?.filePath,
    isMarkdown: target?.language === 'markdown',
    showOutline: !!target?.showOutline,
  };
});

function onToggleOutline() {
  const m = ctxMenu.value;
  closeCtxMenu();
  if (m) tabs.toggleOutline(m.tabId);
}

async function closeMany(ids: string[]) {
  for (const id of ids) {
    if (!tabs.tabs.find((t) => t.id === id)) continue;
    await files.closeTabSafe(id);
  }
}

async function onTabAction(action: 'close' | 'closeLeft' | 'closeRight' | 'closeOthers' | 'closeSaved' | 'closeAll' | 'revealInFolder' | 'revealInFileTree') {
  const m = ctxMenu.value;
  closeCtxMenu();
  if (!m) return;
  const list = tabs.tabs;
  const idx = list.findIndex((t) => t.id === m.tabId);
  if (idx < 0) return;
  if (action === 'revealInFolder') {
    const path = list[idx]?.filePath;
    if (!path) return;
    try { await revealInFileManager(path); } catch (e) { useToastsStore().error(`${e}`); }
    return;
  }
  if (action === 'revealInFileTree') {
    const path = list[idx]?.filePath;
    if (!path) return;
    if (!settings.showFileTree) settings.toggleFileTree();
    // Revealing is a view action, so the workspace is left alone when the file
    // is already inside it — re-rooting the tree at the file's folder (what
    // this used to do) moved the user's workspace, churned the recent-folder
    // list, and looked like a no-op whenever the file sat directly in the root.
    // Only a file from outside the workspace needs the tree to follow it;
    // otherwise there would be nothing to point at.
    const root = workspace.currentFolder;
    const sep = path.includes('\\') ? '\\' : '/';
    const inside =
      !!root && (path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));
    if (!inside) {
      const parent = path.replace(/[\\/][^\\/]+$/, '');
      if (parent && parent !== path) workspace.setFolder(parent);
    }
    requestRevealInTree(path);
    return;
  }
  const ids = (() => {
    switch (action) {
      case 'close':       return [m.tabId];
      case 'closeLeft':   return list.slice(0, idx).map((x) => x.id);
      case 'closeRight':  return list.slice(idx + 1).map((x) => x.id);
      case 'closeOthers': return list.filter((x) => x.id !== m.tabId).map((x) => x.id);
      case 'closeSaved':  return list.filter((x) => x.content === x.savedContent).map((x) => x.id);
      case 'closeAll':    return list.map((x) => x.id);
    }
    return [];
  })();
  await closeMany(ids);
}

// ---- Pointer-based drag: reorder within the bar + drag-to-split across panes
// ----
// #86 — we deliberately do NOT use the HTML5 Drag and Drop API. On Windows,
// Tauri's native drag-drop (`dragDropEnabled`, which the app relies on for
// dropping files from Explorer into the editor — see App.vue onDragDropEvent)
// makes WebView2 swallow every in-page `draggable` drag at the OS level: the
// cursor shows 🚫 and tabs won't move. Pointer events bypass that interception
// and behave identically on macOS, Windows, and Linux.
const SPLIT_EDGE = 50; // px from a pane edge that arms drag-to-split
const DRAG_THRESHOLD = 4; // px of movement before a press counts as a drag

let pointerStart: { x: number; y: number; tabId: string } | null = null;
let dragging = false;
// Set briefly after a real drag so the trailing synthetic `click` doesn't
// re-activate the tab the user just dropped.
let suppressClick = false;

function onTabPointerDown(e: PointerEvent, tabId: string) {
  // Left button only — middle closes the tab, right opens the context menu.
  if (e.button !== 0) return;
  pointerStart = { x: e.clientX, y: e.clientY, tabId };
  dragging = false;
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
}

// Hit-test the element under the pointer for a drag-to-split target: a pane
// edge that is NOT over the tab bar (positions over a tab bar are reorders).
function paneSplitAt(x: number, y: number): { paneId: string; direction: SplitDirection } | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el || el.closest('.pane-tabbar')) return null;
  const pane = el.closest('[data-pane-id]') as HTMLElement | null;
  const paneId = pane?.getAttribute('data-pane-id');
  if (!pane || !paneId) return null;
  const r = pane.getBoundingClientRect();
  const lx = x - r.left;
  const ly = y - r.top;
  if (lx < SPLIT_EDGE || lx > r.width - SPLIT_EDGE) return { paneId, direction: 'horizontal' };
  if (ly < SPLIT_EDGE || ly > r.height - SPLIT_EDGE) return { paneId, direction: 'vertical' };
  return null;
}

function tabIdAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  return (el?.closest('[data-tab-id]') as HTMLElement | null)?.getAttribute('data-tab-id') ?? null;
}

function onPointerMove(e: PointerEvent) {
  if (!pointerStart) return;
  if (!dragging) {
    const moved = Math.abs(e.clientX - pointerStart.x) + Math.abs(e.clientY - pointerStart.y);
    if (moved < DRAG_THRESHOLD) return;
    dragging = true;
    tiles.beginTabDrag(pointerStart.tabId);
  }
  tiles.setDragSplit(paneSplitAt(e.clientX, e.clientY));
}

function teardownPointer() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
}

function onPointerCancel() {
  teardownPointer();
  pointerStart = null;
  dragging = false;
  tiles.endTabDrag();
}

function onPointerUp(e: PointerEvent) {
  teardownPointer();
  const start = pointerStart;
  pointerStart = null;
  if (!dragging || !start) {
    dragging = false;
    return;
  }
  dragging = false;
  suppressClick = true;

  const split = paneSplitAt(e.clientX, e.clientY);
  if (split) {
    tiles.splitPane(split.paneId, split.direction, start.tabId);
  } else {
    // Reorder: insert relative to the tab under the pointer. Right half of the
    // target inserts AFTER it, left half BEFORE — same rule as before.
    const overId = tabIdAt(e.clientX, e.clientY);
    if (overId && overId !== start.tabId) {
      const targetIdx = tabs.tabs.findIndex((t) => t.id === overId);
      if (targetIdx >= 0) {
        const overEl = tabsEl.value?.querySelector<HTMLElement>(`[data-tab-id="${overId}"]`);
        const rect = overEl?.getBoundingClientRect();
        const after = rect ? e.clientX > rect.left + rect.width / 2 : false;
        tabs.reorder(start.tabId, after ? targetIdx + 1 : targetIdx);
      }
    }
  }
  tiles.endTabDrag();
}

// ---- #218 — every open tab one click away ----
// With many files open the strip overflows. It scrolls (wheel, middle-drag;
// #106), but its scrollbar is hidden, so nothing says so — "根本没办法切换，
// 显示不全". While the strip overflows, a "⌄" button lists every open tab.
const tabsOverflow = ref(false);
function measureTabsOverflow() {
  const el = tabsEl.value;
  tabsOverflow.value = !!el && el.scrollWidth > el.clientWidth + 1;
}
let tabsRO: ResizeObserver | null = null;
// Startup: no synchronous scrollWidth read in onMounted — that forced a
// layout of the whole app mid-mount. ResizeObserver's initial notification
// arrives right after the first layout (before paint), and tab-list changes
// are measured in the next animation frame, again before it paints.
let tabsMeasureRaf = 0;
function scheduleMeasureTabsOverflow() {
  if (tabsMeasureRaf) return;
  tabsMeasureRaf = requestAnimationFrame(() => {
    tabsMeasureRaf = 0;
    measureTabsOverflow();
  });
}
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && tabsEl.value) {
    tabsRO = new ResizeObserver(measureTabsOverflow);
    tabsRO.observe(tabsEl.value);
  } else {
    scheduleMeasureTabsOverflow();
  }
});
onBeforeUnmount(() => {
  tabsRO?.disconnect();
  if (tabsMeasureRaf) cancelAnimationFrame(tabsMeasureRaf);
  tabsMeasureRaf = 0;
});
watch(
  () => tabs.tabs.map((x) => x.fileName).join('\u0000'),
  () => nextTick(scheduleMeasureTabsOverflow),
);

const tabListPos = ref<{ top: number; right: number } | null>(null);
function toggleTabList(e: MouseEvent) {
  if (tabListPos.value) {
    tabListPos.value = null;
    return;
  }
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  tabListPos.value = { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) };
}
function pickFromTabList(tabId: string) {
  tabListPos.value = null;
  tiles.setActiveTab(props.paneId, tabId);
}

function onTabClick(tabId: string) {
  // Swallow the click that immediately follows a drag-drop.
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  tiles.setActiveTab(props.paneId, tabId);
}

// ---- Horizontal scroll: mouse wheel over the tab strip (#106) ----
// The bar hides its scrollbar, so without this hidden/overflowing tabs are
// unreachable on a trackpad/mouse. Translate vertical wheel deltas into
// horizontal scroll; honor native horizontal deltas (deltaX) as-is.
function onTabsWheel(e: WheelEvent) {
  const el = tabsEl.value;
  if (!el) return;
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  el.scrollLeft += delta;
}

// ---- Middle-button: drag-to-pan, or close on a clean click (#106) ----
// #89 added middle-click-to-close. To also restore middle-drag panning we
// distinguish the two: motion past DRAG_THRESHOLD pans the strip and cancels
// the close; a middle press with no real movement closes the tab on release.
let middleStart: { x: number; scrollLeft: number; tabId: string } | null = null;
let middleDragging = false;

function onMiddlePointerDown(e: MouseEvent, tabId: string) {
  // Prevent the OS auto-scroll affordance some platforms attach to middle-press.
  e.preventDefault();
  middleStart = { x: e.clientX, scrollLeft: tabsEl.value?.scrollLeft ?? 0, tabId };
  middleDragging = false;
  window.addEventListener('mousemove', onMiddleMove);
  window.addEventListener('mouseup', onMiddleUp);
}

function onMiddleMove(e: MouseEvent) {
  if (!middleStart) return;
  const dx = e.clientX - middleStart.x;
  if (!middleDragging && Math.abs(dx) < DRAG_THRESHOLD) return;
  middleDragging = true;
  // Drag right reveals tabs to the right: pulling the strip with the cursor.
  if (tabsEl.value) tabsEl.value.scrollLeft = middleStart.scrollLeft - dx;
}

function onMiddleUp() {
  window.removeEventListener('mousemove', onMiddleMove);
  window.removeEventListener('mouseup', onMiddleUp);
  const start = middleStart;
  middleStart = null;
  // No real motion → treat as a click and close the tab (#89 behavior).
  if (!middleDragging && start) files.closeTabSafe(start.tabId);
  middleDragging = false;
}

// Close context menu (and the #218 tab list) on click outside
function onDocClick() {
  if (ctxMenu.value) closeCtxMenu();
  if (tabListPos.value) tabListPos.value = null;
}

onMounted(() => document.addEventListener('click', onDocClick));
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  // Drop any drag listeners still attached if the bar unmounts mid-drag.
  teardownPointer();
  window.removeEventListener('mousemove', onMiddleMove);
  window.removeEventListener('mouseup', onMiddleUp);
});
</script>

<template>
  <!-- 5.0 §3 — quiet pill tabs. `placement="pane"`: the strip at the top of
       a pane (40px, hairline under it). `placement="header"`: rendered by the
       shell inside the 52px window header, no chrome of its own; the empty
       part of the strip is a window drag region, the tabs are not. -->
  <div
    class="pane-tabbar"
    :class="`pane-tabbar--${placement}`"
    :data-tauri-drag-region="placement === 'header' ? '' : undefined"
  >
    <div class="tabs" ref="tabsEl" @wheel.prevent="onTabsWheel">
      <!-- The loop variable is `tab`, not `t`: `t` is the i18n function in
           this component, and `v-for="t in …"` silently shadowed it — any
           `t('key')` written inside the row would have called the tab. -->
      <div
        v-for="tab in tabs.tabs"
        :key="tab.id"
        :data-tab-id="tab.id"
        class="tab"
        :class="{
          'tab--active': tab.id === activeTabId,
          'tab--dirty': tabs.isDirty(tab.id),
          'tab--dragging': tiles.dragTabId === tab.id,
        }"
        role="tab"
        :aria-selected="tab.id === activeTabId"
        @click="onTabClick(tab.id)"
        @pointerdown="onTabPointerDown($event, tab.id)"
        @mousedown.middle="onMiddlePointerDown($event, tab.id)"
        @contextmenu="onContextMenu($event, tab.id)"
        :title="tab.filePath || tab.fileName"
      >
        <span class="tab__name">{{ tab.fileName }}</span>
        <!-- One 16px slot at the end: the unsaved dot sits in it until the
             pointer arrives, then the close button takes its place. -->
        <span class="tab__end">
          <span v-if="tabs.isDirty(tab.id)" class="tab__dot" aria-hidden="true"></span>
          <button
            class="tab__close"
            :title="t('tabMenu.close')"
            :aria-label="t('tabMenu.close')"
            @pointerdown.stop
            @click.stop="files.closeTabSafe(tab.id)"
          >
            <Icon name="close" :size="12" />
          </button>
        </span>
      </div>
    </div>
    <div class="tabbar__actions">
      <button
        v-if="tabsOverflow"
        class="tabbar__btn"
        :class="{ 'tabbar__btn--open': tabListPos }"
        :title="t('tabMenu.allTabs')"
        :aria-label="t('tabMenu.allTabs')"
        :aria-expanded="!!tabListPos"
        @click.stop="toggleTabList"
      >
        <Icon name="chevron-down" :size="16" />
      </button>
      <button
        class="tabbar__btn"
        :title="newTabChord ? `${t('tabMenu.newTab')} (${newTabChord})` : t('tabMenu.newTab')"
        :aria-label="t('tabMenu.newTab')"
        @click="files.newFile"
      >
        <Icon name="plus" :size="16" />
      </button>
    </div>
    <!-- Empty strip space after the "+" (browser-style). In the header this
         is what drags the window; the tabs themselves never do. -->
    <div
      class="tabs__filler"
      :data-tauri-drag-region="placement === 'header' ? '' : undefined"
    ></div>
    <button
      v-if="canClosePane"
      class="tabbar__btn tabbar__close-pane"
      :title="t('cmd.tile.closePane')"
      :aria-label="t('cmd.tile.closePane')"
      @click.stop="tiles.closePane(paneId)"
    >
      <!-- A pane with an × through it — a tab's own × is right next to it
           and closes the document, which is not what this does. `.stop`:
           the pane's own click handler would otherwise re-focus the pane that
           was just closed. -->
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
      </svg>
    </button>

    <!-- #218 — all open tabs -->
    <Teleport to="body">
      <div
        v-if="tabListPos"
        class="ctx-menu tablist"
        role="menu"
        :style="{ top: tabListPos.top + 'px', right: tabListPos.right + 'px' }"
        @click.stop
      >
        <button
          v-for="tl in tabs.tabs"
          :key="tl.id"
          class="ctx-item tablist__item"
          :class="{ 'tablist__item--active': tl.id === activeTabId }"
          role="menuitem"
          :title="tl.filePath || tl.fileName"
          @click="pickFromTabList(tl.id)"
        >
          <span class="tablist__name">{{ tl.fileName }}</span>
          <span v-if="tabs.isDirty(tl.id)" class="tablist__dot" aria-hidden="true"></span>
        </button>
      </div>
    </Teleport>

    <!-- Context menu -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        class="ctx-menu"
        role="menu"
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
        <template v-if="ctxFlags?.isMarkdown">
          <div class="ctx-sep" />
          <!-- The per-tab outline toggle used to be a ≡ glyph on the tab
               itself; 5.0 keeps tabs to name + close, so it lives here. -->
          <button class="ctx-item" data-tab-outline @click="onToggleOutline">
            {{ ctxFlags.showOutline ? t('tabMenu.hideOutline') : t('tabMenu.showOutline') }}
          </button>
        </template>
        <div class="ctx-sep" />
        <button class="ctx-item" :disabled="!ctxFlags?.hasFilePath" @click="onTabAction('revealInFolder')">{{ t('tabMenu.revealInFolder') }}</button>
        <button class="ctx-item" :disabled="!ctxFlags?.hasFilePath" @click="onTabAction('revealInFileTree')">{{ t('tabMenu.revealInFileTree') }}</button>
        <div class="ctx-sep" />
        <button class="ctx-item" @click="splitPane('horizontal')">{{ t('cmd.tile.splitRight') }}</button>
        <button class="ctx-item" @click="splitPane('vertical')">{{ t('cmd.tile.splitDown') }}</button>
        <div class="ctx-sep" v-if="tiles.allLeaves.length > 1" />
        <button class="ctx-item" v-if="tiles.allLeaves.length > 1" @click="closePane">{{ t('cmd.tile.closePane') }}</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.pane-tabbar {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 0 var(--sp-2);
  user-select: none;
  -webkit-user-select: none;
  overflow: hidden;
  flex-shrink: 0;
  min-width: 0;
}
.pane-tabbar--pane {
  height: 40px;
  background: var(--bg);
  border-bottom: var(--bd-hair);
}
/* Inside the shell's window header: no surface of its own, header height,
   vertically centred. The shell supplies the background and the border. */
.pane-tabbar--header {
  height: var(--header-h);
  padding: 0;
  background: transparent;
  flex: 1 1 auto;
}
.tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 1 auto;
  min-width: 0;
  height: 100%;
  overflow-x: auto;
  scrollbar-width: none;
  /* Momentum + horizontal touch panning for the overflowing strip on iOS. */
  -webkit-overflow-scrolling: touch;
  touch-action: pan-x;
}
.tabs::-webkit-scrollbar { display: none; }
.tabs__filler {
  flex: 1 1 0;
  min-width: 0;
  align-self: stretch;
}
.pane-tabbar--header .tabs__filler {
  min-width: 24px;
}

.tab {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  max-width: 220px;
  height: 30px;
  padding: 0 6px 0 12px;
  border-radius: var(--r-md);
  cursor: default;
  font-size: 13px;
  font-weight: 450;
  color: var(--text-3);
  white-space: nowrap;
  position: relative;
  transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  /* Pointer-based drag (#86): block vertical pan / pinch-zoom during a drag,
     but ALLOW horizontal panning. Tabs fill the whole strip, so a touch always
     lands on a `.tab`; `touch-action: none` here meant a finger swipe could
     never scroll an overflowing tab bar on iOS/iPad — the bar was stuck (the
     user's #139 follow-up). `pan-x` lets the finger scroll the strip while a
     mouse drag (unaffected by touch-action) still reorders on desktop. */
  touch-action: pan-x;
}
.tab:hover {
  background: var(--fill-1);
  color: var(--text-2);
}
.tab--active {
  background: var(--fill-1);
  color: var(--text);
  font-weight: 540;
}
.tab--active:hover {
  background: var(--fill-2);
  color: var(--text);
}
.tab--dragging {
  opacity: 0.5;
}
.tab__name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab__end {
  position: relative;
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tab__dot {
  width: 6px;
  height: 6px;
  border-radius: var(--r-full);
  background: var(--text-3);
}
.tab__close {
  position: absolute;
  inset: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--text-3);
  cursor: default;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-fast) var(--ease-out);
}
/* Clean tab: × shows on hover and on the active tab. Dirty tab: the dot holds
   the slot until hover, then gives way to the ×. */
.tab:hover .tab__close,
.tab--active:not(.tab--dirty) .tab__close,
.tab__close:focus-visible {
  opacity: 1;
  pointer-events: auto;
}
.tab:hover .tab__dot {
  display: none;
}
.tab__close:hover {
  background: var(--fill-2);
  color: var(--text);
}
.tabbar__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}
.tabbar__btn {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-2);
  cursor: default;
  transition: background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.tabbar__btn:hover,
.tabbar__btn--open {
  background: var(--fill-1);
  color: var(--text);
}
.tabbar__btn:active {
  background: var(--fill-2);
}

/* §6 menu style (teleported to <body>; scoped attributes still apply). */
.ctx-menu {
  position: fixed;
  z-index: var(--z-pop);
  background: var(--bg-pop);
  border: var(--bd-hair);
  border-radius: var(--r-lg);
  padding: 4px;
  min-width: 180px;
  box-shadow: var(--sh-pop);
  font-family: var(--font-ui);
  animation: tabbar-pop-in var(--dur-fast) var(--ease-out);
  transform-origin: top left;
}
@keyframes tabbar-pop-in {
  from { opacity: 0; transform: scale(0.98); }
  to { opacity: 1; transform: scale(1); }
}
.ctx-item {
  display: flex;
  align-items: center;
  width: 100%;
  height: 28px;
  padding: 0 10px;
  text-align: left;
  font-size: 13px;
  color: var(--text);
  background: none;
  border: none;
  border-radius: var(--r-sm);
  cursor: default;
}
.ctx-item:hover:not(:disabled) {
  background: var(--fill-1);
}
.ctx-item:disabled {
  color: var(--text-3);
  opacity: 0.6;
}
.ctx-sep {
  height: var(--hair-w);
  margin: 4px 6px;
  background: var(--hairline);
}
.tablist {
  max-height: min(60vh, 480px);
  overflow-y: auto;
  min-width: 220px;
  max-width: 420px;
  transform-origin: top right;
}
.tablist__item {
  gap: 8px;
}
.tablist__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tablist__item--active {
  font-weight: 600;
}
.tablist__dot {
  width: 6px;
  height: 6px;
  border-radius: var(--r-full);
  background: var(--text-3);
  flex: 0 0 auto;
}
</style>
