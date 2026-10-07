<script setup lang="ts">
/**
 * Saved Views sidebar panel (F5).
 *
 * A collapsible "Views" section that lives in the left sidebar (below the file
 * tree). Lists persistent filtered views from `.solomd/views/*.yml` with an
 * icon swatch, name, and live match-count badge. The header '+' opens the
 * editor; rows open the filtered list, and a per-row context menu offers
 * edit / duplicate / delete. Rows drag-reorder, persisting `order` to disk.
 *
 * 5.0: rows / header use the shared panel anatomy (styles/panels.css); the
 * context menu follows the spec §6 menu style (tokens only). Re-evaluates badges on
 * `solomd://index-updated` so counts stay live as notes change on disk.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useI18n } from '../i18n';
import { useWorkspaceStore } from '../stores/workspace';
import { useSavedViewsStore } from '../stores/savedViews';
import { useSavedViews } from '../composables/useSavedViews';
import { uniqueSlug, type ViewFile } from '../lib/viewFile';
import Icons from './Icons.vue';
import '../styles/panels.css';

const { t } = useI18n();
const workspace = useWorkspaceStore();
const store = useSavedViewsStore();
const { openView, newView, editView } = useSavedViews();

const collapsed = ref(false);

// Bump on index updates so the match-count badges recompute.
const rev = ref(0);
const views = computed<ViewFile[]>(() => store.ordered);

function badge(view: ViewFile): number {
  void rev.value;
  try {
    return store.matchCount(view);
  } catch {
    return 0;
  }
}

function isActive(view: ViewFile): boolean {
  return store.activeSlug === view.slug;
}

function onRowClick(view: ViewFile) {
  openView(view.slug);
}

// ---- context menu ----------------------------------------------------------

interface Ctx { x: number; y: number; slug: string }
const ctx = ref<Ctx | null>(null);

function openCtx(e: MouseEvent, view: ViewFile) {
  e.preventDefault();
  e.stopPropagation();
  ctx.value = { x: e.clientX, y: e.clientY, slug: view.slug };
}
function closeCtx() { ctx.value = null; }

function onEdit(slug: string) {
  closeCtx();
  editView(slug);
}

async function onDuplicate(slug: string) {
  closeCtx();
  const src = store.views.find((v) => v.slug === slug);
  if (!src) return;
  const taken = new Set(store.views.map((v) => v.slug));
  const copy: ViewFile = {
    ...JSON.parse(JSON.stringify(src)),
    slug: uniqueSlug(src.slug, taken),
    name: `${src.name} copy`,
    order: store.views.length,
  };
  await store.save(copy);
}

async function onDelete(slug: string) {
  closeCtx();
  const view = store.views.find((v) => v.slug === slug);
  if (!view) return;
  const ok = window.confirm(t('views.deleteConfirm', { name: view.name }));
  if (!ok) return;
  await store.remove(view.slug);
}

// ---- drag reorder ----------------------------------------------------------

const dragSlug = ref<string | null>(null);
const overSlug = ref<string | null>(null);

function onDragStart(slug: string, e: DragEvent) {
  dragSlug.value = slug;
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(slug: string, e: DragEvent) {
  e.preventDefault();
  overSlug.value = slug;
}
async function onDrop(targetSlug: string) {
  const from = dragSlug.value;
  dragSlug.value = null;
  overSlug.value = null;
  if (!from || from === targetSlug) return;
  const order = views.value.map((v) => v.slug);
  const fromIdx = order.indexOf(from);
  const toIdx = order.indexOf(targetSlug);
  if (fromIdx < 0 || toIdx < 0) return;
  order.splice(fromIdx, 1);
  order.splice(toIdx, 0, from);
  await store.reorder(order);
}
function onDragEnd() {
  dragSlug.value = null;
  overSlug.value = null;
}

// ---- lifecycle -------------------------------------------------------------

// Keep the store pointed at the active workspace folder (mirrors workspaceIndex).
watch(
  () => workspace.currentFolder,
  (folder) => { void store.setFolder(folder); },
  { immediate: true },
);

let unlistenIndex: UnlistenFn | null = null;
function onWindowClick() { if (ctx.value) closeCtx(); }
onMounted(async () => {
  window.addEventListener('click', onWindowClick);
  try {
    unlistenIndex = await listen('solomd://index-updated', () => { rev.value += 1; });
  } catch {}
});
onBeforeUnmount(() => {
  window.removeEventListener('click', onWindowClick);
  if (unlistenIndex) unlistenIndex();
});
</script>

<template>
  <aside class="vpanel rp">
    <div class="rp-head vpanel__header">
      <button
        class="vpanel__title-btn rp-title"
        type="button"
        :aria-expanded="!collapsed"
        @click="collapsed = !collapsed"
      >
        <span>{{ t('views.heading') }}</span>
        <Icons
          class="vpanel__caret"
          :class="{ 'vpanel__caret--collapsed': collapsed }"
          name="chevron-down"
          :size="11"
        />
      </button>
      <button
        type="button"
        class="rp-icon-btn"
        :disabled="!workspace.currentFolder"
        :title="t('views.newViewTitle')"
        :aria-label="t('views.newViewTitle')"
        @click="newView"
      ><Icons name="plus" :size="14" /></button>
    </div>

    <div v-if="!collapsed" class="vpanel__body rp-body">
      <div v-if="!workspace.currentFolder" class="vpanel__empty rp-sub">{{ t('views.openFolder') }}</div>
      <div v-else-if="views.length === 0" class="vpanel__empty rp-sub">
        <div>{{ t('views.empty') }}</div>
        <div class="vpanel__empty-hint">{{ t('views.emptyHint') }}</div>
      </div>
      <ul v-else class="rp-list vpanel__list">
        <li
          v-for="view in views"
          :key="view.slug"
          class="vpanel__li"
          :class="{ 'vpanel__li--over': overSlug === view.slug }"
          draggable="true"
          @dragstart="onDragStart(view.slug, $event)"
          @dragover="onDragOver(view.slug, $event)"
          @drop="onDrop(view.slug)"
          @dragend="onDragEnd"
          @contextmenu="openCtx($event, view)"
        >
          <button
            type="button"
            class="rp-row"
            :class="{ 'is-active': isActive(view) }"
            :title="view.name"
            @click="onRowClick(view)"
          >
            <span
              class="rp-row__icon vpanel__swatch"
              :style="view.color ? { color: view.color } : undefined"
            >
              <template v-if="view.icon">{{ view.icon }}</template>
              <Icons v-else name="filter" :size="14" />
            </span>
            <span class="rp-row__label vpanel__name">{{ view.name }}</span>
            <span class="rp-count">{{ badge(view) }}</span>
          </button>
        </li>
      </ul>
    </div>

    <div
      v-if="ctx"
      class="vpanel__ctx"
      role="menu"
      :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }"
      @click.stop
    >
      <button class="vpanel__ctx-item" type="button" role="menuitem" @click="onEdit(ctx.slug)">
        <Icons name="pencil" :size="14" />{{ t('views.edit') }}
      </button>
      <button class="vpanel__ctx-item" type="button" role="menuitem" @click="onDuplicate(ctx.slug)">
        <Icons name="new" :size="14" />{{ t('views.duplicate') }}
      </button>
      <div class="vpanel__ctx-sep"></div>
      <button
        class="vpanel__ctx-item vpanel__ctx-item--danger"
        type="button"
        role="menuitem"
        @click="onDelete(ctx.slug)"
      ><Icons name="trash" :size="14" />{{ t('views.delete') }}</button>
    </div>
  </aside>
</template>

<style scoped>
.vpanel.rp {
  height: auto;
  max-height: 40%;
  flex: 0 1 auto;
  border-top: var(--bd-hair);
  user-select: none;
  -webkit-user-select: none;
}
.vpanel__header {
  padding-left: 12px;
}
.vpanel__title-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 1 1 auto;
  height: 24px;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.vpanel__title-btn:hover {
  color: var(--text-2);
}
.vpanel__title-btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
  border-radius: var(--r-xs);
}
.vpanel__caret {
  flex: 0 0 auto;
  opacity: 0;
  transition: transform var(--dur-fast) var(--ease), opacity var(--dur-fast) var(--ease);
}
.vpanel__header:hover .vpanel__caret,
.vpanel__caret--collapsed {
  opacity: 1;
}
.vpanel__caret--collapsed {
  transform: rotate(-90deg);
}
.vpanel__empty {
  padding: 4px 8px 8px;
}
.vpanel__empty-hint {
  margin-top: 2px;
}
.vpanel__li {
  border-radius: 7px;
}
.vpanel__li--over {
  box-shadow: inset 0 2px 0 var(--accent);
}
.vpanel__swatch {
  width: 16px;
  justify-content: center;
  font-size: 13px;
  line-height: 1;
}
.vpanel__ctx {
  position: fixed;
  z-index: var(--z-pop);
  min-width: 168px;
  padding: 4px;
  background: var(--bg-pop);
  border: var(--bd-hair);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-pop);
  font-size: 13px;
  transform-origin: top left;
  animation: vpanel-pop var(--dur-fast) var(--ease-out);
}
@keyframes vpanel-pop {
  from {
    opacity: 0;
    transform: scale(0.98);
  }
}
.vpanel__ctx-item {
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
  text-align: left;
  cursor: pointer;
}
.vpanel__ctx-item :deep(svg) {
  color: var(--text-3);
}
.vpanel__ctx-item:hover {
  background: var(--fill-1);
}
.vpanel__ctx-item--danger,
.vpanel__ctx-item--danger :deep(svg) {
  color: var(--danger);
}
.vpanel__ctx-sep {
  height: 0;
  margin: 4px 0;
  border-top: var(--bd-hair);
}
@media (prefers-reduced-motion: reduce) {
  .vpanel__ctx {
    animation: none;
  }
}
</style>
