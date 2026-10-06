<script setup lang="ts">
/**
 * 5.0 left sidebar (docs/v5-ui-spec.md §4).
 *
 *   [traffic-light inset · collapse]   (macOS only, 52 px, drag region)
 *   [⌕ 搜索                    ⌘P]     → quick switcher
 *   今天 / 收件箱 n / 最近              nav rows
 *   文件夹 · <workspace> ▾  [+][⇅][▽][↻]   ┐ FileTree (embedded) owns the
 *     tree…                               ┘ section row and all tree logic
 *   标签  #a #b … 全部
 *   ─ Saved Views (when on) ─
 *   [✓ 已同步]                    [⚙]
 *
 * The sidebar owns the width (settings.fileTreeWidth) and the resize handle;
 * only the middle part scrolls.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icons.vue';
import FileTree from './FileTree.vue';
import ViewsPanel from './ViewsPanel.vue';
import SyncStatusPill from './SyncStatusPill.vue';
import { useSettingsStore } from '../stores/settings';
import { useWorkspaceStore } from '../stores/workspace';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';
import { useTabsStore } from '../stores/tabs';
import { useFiles } from '../composables/useFiles';
import { useInbox } from '../composables/useInbox';
import { useInboxView } from '../composables/useInboxView';
import { useDailyNotes } from '../composables/useDailyNotes';
import { shortcutLabel } from '../lib/keybindings';
import { isMacOS } from '../lib/platform';
import { useI18n } from '../i18n';

const props = withDefaults(defineProps<{ macInset?: boolean }>(), { macInset: false });
const emit = defineEmits<{
  (e: 'toggle'): void;
  (e: 'open-settings'): void;
  (e: 'open-quick-switcher'): void;
  (e: 'filter-tag', tag: string): void;
}>();

const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const idx = useWorkspaceIndexStore();
const tabs = useTabsStore();
const files = useFiles();
const inbox = useInbox();
const inboxView = useInboxView();
const daily = useDailyNotes();
const { t } = useI18n();

const hasFolder = computed(() => !!workspace.currentFolder);

// ── search field ────────────────────────────────────────────────────────────
// The chord that works right now (#180): read from the user's bindings.
const switcherChord = computed(
  () => shortcutLabel('quickSwitcher.open', settings.keybindings, isMacOS()) || '',
);

// ── nav rows ────────────────────────────────────────────────────────────────
/** 今天 reads as selected while today's note is the open document. */
const todayActive = computed(() => {
  const p = tabs.activeTab?.filePath;
  if (!p || !hasFolder.value) return false;
  return daily.resolveDailyPath(new Date())?.fullPath === p;
});
function openToday() {
  void daily.openTodayNote();
}
function openInbox() {
  inboxView.openInbox();
}
const inboxFiltering = computed(() => inbox.filterMode.value);

// 最近 — a small popover listing workspace.recentFiles (spec §6 menu style).
const recentOpen = ref(false);
const recentPos = ref({ x: 0, y: 0 });
const recentList = computed(() =>
  workspace.recentFiles.slice(0, 12).map((path) => {
    const parts = path.split(/[\\/]/).filter(Boolean);
    const name = parts[parts.length - 1] ?? path;
    const folder = parts.length > 1 ? parts[parts.length - 2] : '';
    return { path, name, folder };
  }),
);
function toggleRecent(ev: MouseEvent) {
  recentOpen.value = !recentOpen.value;
  if (!recentOpen.value) return;
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  recentPos.value = { x: Math.round(r.left), y: Math.round(r.bottom + 4) };
  void nextTick(() => {
    // Keep it on screen in a short window.
    const el = recentEl.value;
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    if (recentPos.value.y + h > window.innerHeight - 8) {
      recentPos.value = { ...recentPos.value, y: Math.max(8, Math.round(r.top - h - 4)) };
    }
  });
}
const recentEl = ref<HTMLElement | null>(null);
function openRecent(path: string) {
  recentOpen.value = false;
  void files.openPath(path, { bypassNewWindow: true });
}

// ── tags ────────────────────────────────────────────────────────────────────
const TAG_LIMIT = 8;
const topTags = computed(() =>
  [...idx.tags]
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, TAG_LIMIT),
);
function openTagsPanel() {
  if (!settings.showTagsPanel) settings.toggleTagsPanel();
  else settings.ensureRightSidebarVisible();
}

// ── empty state ─────────────────────────────────────────────────────────────
const recentFolders = computed(() =>
  workspace.recentFolders.slice(0, 5).map((path) => {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return {
      path,
      name: parts[parts.length - 1] ?? path,
      parent: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
    };
  }),
);
function openFolder() {
  void files.openFolder();
}
function pickFolder(path: string) {
  workspace.setFolder(path);
}

