<script setup lang="ts">
/**
 * Create / edit a saved view (F5) — modal dialog.
 *
 * Opened by the `solomd:new-view` / `solomd:edit-view` window events (see
 * useSavedViews). Hosts {@link FilterBuilder} plus name / icon / color / sort
 * / column-visibility controls. On save it persists through the savedViews
 * store (disk write) and, for a brand-new view, opens it in the content area.
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

/** Sort options = built-in + frontmatter columns, plus a "default" sentinel. */
const sortColumns = computed(() => columns.value);

const isEditing = computed(() => editingSlug.value !== null);

function loadDraft(v: ViewFile) {
  draft.slug = v.slug;
  draft.name = v.name;
  draft.icon = v.icon;
  draft.color = v.color;
  draft.order = v.order;
  draft.columns = [...v.columns];
  draft.sort = v.sort ? { ...v.sort } : null;
  // Deep-ish clone of the filter tree so edits don't mutate the store copy.
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

// ---- sort controls ---------------------------------------------------------

const sortColumn = computed<string>({
  get: () => draft.sort?.column ?? '',
  set: (col: string) => {
    if (!col) draft.sort = null;
    else draft.sort = { column: col, dir: draft.sort?.dir ?? 'desc' };
  },
});
const sortDir = computed<'asc' | 'desc'>({
  get: () => draft.sort?.dir ?? 'desc',
  set: (dir) => {
    if (draft.sort) draft.sort = { ...draft.sort, dir } as SortSpec;
  },
});

function toggleColumn(id: string) {
  const i = draft.columns.indexOf(id);
  if (i >= 0) draft.columns.splice(i, 1);
  else draft.columns.push(id);
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
    open.value = false;
    if (!editingSlug.value) openView(saved.slug);
  } catch (e) {
    console.error('[ViewEditorDialog] save failed', e);
  } finally {
    saving.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (!open.value) return;
  if (e.key === 'Escape') { e.stopPropagation(); close(); }
}

onMounted(() => {
  window.addEventListener(VIEW_NEW_EVENT, onNew as EventListener);
  window.addEventListener(VIEW_EDIT_EVENT, onEdit as EventListener);
  window.addEventListener('keydown', onKey, true);
});
onBeforeUnmount(() => {
  window.removeEventListener(VIEW_NEW_EVENT, onNew as EventListener);
  window.removeEventListener(VIEW_EDIT_EVENT, onEdit as EventListener);
  window.removeEventListener('keydown', onKey, true);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ved__backdrop" @click.self="close">
      <div class="ved" role="dialog" aria-modal="true">
        <div class="ved__head">
          <h2 class="ved__title">{{ isEditing ? t('views.editorEdit') : t('views.editorNew') }}</h2>
          <button class="ved__x" type="button" :title="t('views.cancel')" @click="close">✕</button>
        </div>

        <div class="ved__body">
          <!-- Name / icon / color row -->
          <div class="ved__grid">
            <label class="ved__field ved__field--grow">
              <span class="ved__label">{{ t('views.name') }}</span>
              <input
                v-model="draft.name"
                class="ved__input"
                :placeholder="t('views.namePlaceholder')"
                spellcheck="false"
              />
            </label>
            <label class="ved__field ved__field--icon">
              <span class="ved__label">{{ t('views.icon') }}</span>
              <input v-model="draft.icon" class="ved__input ved__input--icon" maxlength="2" placeholder="🔖" />
            </label>
            <label class="ved__field ved__field--color">
              <span class="ved__label">{{ t('views.color') }}</span>
              <input v-model="draft.color" type="color" class="ved__color" />
            </label>
          </div>

          <!-- Sort -->
          <div class="ved__grid">
            <label class="ved__field ved__field--grow">
              <span class="ved__label">{{ t('views.sortBy') }}</span>
              <select v-model="sortColumn" class="ved__input">
                <option value="">{{ t('views.desc') }} — {{ 'mtime' }}</option>
                <option v-for="c in sortColumns" :key="c.id" :value="c.id">{{ c.label }}</option>
              </select>
            </label>
            <label class="ved__field" v-if="draft.sort">
              <span class="ved__label">{{ t('views.sortDir') }}</span>
              <select v-model="sortDir" class="ved__input">
                <option value="asc">{{ t('views.asc') }}</option>
                <option value="desc">{{ t('views.desc') }}</option>
              </select>
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
                class="ved__chip"
                :class="{ 'ved__chip--on': draft.columns.includes(c.id) }"
                @click="toggleColumn(c.id)"
              >{{ c.label }}</button>
            </div>
            <span class="ved__hint">{{ t('views.columnsHint') }}</span>
          </div>

          <!-- Filters -->
          <div class="ved__field">
            <span class="ved__label">{{ t('views.filters') }}</span>
            <FilterBuilder v-model="draft.filters" :columns="columns" :depth="0" />
          </div>
        </div>

        <div class="ved__foot">
          <button class="ved__btn" type="button" @click="close">{{ t('views.cancel') }}</button>
          <button class="ved__btn ved__btn--primary" type="button" :disabled="saving" @click="save">
            {{ t('views.save') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ved__backdrop {
  position: fixed;
  inset: 0;
  z-index: 400;
  background: color-mix(in srgb, var(--text) 30%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.ved {
  width: 560px;
  max-width: 100%;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
}
.ved__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.ved__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.ved__x {
  border: 0;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  border-radius: 4px;
  padding: 2px 6px;
}
.ved__x:hover { color: var(--text); background: var(--bg-hover); }
.ved__body {
  padding: 16px 18px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.ved__grid {
  display: flex;
  gap: 12px;
  align-items: flex-end;
}
.ved__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.ved__field--grow { flex: 1 1 auto; }
.ved__field--icon { flex: 0 0 56px; }
.ved__field--color { flex: 0 0 56px; }
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
.ved__input {
  font: inherit;
  font-size: 13px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  min-width: 0;
}
.ved__input--icon { text-align: center; }
.ved__color {
  height: 32px;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  cursor: pointer;
  padding: 2px;
}
.ved__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ved__chip {
  font-size: 11px;
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.ved__chip--on {
  background: var(--accent);
  color: var(--accent-fg);
  border-color: var(--accent);
}
.ved__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
}
.ved__btn {
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
}
.ved__btn:hover { background: var(--bg-hover); }
.ved__btn--primary {
  background: var(--accent);
  color: var(--accent-fg);
  border-color: var(--accent);
}
.ved__btn--primary:disabled { opacity: 0.5; cursor: default; }
</style>
