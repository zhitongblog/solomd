<script setup lang="ts">
/**
 * Bases-style YAML properties table view (v2.0 F6).
 *
 * Renders every `.md` file in the workspace as a row in a table; each
 * frontmatter key seen 2+ times becomes a column. Filter/sort/save-view
 * state is local to this component (filter row above the table); saved
 * views persist to localStorage via `lib/bases.ts`.
 *
 * Virtual scrolling: the table body windows the rows by a viewport-sized
 * slice plus a 20-row buffer on each side. We compute visible rows from
 * scrollTop/clientHeight and pad with absolutely-zero-height spacer
 * <tr>s so total scroll height stays correct.
 *
 * Hosted by App.vue (parent integration); a "Back to editor" button in the
 * header dispatches `solomd:close-bases` so the parent can swap back.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useWorkspaceIndexStore, type IndexEntry } from '../stores/workspaceIndex';
import { useFiles } from '../composables/useFiles';
import { useI18n } from '../i18n';
import {
  applyFilters,
  applySort,
  defaultViews,
  getCellValue,
  inferColumns,
  loadSavedViews,
  persistSavedViews,
  type ColumnDef,
  type Filter,
  type SavedView,
  type SortSpec,
} from '../lib/bases';
import { BASES_CLOSE_EVENT } from '../composables/useBasesView';

const idx = useWorkspaceIndexStore();
const files = useFiles();
const { t } = useI18n();

// ---- columns ----
const allColumns = computed<ColumnDef[]>(() => inferColumns(idx.entries));
/** Ids of currently-visible columns. Empty array = "show all". */
const visibleColumnIds = ref<string[]>([]);
const visibleColumns = computed<ColumnDef[]>(() => {
  if (visibleColumnIds.value.length === 0) return allColumns.value;
  const set = new Set(visibleColumnIds.value);
  return allColumns.value.filter((c) => set.has(c.id));
});

// ---- filters / sort / saved views ----
const filters = reactive<Filter[]>([]);
const sort = ref<SortSpec | null>({ column: 'mtime', dir: 'desc' });
const savedViews = ref<SavedView[]>([]);
const activeViewName = ref<string>('All notes');

function loadViewIntoState(v: SavedView) {
  activeViewName.value = v.name;
  // Replace filters reactively
  filters.splice(0, filters.length, ...v.filters);
  visibleColumnIds.value = v.columns.slice();
  sort.value = v.sort ? { ...v.sort } : null;
}

function selectView(name: string) {
  const v = savedViews.value.find((x) => x.name === name);
  if (v) loadViewIntoState(v);
}

function newView() {
  const name = prompt(t('bases.newViewPrompt'));
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  // Replace existing view with same name
  const existing = savedViews.value.findIndex((v) => v.name === trimmed);
  const snapshot: SavedView = {
    name: trimmed,
    columns: visibleColumnIds.value.slice(),
    filters: filters.map((f) => ({ ...f })),
    sort: sort.value ? { ...sort.value } : null,
  };
  if (existing >= 0) savedViews.value.splice(existing, 1, snapshot);
  else savedViews.value.push(snapshot);
  persistSavedViews(savedViews.value);
  activeViewName.value = trimmed;
}

function deleteActiveView() {
  const i = savedViews.value.findIndex((v) => v.name === activeViewName.value);
  if (i < 0) return;
  // Don't allow deletion if it's the last one — reseed defaults.
  savedViews.value.splice(i, 1);
  if (savedViews.value.length === 0) savedViews.value = defaultViews();
  persistSavedViews(savedViews.value);
  loadViewIntoState(savedViews.value[0]);
}

// ---- filter row helpers ----
function getFilterFor(columnId: string): Filter | null {
  return filters.find((f) => f.column === columnId) ?? null;
}

function setFilter(columnId: string, op: Filter['op'], value: unknown) {
  const i = filters.findIndex((f) => f.column === columnId);
  if (
    value == null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  ) {
    if (i >= 0) filters.splice(i, 1);
    return;
  }
  const f: Filter = { column: columnId, op, value };
  if (i >= 0) filters.splice(i, 1, f);
  else filters.push(f);
}

function clearFilters() {
  filters.splice(0, filters.length);
}

/** Tag values present across the workspace, for the multi-select dropdown. */
const tagValues = computed<string[]>(() => {
  const set = new Set<string>();
  for (const e of idx.entries) for (const tag of e.tags) set.add(tag);
  return Array.from(set).sort();
});

