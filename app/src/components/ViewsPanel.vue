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
 * Rows are design-system DsListRow + DsChip; the header uses DsButton. The
 * context menu is a tokenized popover (no raw hex). Re-evaluates badges on
 * `solomd://index-updated` so counts stay live as notes change on disk.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useI18n } from '../i18n';
import { useWorkspaceStore } from '../stores/workspace';
import { useSavedViewsStore } from '../stores/savedViews';
import { useSavedViews } from '../composables/useSavedViews';
import { uniqueSlug, type ViewFile } from '../lib/viewFile';
import { DsButton, DsChip, DsListRow } from '../ui';

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
  <aside class="vpanel">
    <div class="vpanel__header">
      <button class="vpanel__title-btn" type="button" @click="collapsed = !collapsed">
        <span class="vpanel__caret" aria-hidden="true">{{ collapsed ? '▸' : '▾' }}</span>
        <span>{{ t('views.heading') }}</span>
      </button>
      <DsButton
        variant="ghost"
        size="sm"
        :disabled="!workspace.currentFolder"
        :title="t('views.newViewTitle')"
        @click="newView"
      >＋</DsButton>
    </div>

    <div v-if="!collapsed" class="vpanel__body">
      <div v-if="!workspace.currentFolder" class="vpanel__empty">{{ t('views.openFolder') }}</div>
      <div v-else-if="views.length === 0" class="vpanel__empty">
        <div>{{ t('views.empty') }}</div>
        <div class="vpanel__empty-hint">{{ t('views.emptyHint') }}</div>
      </div>
      <ul v-else class="vpanel__list">
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
          <DsListRow
            :active="isActive(view)"
            :title="view.name"
            @click="onRowClick(view)"
          >
            <template #leading>
              <span
                class="vpanel__swatch"
                :style="view.color ? { color: view.color } : undefined"
              >{{ view.icon || '🔖' }}</span>
            </template>
            <span class="vpanel__name">{{ view.name }}</span>
            <template #trailing>
              <DsChip size="sm">{{ badge(view) }}</DsChip>
            </template>
          </DsListRow>
        </li>
      </ul>
    </div>

    <div
      v-if="ctx"
      class="vpanel__ctx"
      :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }"
      @click.stop
    >
      <button class="vpanel__ctx-item" type="button" @click="onEdit(ctx.slug)">
        ✎ {{ t('views.edit') }}
      </button>
      <button class="vpanel__ctx-item" type="button" @click="onDuplicate(ctx.slug)">
        ⧉ {{ t('views.duplicate') }}
      </button>
      <div class="vpanel__ctx-sep"></div>
      <button
        class="vpanel__ctx-item vpanel__ctx-item--danger"
        type="button"
        @click="onDelete(ctx.slug)"
      >🗑 {{ t('views.delete') }}</button>
    </div>
  </aside>
</template>

<style scoped>
.vpanel {
  border-top: var(--bd);
  background: var(--bg-elev);
  user-select: none;
  display: flex;
  flex-direction: column;
  max-height: 40%;
}
.vpanel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-2) var(--sp-4);
  color: var(--text-muted);
}
.vpanel__title-btn {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}
.vpanel__caret { font-size: 9px; color: var(--text-faint); }
.vpanel__body { overflow-y: auto; padding: 0 var(--sp-2) var(--sp-2); }
.vpanel__empty {
  padding: var(--sp-3) var(--sp-3);
  font-size: 12px;
  color: var(--text-faint);
}
.vpanel__empty-hint {
  margin-top: var(--sp-1);
  font-size: 11px;
  color: var(--text-faint);
}
.vpanel__list { list-style: none; margin: 0; padding: 0; }
.vpanel__li {
  border-radius: var(--r-sm);
}
.vpanel__li--over {
  outline: 1px dashed var(--accent);
  outline-offset: -1px;
}
.vpanel__swatch {
  width: 16px;
  text-align: center;
  flex-shrink: 0;
  font-size: 12px;
}
.vpanel__name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vpanel__ctx {
  position: fixed;
  z-index: var(--z-pop);
  background: var(--bg-elev);
  border: var(--bd);
  border-radius: var(--r-md);
  box-shadow: var(--sh-pop);
  padding: var(--sp-1) 0;
  min-width: 160px;
  font-size: 13px;
}
.vpanel__ctx-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: var(--sp-2) var(--sp-4);
  background: transparent;
  border: none;
  color: var(--text);
  cursor: pointer;
  font: inherit;
}
.vpanel__ctx-item:hover {
  background: var(--bg-hover);
}
.vpanel__ctx-item--danger { color: var(--danger); }
.vpanel__ctx-item--danger:hover {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
}
.vpanel__ctx-sep { height: 1px; background: var(--border); margin: var(--sp-1) 0; }
</style>