// ── width + resize (moved here from FileTree) ───────────────────────────────
const resizing = ref(false);
function onResizeStart(e: MouseEvent) {
  e.preventDefault();
  resizing.value = true;
  const startX = e.clientX;
  const startWidth = settings.fileTreeWidth;
  document.body.style.cursor = 'ew-resize';
  document.body.style.userSelect = 'none';
  const onMove = (m: MouseEvent) => settings.setFileTreeWidth(startWidth + m.clientX - startX);
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    resizing.value = false;
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ── outside click / Escape closes the recent popover ────────────────────────
function onWindowClick() {
  recentOpen.value = false;
}
function onWindowKey(e: KeyboardEvent) {
  if (e.key === 'Escape') recentOpen.value = false;
}
onMounted(() => {
  window.addEventListener('click', onWindowClick);
  window.addEventListener('keydown', onWindowKey);
});
onBeforeUnmount(() => {
  window.removeEventListener('click', onWindowClick);
  window.removeEventListener('keydown', onWindowKey);
});
</script>

<template>
  <aside
    class="sb"
    :class="{ 'sb--inset': props.macInset, 'sb--resizing': resizing }"
    :style="{ '--sb-w': settings.fileTreeWidth + 'px' }"
    data-testid="sidebar"
  >
    <!-- macOS: the traffic lights sit in this strip; it is a drag region and
         keeps its left 80 px free of controls. -->
    <div v-if="props.macInset" class="sb__inset" data-tauri-drag-region>
      <button
        class="sb__icon-btn"
        type="button"
        :title="t('sidebar.collapse')"
        :aria-label="t('sidebar.collapse')"
        @click="emit('toggle')"
      >
        <Icon name="sidebar" :size="16" />
      </button>
    </div>
    <div v-else class="sb__pad" />

    <div class="sb__search-wrap">
      <button class="sb__search" type="button" @click="emit('open-quick-switcher')">
        <Icon name="search" :size="14" class="sb__search-icon" />
        <span class="sb__search-ph">{{ t('sidebar.search') }}</span>
        <kbd v-if="switcherChord" class="sb__chord">{{ switcherChord }}</kbd>
      </button>
    </div>

    <div class="sb__scroll">
      <nav class="sb__nav">
        <button
          v-if="hasFolder"
          class="sb__row"
          :class="{ 'sb__row--active': todayActive }"
          type="button"
          @click="openToday"
        >
          <Icon name="today" :size="16" class="sb__row-icon" />
          <span class="sb__row-label">{{ t('sidebar.today') }}</span>
        </button>
        <div v-if="hasFolder && settings.inboxWorkflowEnabled" class="sb__row sb__row--split">
          <button class="sb__row-main" type="button" @click="openInbox">
            <Icon name="inbox" :size="16" class="sb__row-icon" />
            <span class="sb__row-label">{{ t('sidebar.inbox') }}</span>
          </button>
          <!-- The inbox-only tree filter (was the chevron on the old tree's
               Inbox row). -->
          <button
            class="sb__row-tool"
            :class="{ 'sb__row-tool--on': inboxFiltering }"
            type="button"
            :title="inboxFiltering ? t('sidebar.inboxFilterOff') : t('sidebar.inboxFilterOn')"
            :aria-label="inboxFiltering ? t('sidebar.inboxFilterOff') : t('sidebar.inboxFilterOn')"
            :aria-pressed="inboxFiltering"
            @click="inbox.toggleFilter()"
          >
            <Icon name="filter" :size="14" />
          </button>
          <span v-if="inbox.inboxCount.value > 0" class="sb__count">{{ inbox.inboxCount.value }}</span>
        </div>
        <button
          class="sb__row"
          :class="{ 'sb__row--open': recentOpen }"
          type="button"
          aria-haspopup="menu"
          :aria-expanded="recentOpen"
          @click.stop="toggleRecent"
        >
          <Icon name="recent" :size="16" class="sb__row-icon" />
          <span class="sb__row-label">{{ t('sidebar.recent') }}</span>
        </button>
      </nav>

      <template v-if="hasFolder">
        <FileTree embedded />

        <section v-if="topTags.length" class="sb__tags">
          <div class="sb__label">{{ t('sidebar.tags') }}</div>
          <div class="sb__chips">
            <button
              v-for="tg in topTags"
              :key="tg.tag"
              class="sb__chip"
              type="button"
              :title="`#${tg.tag} · ${tg.count}`"
              @click="emit('filter-tag', tg.tag)"
            >#{{ tg.tag }}</button>
            <button class="sb__chip sb__chip--all" type="button" @click="openTagsPanel">
              {{ t('sidebar.allTags') }}
            </button>
          </div>
        </section>
      </template>

      <div v-else class="sb__empty">
        <div class="sb__empty-title">{{ t('sidebar.emptyTitle') }}</div>
        <p class="sb__empty-body">{{ t('sidebar.emptyBody') }}</p>
        <button class="sb__primary" type="button" @click="openFolder">
          {{ t('sidebar.emptyButton') }}
        </button>
        <div v-if="recentFolders.length" class="sb__empty-recent">
          <div class="sb__label sb__label--center">{{ t('sidebar.recentFolders') }}</div>
          <button
            v-for="f in recentFolders"
            :key="f.path"
            class="sb__row sb__row--folder"
            type="button"
            :title="f.path"
            @click="pickFolder(f.path)"
          >
            <Icon name="folder-sm" :size="16" class="sb__row-icon" />
            <span class="sb__row-label">{{ f.name }}</span>
            <span class="sb__row-sub">{{ f.parent }}</span>
          </button>
        </div>
      </div>
    </div>

    <div v-if="settings.showViewsPanel" class="sb__views">
      <ViewsPanel />
    </div>

    <footer class="sb__foot">
      <div class="sb__foot-sync">
        <!-- Sync belongs to the open folder: nothing to report without one. -->
        <SyncStatusPill v-if="hasFolder" variant="footer" />
      </div>
      <button
        class="sb__icon-btn"
        type="button"
        :title="t('sidebar.settings')"
        :aria-label="t('sidebar.settings')"
        @click="emit('open-settings')"
      >
        <Icon name="settings" :size="16" />
      </button>
    </footer>

    <div
      class="sb__resize"
      :class="{ 'sb__resize--active': resizing }"
      @mousedown="onResizeStart"
    />

    <div
      v-if="recentOpen"
      ref="recentEl"
      class="sb__menu"
      role="menu"
      :style="{ left: recentPos.x + 'px', top: recentPos.y + 'px' }"
      @click.stop
    >
      <div class="sb__menu-label">{{ t('sidebar.recent') }}</div>
      <button
        v-for="r in recentList"
        :key="r.path"
        class="sb__menu-item"
        role="menuitem"
        :title="r.path"
        @click="openRecent(r.path)"
      >
        <Icon name="file" :size="16" class="sb__menu-icon" />
        <span class="sb__menu-name">{{ r.name }}</span>
        <span class="sb__menu-sub">{{ r.folder }}</span>
      </button>
      <div v-if="recentList.length === 0" class="sb__menu-empty">{{ t('sidebar.recentEmpty') }}</div>
    </div>
  </aside>
</template>

<style scoped>
.sb {
  position: relative;
  display: flex;
  flex-direction: column;
  width: var(--sb-w, var(--sidebar-w));
  flex: 0 0 var(--sb-w, var(--sidebar-w));
  min-width: 0;
  height: 100%;
  min-height: 0;
  background: var(--bg-sidebar);
  border-right: var(--bd-hair);
  color: var(--text);
  font-family: var(--font-ui, inherit);
  font-size: 13px;
  user-select: none;
}

/* ── top: inset / padding + search (fixed) ── */
.sb__inset {
  flex: none;
  height: var(--header-h);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 var(--sp-2) 0 80px;
}
.sb__pad {
  flex: none;
  height: var(--sp-3);
}
.sb__search-wrap {
  flex: none;
  padding: 0 var(--sp-2) var(--sp-2);
}
.sb__search {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--r-md);
  background: var(--fill-1);
  color: var(--text-3);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: text;
}
.sb__search:hover {
  background: var(--fill-2);
}
.sb__search:focus-visible,
.sb__row:focus-visible,
.sb__row-main:focus-visible,
.sb__row-tool:focus-visible,
.sb__chip:focus-visible,
.sb__icon-btn:focus-visible,
.sb__primary:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.sb__search-icon {
  flex: none;
}
.sb__search-ph {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb__chord {
  flex: none;
  font: inherit;
  font-size: 12px;
  color: var(--text-3);
  letter-spacing: 0.02em;
}

/* ── middle (scrolls) ── */
.sb__scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  scrollbar-width: thin;
  scrollbar-color: var(--fill-2) transparent;
}
.sb__nav {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 var(--sp-2);
}
.sb__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: default;
}
.sb__row:hover,
.sb__row--open {
  background: var(--fill-1);
}
.sb__row--active,
.sb__row--active:hover {
  background: var(--accent-soft);
  color: var(--accent-text);
}
.sb__row--active .sb__row-icon {
  color: var(--accent-text);
}
.sb__row-icon {
  flex: none;
  color: var(--text-2);
}
.sb__row-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb__row-sub {
  flex: 0 1 auto;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  font-size: 12px;
  color: var(--text-3);
}
/* Inbox: the row is a container holding the main button, the filter toggle
   and the count. */