/** Per-frontmatter-key array values (for array-column dropdowns). */
function arrayValuesFor(col: ColumnDef): string[] {
  const set = new Set<string>();
  for (const e of idx.entries) {
    if (col.source === 'builtin' && col.id === 'tags') {
      for (const v of e.tags) set.add(v);
    } else if (col.source === 'frontmatter' && col.fmKey && e.frontmatter) {
      const raw = (e.frontmatter as Record<string, unknown>)[col.fmKey];
      if (Array.isArray(raw)) {
        for (const v of raw) set.add(String(v));
      } else if (raw != null) {
        set.add(String(raw));
      }
    }
  }
  return Array.from(set).sort();
}

// ---- sort header click ----
function toggleSort(col: ColumnDef) {
  if (!sort.value || sort.value.column !== col.id) {
    sort.value = { column: col.id, dir: 'asc' };
  } else if (sort.value.dir === 'asc') {
    sort.value = { column: col.id, dir: 'desc' };
  } else {
    sort.value = null;
  }
}
function sortIndicator(col: ColumnDef): string {
  if (!sort.value || sort.value.column !== col.id) return '';
  return sort.value.dir === 'asc' ? ' ▲' : ' ▼';
}

// ---- final rows after filter+sort ----
const processedRows = computed<IndexEntry[]>(() => {
  const filtered = applyFilters(idx.entries, filters, allColumns.value);
  return applySort(filtered, sort.value, allColumns.value);
});

// ---- virtual scroll ----
const ROW_HEIGHT = 32; // px, matches CSS
const BUFFER_ROWS = 20;

const scrollEl = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(600);

function onScroll(e: Event) {
  scrollTop.value = (e.target as HTMLElement).scrollTop;
}

function recomputeViewport() {
  if (scrollEl.value) {
    viewportHeight.value = scrollEl.value.clientHeight;
  }
}

