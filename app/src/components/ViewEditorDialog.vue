<script setup lang="ts">
/**
 * Create / edit a saved view (F5) — modal dialog.
 *
 * Opened by the `solomd:new-view` / `solomd:edit-view` window events (see
 * useSavedViews). Hosts {@link FilterBuilder} plus name / icon / color / sort
 * / column-visibility controls, and a LIVE match-count badge that re-evaluates
 * the draft tree against the index as you type. On save it persists through the
 * savedViews store (disk write) and, for a brand-new view, opens it in the
 * content area.
 *
 * Built from the design-system primitives in `@/ui` (DsModal / DsInput /
 * DsSelect / DsButton / DsChip) — no raw hex, consistent with the other panes.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useI18n } from '../i18n';
import { useSavedViewsStore } from '../stores/savedViews';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';
import { useSavedViews, VIEW_NEW_EVENT, VIEW_EDIT_EVENT } from '../composables/useSavedViews';
import {
  emptyView,
  slugify,
  uniqueSlug,
  type ViewFile,
} from '../lib/viewFile';
import { inferColumns, type SortSpec } from '../lib/bases';
import { DsButton, DsChip, DsInput, DsModal, DsSelect, type DsSelectOption } from '../ui';
import FilterBuilder from './FilterBuilder.vue';

const { t } = useI18n();
const store = useSavedViewsStore();
const index = useWorkspaceIndexStore();
const { openView } = useSavedViews();

const open = ref(false);
const editingSlug = ref<string | null>(null);

// Working copy — mutated freely, only committed on Save.
const draft = reactive<ViewFile>(emptyView('view', ''));

const columns = computed(() => inferColumns(index.entries));

/** Sort options = a "default (mtime desc)" sentinel + every column. */
const sortOptions = computed<DsSelectOption[]>(() => [
  { value: '', label: t('views.sortDefault') },
  ...columns.value.map((c) => ({ value: c.id, label: c.label })),
]);
const dirOptions = computed<DsSelectOption[]>(() => [
  { value: 'asc', label: t('views.asc') },
  { value: 'desc', label: t('views.desc') },
]);

const isEditing = computed(() => editingSlug.value !== null);

/** Live count of notes matching the draft tree (re-evaluates reactively). */
const liveCount = computed<number>(() => {
  void index.entries.length; // touch for reactivity
  try {
    return store.countMatches(draft.filters);
  } catch {
    return 0;
  }
});

function loadDraft(v: ViewFile) {
  draft.slug = v.slug;
  draft.name = v.name;
  draft.icon = v.icon;
  draft.color = v.color;
  draft.order = v.order;
  draft.columns = [...v.columns];
  draft.sort = v.sort ? { ...v.sort } : null;
  // Deep clone of the filter tree so edits don't mutate the store copy.
  draft.filters = JSON.parse(JSON.stringify(v.filters));
}

function onNew() {
  editingSlug.value = null;
  loadDraft(emptyView('view', ''));
  open.value = true;
}

function onEdit(e: Event) {
  const slug = (e as CustomEvent).detail?.slug as string | undefined;
  if (!slug) return;
  const v = store.views.find((x) => x.slug === slug);
  if (!v) return;
  editingSlug.value = slug;
  loadDraft(v);
  open.value = true;
}

function close() {
  open.value = false;
}

function onModalUpdate(v: boolean) {
  open.value = v;
}

// ---- sort controls ---------------------------------------------------------

const sortColumn = computed<string>({
  get: () => draft.sort?.column ?? '',
  set: (col: string) => {
    if (!col) draft.sort = null;
    else draft.sort = { column: col, dir: draft.sort?.dir ?? 'desc' };
  },
});
const sortDir = computed<string>({
  get: () => draft.sort?.dir ?? 'desc',
  set: (dir) => {
    if (draft.sort) draft.sort = { ...draft.sort, dir: dir as 'asc' | 'desc' } as SortSpec;
  },
});

function toggleColumn(id: string) {
  const i = draft.columns.indexOf(id);
  if (i >= 0) draft.columns.splice(i, 1);
  else draft.columns.push(id);
}

function setFilters(g: ViewFile['filters']) {
  draft.filters = g;
}

// ---- save ------------------------------------------------------------------

const saving = ref(false);