.sb__row--split {
  padding: 0 6px 0 0;
  gap: 2px;
}
.sb__row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 100%;
  padding: 0 0 0 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: default;
}
.sb__row-tool {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-3);
  opacity: 0;
  cursor: default;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.sb__row--split:hover .sb__row-tool,
.sb__row-tool:focus-visible,
.sb__row-tool--on {
  opacity: 1;
}
.sb__row-tool:hover {
  background: var(--fill-2);
  color: var(--text-2);
}
.sb__row-tool--on {
  color: var(--accent-text);
}
@media (hover: none) {
  .sb__row-tool {
    opacity: 1;
  }
}
.sb__count {
  flex: none;
  min-width: 16px;
  text-align: right;
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

/* ── tags ── */
.sb__tags {
  flex: none;
  padding: var(--sp-3) 14px;
}
.sb__label {
  margin-bottom: var(--sp-2);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}
.sb__label--center {
  text-align: center;
}
.sb__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.sb__chip {
  max-width: 100%;
  padding: 3px 9px;
  border: 0;
  border-radius: var(--r-full);
  background: var(--fill-1);
  color: var(--text-2);
  font: inherit;
  font-size: 12px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
}
.sb__chip:hover {
  background: var(--fill-2);
  color: var(--text);
}
.sb__chip--all {
  background: transparent;
  color: var(--text-3);
  box-shadow: inset 0 0 0 var(--hair-w) var(--hairline);
}

/* ── empty state ── */
.sb__empty {
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--sp-6) var(--sp-5);
  text-align: center;
}
.sb__empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.sb__empty-body {
  margin: 6px 0 var(--sp-4);
  max-width: 220px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-3);
}
.sb__primary {
  height: 32px;
  padding: 0 var(--sp-4);
  border: 0;
  border-radius: var(--r-md);
  background: var(--accent-strong);
  color: var(--accent-strong-fg);
  font: inherit;
  font-size: 13px;
  font-weight: 550;
  cursor: default;
}
.sb__primary:hover {
  filter: brightness(1.05);
}
.sb__primary:active {
  filter: brightness(0.95);
}
.sb__empty-recent {
  align-self: stretch;
  margin-top: var(--sp-6);
  text-align: left;
}
.sb__row--folder .sb__row-icon {
  color: var(--text-3);
}