const visibleSlice = computed(() => {
  const total = processedRows.value.length;
  if (total === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const visibleStart = Math.floor(scrollTop.value / ROW_HEIGHT);
  const visibleCount = Math.ceil(viewportHeight.value / ROW_HEIGHT);
  const start = Math.max(0, visibleStart - BUFFER_ROWS);
  const end = Math.min(total, visibleStart + visibleCount + BUFFER_ROWS);
  return {
    start,
    end,
    padTop: start * ROW_HEIGHT,
    padBottom: (total - end) * ROW_HEIGHT,
  };
});

const visibleRows = computed(() =>
  processedRows.value.slice(visibleSlice.value.start, visibleSlice.value.end),
);

// IntersectionObserver as a passive trigger to recompute when the table
// scrolls into view (e.g. after open). Spec asks for it explicitly.
let io: IntersectionObserver | null = null;
function setupObserver() {
  if (!scrollEl.value || typeof IntersectionObserver === 'undefined') return;
  io = new IntersectionObserver(() => {
    recomputeViewport();
  });
  io.observe(scrollEl.value);
}

// ---- column picker ----
const columnPickerOpen = ref(false);
function toggleColumn(id: string) {
  // First click: switch to explicit list (start with all current columns).
  if (visibleColumnIds.value.length === 0) {
    visibleColumnIds.value = allColumns.value.map((c) => c.id);
  }
  const i = visibleColumnIds.value.indexOf(id);
  if (i >= 0) visibleColumnIds.value.splice(i, 1);
  else visibleColumnIds.value.push(id);
}
function isColumnVisible(id: string): boolean {
  if (visibleColumnIds.value.length === 0) return true;
  return visibleColumnIds.value.includes(id);
}

// ---- file open ----
async function openEntry(entry: IndexEntry) {
  await files.openPath(entry.path, { bypassNewWindow: true });
  // After open, parent can keep the bases view up — don't auto-close.
  // (User can hit "Back to editor" if they want to leave the table.)
}

function closeBases() {
  window.dispatchEvent(new CustomEvent(BASES_CLOSE_EVENT));
}

// ---- lifecycle ----
let resizeHandler: (() => void) | null = null;

onMounted(() => {
  // Seed saved views.
  savedViews.value = loadSavedViews();
  if (savedViews.value.length === 0) {
    savedViews.value = defaultViews();
    persistSavedViews(savedViews.value);
  }
  // Auto-add the "Tagged #project" default if the workspace happens to use it.
  if (
    tagValues.value.includes('project') &&
    !savedViews.value.some((v) => v.name === 'Tagged #project')
  ) {
    savedViews.value.push({
      name: 'Tagged #project',
      columns: [],
      filters: [{ column: 'tags', op: 'has-tag', value: 'project' }],
      sort: { column: 'mtime', dir: 'desc' },
    });
    persistSavedViews(savedViews.value);
  }
  loadViewIntoState(savedViews.value[0]);

  recomputeViewport();
  setupObserver();
  resizeHandler = () => recomputeViewport();
  window.addEventListener('resize', resizeHandler);
});

onBeforeUnmount(() => {
  if (resizeHandler) window.removeEventListener('resize', resizeHandler);
  if (io) {
    io.disconnect();
    io = null;
  }
});

// Reset scroll on row-set changes so the user isn't stranded mid-list when
// filters narrow results to a small set.
watch(
  () => [processedRows.value.length, activeViewName.value],
  () => {
    if (scrollEl.value) scrollEl.value.scrollTop = 0;
    scrollTop.value = 0;
  },
);

// ---- per-cell text for keyed rendering ----
function cellText(entry: IndexEntry, col: ColumnDef): string {
  return String(getCellValue(entry, col) ?? '');
}

// ---- date range filter helpers ----
function getDateRangeStart(columnId: string): string {
  const f = filters.find((x) => x.column === columnId && x.op === '>');
  if (!f || !f.value) return '';
  const d = new Date(typeof f.value === 'number' ? f.value : String(f.value));
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function getDateRangeEnd(columnId: string): string {
  const f = filters.find((x) => x.column === columnId && x.op === '<');
  if (!f || !f.value) return '';
  const d = new Date(typeof f.value === 'number' ? f.value : String(f.value));
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function setDateRangeStart(columnId: string, value: string) {
  const i = filters.findIndex((x) => x.column === columnId && x.op === '>');
  if (!value) {
    if (i >= 0) filters.splice(i, 1);
    return;
  }
  const ms = new Date(value).getTime();
  if (isNaN(ms)) return;
  const f: Filter = { column: columnId, op: '>', value: ms };
  if (i >= 0) filters.splice(i, 1, f);
  else filters.push(f);
}
function setDateRangeEnd(columnId: string, value: string) {
  const i = filters.findIndex((x) => x.column === columnId && x.op === '<');
  if (!value) {
    if (i >= 0) filters.splice(i, 1);
    return;
  }
  const ms = new Date(value).getTime();
  if (isNaN(ms)) return;
  const f: Filter = { column: columnId, op: '<', value: ms };
  if (i >= 0) filters.splice(i, 1, f);
  else filters.push(f);
}

// ---- multi-select tag filter ----
function selectedTagsFor(columnId: string): string[] {
  const f = filters.find((x) => x.column === columnId && x.op === 'has-tag');
  if (!f) return [];
  return Array.isArray(f.value) ? (f.value as string[]) : [String(f.value)];
}
function toggleTagFilter(columnId: string, tag: string) {
  const cur = selectedTagsFor(columnId);
  const next = cur.includes(tag) ? cur.filter((x) => x !== tag) : [...cur, tag];
  setFilter(columnId, 'has-tag', next);
}
</script>

<template>
  <div class="bases">
    <header class="bases__head">
      <div class="bases__head-left">
        <button
          class="bases__back"
          :title="t('bases.back')"
          @click="closeBases"
        >
          {{ t('bases.back') }}
        </button>
        <strong class="bases__title">{{ t('bases.title') }}</strong>
        <select
          class="bases__view-select"
          :value="activeViewName"
          @change="(e) => selectView((e.target as HTMLSelectElement).value)"
        >
          <option v-for="v in savedViews" :key="v.name" :value="v.name">
            {{ v.name }}
          </option>
        </select>
        <button class="bases__btn" @click="newView">
          {{ t('bases.newView') }}
        </button>
        <button
          class="bases__btn"
          :disabled="savedViews.length <= 1"
          @click="deleteActiveView"
        >
          {{ t('bases.deleteView') }}
        </button>
      </div>
      <div class="bases__head-right">
        <div class="bases__col-picker">
          <button class="bases__btn" @click="columnPickerOpen = !columnPickerOpen">
            {{ t('bases.columns') }}
          </button>
          <div v-if="columnPickerOpen" class="bases__col-menu" @click.stop>
            <label
              v-for="c in allColumns"
              :key="c.id"
              class="bases__col-menu-item"
            >
              <input
                type="checkbox"
                :checked="isColumnVisible(c.id)"
                @change="toggleColumn(c.id)"
              />
              <span>{{ c.label }}</span>
              <span class="bases__kind">{{ c.kind }}</span>
            </label>
          </div>
        </div>
        <button
          v-if="filters.length > 0"
          class="bases__btn"
          @click="clearFilters"
        >
          {{ t('bases.clearFilters') }}
        </button>
        <span class="bases__count">
          {{ t('bases.rowCount', { n: processedRows.length }) }}
        </span>
      </div>
    </header>

    <div v-if="!idx.ready" class="bases__empty">
      {{ t('bases.openFolder') }}
    </div>
    <div v-else-if="idx.entries.length === 0" class="bases__empty">
      {{ t('bases.noEntries') }}
    </div>
    <div v-else class="bases__scroll" ref="scrollEl" @scroll="onScroll">
      <table class="bases__table">
        <thead>
          <tr>
            <th
              v-for="col in visibleColumns"
              :key="col.id"
              class="bases__th"
              :class="`bases__th--${col.kind}`"
              @click="toggleSort(col)"
            >
              {{ col.label }}<span class="bases__sort">{{ sortIndicator(col) }}</span>
            </th>
          </tr>
          <tr class="bases__filter-row">
            <th
              v-for="col in visibleColumns"
              :key="col.id"
              class="bases__filter-cell"
            >
              <!-- Date / mtime: range pickers -->
              <template
                v-if="col.kind === 'date' || (col.source === 'builtin' && col.id === 'mtime')"
              >
                <div class="bases__range">
                  <input
                    type="date"
                    :value="getDateRangeStart(col.id)"
                    :title="t('bases.dateAfter')"
                    @input="(e) => setDateRangeStart(col.id, (e.target as HTMLInputElement).value)"
                  />
                  <input
                    type="date"
                    :value="getDateRangeEnd(col.id)"
                    :title="t('bases.dateBefore')"
                    @input="(e) => setDateRangeEnd(col.id, (e.target as HTMLInputElement).value)"
                  />
                </div>
              </template>

              <!-- Array / tags: multi-select dropdown -->
              <template v-else-if="col.kind === 'array'">
                <details class="bases__multi">
                  <summary>
                    {{ selectedTagsFor(col.id).length === 0
                      ? t('bases.anyValue')
                      : selectedTagsFor(col.id).join(', ') }}
                  </summary>
                  <div class="bases__multi-list">
                    <label
                      v-for="v in arrayValuesFor(col)"
                      :key="v"
                      class="bases__multi-item"
                    >
                      <input
                        type="checkbox"
                        :checked="selectedTagsFor(col.id).includes(v)"
                        @change="toggleTagFilter(col.id, v)"
                      />
                      <span>{{ v }}</span>
                    </label>
                    <div v-if="arrayValuesFor(col).length === 0" class="bases__multi-empty">
                      {{ t('bases.noValues') }}
                    </div>
                  </div>
                </details>
              </template>

              <!-- Number: > and < operators -->
              <template v-else-if="col.kind === 'number'">
                <input
                  type="number"
                  class="bases__filter-input"
                  :placeholder="t('bases.filterNumber')"
                  :value="(getFilterFor(col.id) && getFilterFor(col.id)!.op === '>') ? String(getFilterFor(col.id)!.value ?? '') : ''"
                  @input="(e) => setFilter(col.id, '>', (e.target as HTMLInputElement).value)"
                />
              </template>

              <!-- Boolean: tri-state select -->
              <template v-else-if="col.kind === 'boolean'">
                <select
                  class="bases__filter-input"
                  :value="getFilterFor(col.id) ? String(getFilterFor(col.id)!.value) : ''"
                  @change="(e) => {
                    const v = (e.target as HTMLSelectElement).value;
                    setFilter(col.id, 'equals', v === '' ? null : v === 'true');
                  }"
                >
                  <option value="">{{ t('bases.anyValue') }}</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              </template>

              <!-- Text fallback -->
              <template v-else>
                <input
                  type="text"
                  class="bases__filter-input"
                  :placeholder="t('bases.filterText')"
                  :value="getFilterFor(col.id) ? String(getFilterFor(col.id)!.value ?? '') : ''"
                  @input="(e) => setFilter(col.id, 'contains', (e.target as HTMLInputElement).value)"
                />
              </template>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-if="visibleSlice.padTop > 0"
            class="bases__pad"
            :style="{ height: visibleSlice.padTop + 'px' }"
          ></tr>
          <tr
            v-for="entry in visibleRows"
            :key="entry.path"
            class="bases__row"
          >
            <td
              v-for="col in visibleColumns"
              :key="col.id"
              class="bases__td"
              :class="`bases__td--${col.kind}`"
            >
              <a
                v-if="col.id === 'name'"
                href="#"
                class="bases__link"
                @click.prevent="openEntry(entry)"
              >{{ cellText(entry, col) }}</a>
              <template v-else>{{ cellText(entry, col) }}</template>
            </td>
          </tr>
          <tr
            v-if="visibleSlice.padBottom > 0"
            class="bases__pad"
            :style="{ height: visibleSlice.padBottom + 'px' }"
          ></tr>
          <tr v-if="processedRows.length === 0">
            <td :colspan="visibleColumns.length" class="bases__empty-row">
              {{ t('bases.noMatch') }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.bases {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}
.bases__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
  flex-wrap: wrap;
}
.bases__head-left,
.bases__head-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bases__back {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
}
.bases__back:hover {
  background: var(--bg-hover);
}
.bases__title {
  font-size: 13px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.bases__view-select,
.bases__btn {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 4px 8px;
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
}
.bases__btn:hover:not(:disabled) {
  background: var(--bg-hover);
}
.bases__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.bases__col-picker {
  position: relative;
}
.bases__col-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px;
  min-width: 200px;
  max-height: 320px;
  overflow-y: auto;
  z-index: 20;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
}
.bases__col-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
  border-radius: 4px;
}
.bases__col-menu-item:hover {
  background: var(--bg-hover);
}
.bases__kind {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-faint);
  text-transform: uppercase;
}
.bases__count {
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.bases__empty {
  padding: 48px 16px;
  text-align: center;
  color: var(--text-faint);
  font-size: 13px;
}
.bases__scroll {
  flex: 1;
  overflow: auto;
  min-height: 0;
}
.bases__table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12px;
  table-layout: auto;
}
.bases__th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-soft);
  text-align: left;
  padding: 6px 10px;
  font-weight: 600;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
