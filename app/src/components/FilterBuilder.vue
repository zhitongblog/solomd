<script setup lang="ts">
/**
 * Recursive all/any filter-group editor (F5).
 *
 * Renders one {@link FilterGroup}: an all/any combinator toggle plus a list of
 * rows. Each row is either a leaf condition (field / operator / value) or a
 * nested group (this same component, recursively). Edits mutate the bound
 * `modelValue` via `update:modelValue` so the parent dialog always holds the
 * canonical tree. Drag a row's grip to reorder within its group.
 *
 * The component is purely presentational over `bases.ts` columns + the
 * `viewFile.ts` op set — no Tauri / store access.
 */
import { computed, ref } from 'vue';
import { useI18n } from '../i18n';
import {
  VIEW_OPS,
  isFilterGroup,
  compileSafeUserRegex,
  type FilterGroup,
  type FilterLeaf,
  type FilterNode,
  type ViewOp,
} from '../lib/viewFile';
import { RELATIVE_DATE_PRESETS } from '../lib/relativeDates';
import type { ColumnDef } from '../lib/bases';

const props = defineProps<{
  modelValue: FilterGroup;
  columns: ColumnDef[];
  /** Nesting depth — caps recursion in the UI to keep trees readable. */
  depth?: number;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: FilterGroup): void;
}>();

const { t } = useI18n();

const depth = computed(() => props.depth ?? 0);

function emitGroup(next: FilterGroup) {
  emit('update:modelValue', next);
}

function setCombinator(c: 'all' | 'any') {
  emitGroup({ ...props.modelValue, combinator: c });
}

function updateChild(idx: number, node: FilterNode) {
  const children = props.modelValue.children.slice();
  children[idx] = node;
  emitGroup({ ...props.modelValue, children });
}

function removeChild(idx: number) {
  const children = props.modelValue.children.slice();
  children.splice(idx, 1);
  emitGroup({ ...props.modelValue, children });
}

function addCondition() {
  const firstCol = props.columns[0]?.id ?? 'name';
  const leaf: FilterLeaf = { column: firstCol, op: 'contains', value: '' };
  emitGroup({ ...props.modelValue, children: [...props.modelValue.children, leaf] });
}

function addGroup() {
  const group: FilterGroup = { combinator: 'all', children: [] };
  emitGroup({ ...props.modelValue, children: [...props.modelValue.children, group] });
}

// ---- leaf editing ----------------------------------------------------------

function opNeedsValue(op: ViewOp): boolean {
  return VIEW_OPS.find((o) => o.value === op)?.needsValue ?? true;
}

function isDateColumn(columnId: string): boolean {
  const col = props.columns.find((c) => c.id === columnId);
  return !!col && (col.kind === 'date' || col.id === 'mtime');
}

function setLeafField(idx: number, leaf: FilterLeaf, column: string) {
  updateChild(idx, { ...leaf, column });
}
function setLeafOp(idx: number, leaf: FilterLeaf, op: ViewOp) {
  const next: FilterLeaf = { ...leaf, op };
  if (!opNeedsValue(op)) delete next.value;
  else if (next.value === undefined) next.value = '';
  updateChild(idx, next);
}
function setLeafValue(idx: number, leaf: FilterLeaf, value: unknown) {
  updateChild(idx, { ...leaf, value });
}

function regexBad(leaf: FilterLeaf): boolean {
  if (leaf.op !== 'regex') return false;
  const v = String(leaf.value ?? '');
  return v.length > 0 && compileSafeUserRegex(v) === null;
}

// ---- drag reorder within this group ---------------------------------------

const dragIdx = ref<number | null>(null);
const overIdx = ref<number | null>(null);