async function save() {
  if (saving.value) return;
  const name = draft.name.trim() || t('views.untitled');
  saving.value = true;
  try {
    let slug = editingSlug.value;
    if (!slug) {
      // New view → derive a unique slug from the name.
      const taken = new Set(store.views.map((v) => v.slug));
      slug = uniqueSlug(name || slugify(name), taken);
      // Place new views at the end of the sidebar.
      draft.order = store.views.length;
    }
    const toSave: ViewFile = {
      slug,
      name,
      icon: draft.icon || undefined,
      color: draft.color || undefined,
      order: draft.order,
      columns: [...draft.columns],
      sort: draft.sort ? { ...draft.sort } : null,
      filters: JSON.parse(JSON.stringify(draft.filters)),
    };
    const saved = await store.save(toSave);
    const wasEditing = editingSlug.value !== null;
    open.value = false;
    if (!wasEditing) openView(saved.slug);
  } catch (e) {
    console.error('[ViewEditorDialog] save failed', e);
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  window.addEventListener(VIEW_NEW_EVENT, onNew as EventListener);
  window.addEventListener(VIEW_EDIT_EVENT, onEdit as EventListener);
});
onBeforeUnmount(() => {
  window.removeEventListener(VIEW_NEW_EVENT, onNew as EventListener);
  window.removeEventListener(VIEW_EDIT_EVENT, onEdit as EventListener);
});
</script>

<template>
  <DsModal
    :model-value="open"
    :width="'600px'"
    @update:model-value="onModalUpdate"
  >
    <template #header>
      <h2 class="ved__title">{{ isEditing ? t('views.editorEdit') : t('views.editorNew') }}</h2>
      <span class="ved__live" :title="t('views.liveMatchTitle')">
        {{ t('views.liveMatch', { n: liveCount }) }}
      </span>
    </template>

    <div class="ved__body">
      <!-- Name / icon / color row -->
      <div class="ved__grid">
        <label class="ved__field ved__field--grow">
          <span class="ved__label">{{ t('views.name') }}</span>
          <DsInput
            v-model="draft.name"
            :placeholder="t('views.namePlaceholder')"
          />
        </label>
        <label class="ved__field ved__field--icon">
          <span class="ved__label">{{ t('views.icon') }}</span>
          <DsInput v-model="draft.icon" class="ved__input--icon" placeholder="🔖" />
        </label>
        <label class="ved__field ved__field--color">
          <span class="ved__label">{{ t('views.color') }}</span>
          <input v-model="draft.color" type="color" class="ved__color" :aria-label="t('views.color')" />
        </label>
      </div>

      <!-- Sort -->
      <div class="ved__grid">
        <label class="ved__field ved__field--grow">
          <span class="ved__label">{{ t('views.sortBy') }}</span>
          <DsSelect v-model="sortColumn" :options="sortOptions" />
        </label>
        <label class="ved__field ved__field--dir" v-if="draft.sort">
          <span class="ved__label">{{ t('views.sortDir') }}</span>
          <DsSelect v-model="sortDir" :options="dirOptions" />
        </label>
      </div>

      <!-- Display columns -->
      <div class="ved__field">
        <span class="ved__label">{{ t('views.columns') }}</span>
        <div class="ved__chips">
          <button
            v-for="c in columns"
            :key="c.id"
            type="button"
            class="ved__chipbtn"
            @click="toggleColumn(c.id)"
          >
            <DsChip size="sm" :color="draft.columns.includes(c.id) ? 'var(--accent)' : undefined">
              {{ c.label }}
            </DsChip>
          </button>
        </div>
        <span class="ved__hint">{{ t('views.columnsHint') }}</span>
      </div>

      <!-- Filters -->
      <div class="ved__field">
        <span class="ved__label">{{ t('views.filters') }}</span>
        <FilterBuilder
          :model-value="draft.filters"
          :columns="columns"
          :depth="0"
          :max-depth="3"
          @update:model-value="setFilters"
        />
      </div>
    </div>

    <template #footer>
      <DsButton variant="ghost" @click="close">{{ t('views.cancel') }}</DsButton>
      <DsButton variant="primary" :loading="saving" @click="save">{{ t('views.save') }}</DsButton>
    </template>
  </DsModal>
</template>

<style scoped>
.ved__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.ved__live {
  margin-left: auto;
  margin-right: var(--sp-3);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-hover);
  border-radius: var(--r-full);
  padding: 2px var(--sp-2);
  white-space: nowrap;
}
.ved__body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.ved__grid {
  display: flex;
  gap: var(--sp-3);
  align-items: flex-end;
}
.ved__field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
}
.ved__field--grow { flex: 1 1 auto; }
.ved__field--icon { flex: 0 0 64px; }
.ved__field--color { flex: 0 0 56px; }
.ved__field--dir { flex: 0 0 140px; }
.ved__label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.ved__hint {
  font-size: 11px;
  color: var(--text-faint);
}
.ved__input--icon :deep(.ds-input) {
  text-align: center;
}
.ved__color {
  height: 34px;
  width: 100%;
  border: var(--bd);
  border-radius: var(--r-md);
  background: var(--bg);
  cursor: pointer;
  padding: 2px;
}
.ved__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.ved__chipbtn {
  border: 0;
  background: transparent;
  padding: 0;
  cursor: pointer;
}
</style>