.bases__th:hover {
  color: var(--text);
}
.bases__th--number {
  text-align: right;
}
.bases__sort {
  font-size: 10px;
  color: var(--accent);
  margin-left: 2px;
}
.bases__filter-row {
  position: sticky;
  top: 28px;
  z-index: 1;
}
.bases__filter-cell {
  background: var(--bg);
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.bases__filter-input {
  width: 100%;
  font-size: 11px;
  padding: 3px 6px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);
  box-sizing: border-box;
}
.bases__range {
  display: flex;
  gap: 4px;
}
.bases__range input {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  padding: 3px 4px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);
  box-sizing: border-box;
}
.bases__multi {
  font-size: 11px;
}
.bases__multi summary {
  cursor: pointer;
  padding: 3px 6px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  list-style: none;
}
.bases__multi summary::-webkit-details-marker {
  display: none;
}
.bases__multi-list {
  margin-top: 2px;
  padding: 4px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 4px;
  max-height: 180px;
  overflow-y: auto;
}
.bases__multi-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 3px;
}
.bases__multi-item:hover {
  background: var(--bg-hover);
}
.bases__multi-empty {
  padding: 6px;
  text-align: center;
  color: var(--text-faint);
}
.bases__row:hover .bases__td {
  background: var(--bg-hover);
}
.bases__td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 320px;
  height: 32px;
  box-sizing: border-box;
}
.bases__td--number {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.bases__td--date {
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}
.bases__link {
  color: var(--accent);
  text-decoration: none;
  cursor: pointer;
}
.bases__link:hover {
  text-decoration: underline;
}
.bases__pad td {
  padding: 0;
  border: 0;
}
.bases__pad {
  /* Spacer rows for virtual scrolling. Height set inline. */
}
.bases__empty-row {
  padding: 32px 16px;
  text-align: center;
  color: var(--text-faint);
}
</style>