function onDragStart(idx: number, e: DragEvent) {
  dragIdx.value = idx;
  e.dataTransfer?.setData('text/plain', String(idx));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(idx: number, e: DragEvent) {
  e.preventDefault();
  overIdx.value = idx;
}
function onDrop(idx: number) {
  const from = dragIdx.value;
  dragIdx.value = null;
  overIdx.value = null;
  if (from == null || from === idx) return;
  const children = props.modelValue.children.slice();
  const [moved] = children.splice(from, 1);
  children.splice(idx, 0, moved);
  emitGroup({ ...props.modelValue, children });
}
function onDragEnd() {
  dragIdx.value = null;
  overIdx.value = null;
}

function asLeaf(node: FilterNode): FilterLeaf {
  return node as FilterLeaf;
}
function asGroup(node: FilterNode): FilterGroup {
  return node as FilterGroup;
}
</script>

<template>
  <div class="fb" :class="`fb--depth-${depth}`">
    <div class="fb__head">
      <div class="fb__combi" role="tablist">
        <button
          class="fb__combi-btn"
          :class="{ 'fb__combi-btn--on': modelValue.combinator === 'all' }"
          type="button"
          @click="setCombinator('all')"
        >{{ t('views.matchAll') }}</button>
        <button
          class="fb__combi-btn"
          :class="{ 'fb__combi-btn--on': modelValue.combinator === 'any' }"
          type="button"
          @click="setCombinator('any')"
        >{{ t('views.matchAny') }}</button>
      </div>
    </div>

    <ul class="fb__rows">
      <li
        v-for="(child, idx) in modelValue.children"
        :key="idx"
        class="fb__row"
        :class="{ 'fb__row--over': overIdx === idx, 'fb__row--group': isFilterGroup(child) }"
        @dragover="onDragOver(idx, $event)"
        @drop="onDrop(idx)"
      >
        <span
          class="fb__grip"
          draggable="true"
          :title="t('rsPane.dragToReorder')"
          @dragstart="onDragStart(idx, $event)"
          @dragend="onDragEnd"
        >⋮⋮</span>

        <!-- Nested group -->
        <FilterBuilder
          v-if="isFilterGroup(child)"
          class="fb__nested"
          :model-value="asGroup(child)"
          :columns="columns"
          :depth="depth + 1"
          @update:model-value="(g: FilterGroup) => updateChild(idx, g)"
        />

        <!-- Leaf condition -->
        <template v-else>
          <select
            class="fb__sel fb__sel--field"
            :value="asLeaf(child).column"
            @change="setLeafField(idx, asLeaf(child), ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="c in columns" :key="c.id" :value="c.id">{{ c.label }}</option>
          </select>
          <select
            class="fb__sel fb__sel--op"
            :value="asLeaf(child).op"
            @change="setLeafOp(idx, asLeaf(child), ($event.target as HTMLSelectElement).value as ViewOp)"
          >
            <option v-for="o in VIEW_OPS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <template v-if="opNeedsValue(asLeaf(child).op)">
            <input
              class="fb__val"
              :class="{ 'fb__val--bad': regexBad(asLeaf(child)) }"
              :value="String(asLeaf(child).value ?? '')"
              :placeholder="t('views.valuePlaceholder')"
              :list="isDateColumn(asLeaf(child).column) ? 'fb-relative-dates' : undefined"
              @input="setLeafValue(idx, asLeaf(child), ($event.target as HTMLInputElement).value)"
            />
          </template>
          <span v-else class="fb__val-spacer" />
        </template>

        <button
          class="fb__del"
          type="button"
          :title="t('views.removeRow')"
          @click="removeChild(idx)"
        >✕</button>
      </li>
    </ul>

    <div class="fb__add">
      <button class="fb__add-btn" type="button" @click="addCondition">{{ t('views.addCondition') }}</button>
      <button v-if="depth < 3" class="fb__add-btn" type="button" @click="addGroup">{{ t('views.addGroup') }}</button>
    </div>

    <!-- Shared datalist for relative-date suggestions on date fields. -->
    <datalist id="fb-relative-dates">
      <option v-for="p in RELATIVE_DATE_PRESETS" :key="p.value" :value="p.value">{{ p.label }}</option>
    </datalist>
  </div>
</template>

<script lang="ts">
export default { name: 'FilterBuilder' };
</script>

<style scoped>
.fb {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  background: var(--bg);
}
.fb--depth-1, .fb--depth-2, .fb--depth-3 {
  background: var(--bg-elev);
}
.fb__head {
  display: flex;
  align-items: center;
  margin-bottom: 6px;
}
.fb__combi {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.fb__combi-btn {
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 600;
  background: transparent;
  border: 0;
  color: var(--text-muted);
  cursor: pointer;
}
.fb__combi-btn--on {
  background: var(--accent);
  color: var(--accent-fg);
}
.fb__rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.fb__row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.fb__row--group {
  align-items: stretch;
}
.fb__row--over {
  outline: 1px dashed var(--accent);
  outline-offset: 1px;
}
.fb__grip {
  cursor: grab;
  color: var(--text-faint);
  font-size: 11px;
  user-select: none;
  flex: 0 0 auto;
  padding: 0 1px;
}
.fb__nested {
  flex: 1 1 auto;
  min-width: 0;
}
.fb__sel,
.fb__val {
  font: inherit;
  font-size: 12px;
  padding: 3px 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev);
  color: var(--text);
  min-width: 0;
}
.fb__sel--field { flex: 0 1 120px; }
.fb__sel--op { flex: 0 1 130px; }
.fb__val { flex: 1 1 auto; }
.fb__val--bad {
  border-color: var(--danger);
}
.fb__val-spacer { flex: 1 1 auto; }
.fb__del {
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 4px;
}
.fb__del:hover {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}
.fb__add {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.fb__add-btn {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.fb__add-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}
</style>