/* ── Saved Views (optional) ── */
.sb__views {
  flex: none;
  display: flex;
  flex-direction: column;
  max-height: 40%;
  min-height: 0;
  border-top: var(--bd-hair);
}
.sb__views :deep(.vpanel) {
  max-height: none;
  min-height: 0;
  flex: 1 1 auto;
  background: transparent;
  border-top: 0;
}

/* ── footer (fixed) ── */
.sb__foot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  height: 44px;
  padding: 0 var(--sp-2) 0 var(--sp-2);
}
.sb__foot-sync {
  min-width: 0;
  display: flex;
}
.sb__icon-btn {
  flex: none;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-2);
  cursor: default;
}
.sb__icon-btn:hover {
  background: var(--fill-1);
  color: var(--text);
}

/* ── resize handle ── */
.sb__resize {
  position: absolute;
  top: 0;
  right: -3px;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
  z-index: var(--z-pane);
}
.sb__resize::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 2px;
  background: transparent;
  transition: background var(--dur-fast) var(--ease-out);
}
.sb__resize:hover::after,
.sb__resize--active::after {
  background: var(--accent-ring);
}

/* ── recent popover (spec §6) ── */
.sb__menu {
  position: fixed;
  z-index: var(--z-pop);
  width: 260px;
  max-width: calc(100vw - 16px);
  max-height: min(60vh, 420px);
  overflow-y: auto;
  padding: var(--sp-1);
  background: var(--bg-pop);
  border: var(--bd-hair);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-pop);
  transform-origin: top left;
  animation: sb-pop var(--dur-fast) var(--ease-out);
}
@keyframes sb-pop {
  from {
    opacity: 0;
    transform: scale(0.98);
  }
}
.sb__menu-label {
  padding: 6px 8px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}
.sb__menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: default;
}
.sb__menu-item:hover {
  background: var(--fill-1);
}
.sb__menu-icon {
  flex: none;
  color: var(--text-3);
}
.sb__menu-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb__menu-sub {
  flex: 0 1 auto;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-3);
}
.sb__menu-empty {
  padding: 6px 8px 8px;
  font-size: 12px;
  color: var(--text-3);
}
@media (prefers-reduced-motion: reduce) {
  .sb__menu {
    animation: none;
  }
}
</style>
