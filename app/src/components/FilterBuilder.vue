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
 * The value input adapts to the column KIND (number / date / tags) and to the
 * operator (multi-value list for any_of/none_of, ReDoS-checked regex). Built
 * exclusively from the design-system primitives in `@/ui` + design tokens —
 * no raw hex. No Tauri / store access; it's pure over `bases.ts` columns + the
 * `viewFile.ts` op vocabulary.
 */
import { computed, ref } from 'vue';
import { useI18n } from '../i18n';
import {
  VIEW_OPS,
  isFilterGroup,
  isRegexLeafInvalid,
  opIsMultiValue,
  type FilterGroup,
  type FilterLeaf,
  type FilterNode,
  type ViewOp,
} from '../lib/viewFile';
import { RELATIVE_DATE_PRESETS } from '../lib/relativeDates';
import type { ColumnDef } from '../lib/bases';
import { DsButton, DsInput, DsSelect, type DsSelectOption } from '../ui';

const props = withDefaults(
  defineProps<{
    modelValue: FilterGroup;
    columns: ColumnDef[];
    /** Nesting depth — caps recursion in the UI to keep trees readable. */
    depth?: number;
    /** Max nesting depth allowed (groups beyond this can't add sub-groups). */
    maxDepth?: number;
  }>(),
  { depth: 0, maxDepth: 3 },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: FilterGroup): void;
}>();

const { t } = useI18n();

const depth = computed(() => props.depth);

const fieldOptions = computed<DsSelectOption[]>(() =>
  props.columns.map((c) => ({ value: c.id, label: c.label })),
);
const opOptions = computed<DsSelectOption[]>(() =>
  VIEW_OPS.map((o) => ({ value: o.value, label: o.label })),
);

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

function columnKind(columnId: string): ColumnDef['kind'] {
  const col = props.columns.find((c) => c.id === columnId);
  if (!col) return 'text';
  if (col.id === 'mtime') return 'date';
  return col.kind;
}
function isDateColumn(columnId: string): boolean {
  return columnKind(columnId) === 'date';
}
function isNumberColumn(columnId: string): boolean {
  return columnKind(columnId) === 'number';
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

/** Toggle a text leaf between substring (`contains`) and `regex` matching. */
function toggleRegex(idx: number, leaf: FilterLeaf) {
  const next: FilterLeaf = { ...leaf, op: leaf.op === 'regex' ? 'contains' : 'regex' };
  updateChild(idx, next);
}
function regexActive(leaf: FilterLeaf): boolean {
  return leaf.op === 'regex';
}
/** Whether the regex toggle should be offered (text-ish ops only). */
function canToggleRegex(leaf: FilterLeaf): boolean {
  return leaf.op === 'contains' || leaf.op === 'regex';
}

function regexBad(leaf: FilterLeaf): boolean {
  return isRegexLeafInvalid(leaf);
}

/** Relative-date preset options for a date column's value dropdown. */
const relativeOptions = computed<DsSelectOption[]>(() => [
  { value: '', label: t('views.pickDate') },
  ...RELATIVE_DATE_PRESETS.map((p) => ({ value: p.value, label: p.label })),
]);

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
      <div class="fb__combi" role="tablist" :aria-label="t('views.combinator')">
        <button
          class="fb__combi-btn"
          :class="{ 'fb__combi-btn--on': modelValue.combinator === 'all' }"
          type="button"
          role="tab"
          :aria-selected="modelValue.combinator === 'all'"
          @click="setCombinator('all')"
        >{{ t('views.matchAll') }}</button>
        <button
          class="fb__combi-btn"
          :class="{ 'fb__combi-btn--on': modelValue.combinator === 'any' }"
          type="button"
          role="tab"
          :aria-selected="modelValue.combinator === 'any'"
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
          :title="t('views.dragToReorder')"
          aria-hidden="true"
          @dragstart="onDragStart(idx, $event)"
          @dragend="onDragEnd"
        >⠿</span>

        <!-- Nested group -->
        <FilterBuilder
          v-if="isFilterGroup(child)"
          class="fb__nested"
          :model-value="asGroup(child)"
          :columns="columns"
          :depth="depth + 1"
          :max-depth="maxDepth"
          @update:model-value="(g: FilterGroup) => updateChild(idx, g)"
        />

        <!-- Leaf condition -->
        <template v-else>
          <div class="fb__sel fb__sel--field">
            <DsSelect
              size="sm"
              :model-value="asLeaf(child).column"
              :options="fieldOptions"
              @update:model-value="(v: string) => setLeafField(idx, asLeaf(child), v)"
            />
          </div>
          <div class="fb__sel fb__sel--op">
            <DsSelect
              size="sm"
              :model-value="asLeaf(child).op"
              :options="opOptions"
              @update:model-value="(v: string) => setLeafOp(idx, asLeaf(child), v as ViewOp)"
            />
          </div>

          <!-- Value input: shape depends on column kind + op -->
          <template v-if="opNeedsValue(asLeaf(child).op)">
            <!-- multi-value (any_of / none_of) -->
            <div v-if="opIsMultiValue(asLeaf(child).op)" class="fb__val">
              <DsInput
                size="sm"
                :model-value="String(asLeaf(child).value ?? '')"
                :placeholder="t('views.listPlaceholder')"
                @update:model-value="(v: string) => setLeafValue(idx, asLeaf(child), v)"
              />
            </div>

            <!-- date column: free text + relative presets -->
            <div v-else-if="isDateColumn(asLeaf(child).column)" class="fb__val fb__val--date">
              <DsInput
                size="sm"
                :model-value="String(asLeaf(child).value ?? '')"
                :placeholder="t('views.datePlaceholder')"
                @update:model-value="(v: string) => setLeafValue(idx, asLeaf(child), v)"
              />
              <DsSelect
                class="fb__rel"
                size="sm"
                :model-value="''"
                :options="relativeOptions"
                @update:model-value="(v: string) => v && setLeafValue(idx, asLeaf(child), v)"
              />
            </div>

            <!-- number column -->
            <div v-else-if="isNumberColumn(asLeaf(child).column)" class="fb__val">
              <DsInput
                size="sm"
                type="number"
                :model-value="String(asLeaf(child).value ?? '')"
                :placeholder="t('views.valuePlaceholder')"
                @update:model-value="(v: string) => setLeafValue(idx, asLeaf(child), v)"
              />
            </div>

            <!-- default text (with regex toggle) -->
            <div v-else class="fb__val fb__val--text" :class="{ 'fb__val--bad': regexBad(asLeaf(child)) }">
              <DsInput
                size="sm"
                :model-value="String(asLeaf(child).value ?? '')"
                :placeholder="regexActive(asLeaf(child)) ? t('views.regexPlaceholder') : t('views.valuePlaceholder')"
                @update:model-value="(v: string) => setLeafValue(idx, asLeaf(child), v)"
              />
              <button
                v-if="canToggleRegex(asLeaf(child))"
                class="fb__regex"
                :class="{ 'fb__regex--on': regexActive(asLeaf(child)), 'fb__regex--bad': regexBad(asLeaf(child)) }"
                type="button"
                :title="regexBad(asLeaf(child)) ? t('views.regexInvalid') : t('views.regexToggle')"
                :aria-pressed="regexActive(asLeaf(child))"
                @click="toggleRegex(idx, asLeaf(child))"
              >.*</button>
            </div>
          </template>
          <span v-else class="fb__val-spacer" />
        </template>

        <button
          class="fb__del"
          type="button"
          :title="t('views.removeRow')"
          aria-label="remove"
          @click="removeChild(idx)"
        >✕</button>
      </li>

      <li v-if="modelValue.children.length === 0" class="fb__empty">
        {{ t('views.emptyGroup') }}
      </li>
    </ul>

    <div class="fb__add">
      <DsButton variant="subtle" size="sm" @click="addCondition">{{ t('views.addCondition') }}</DsButton>
      <DsButton v-if="depth < maxDepth" variant="ghost" size="sm" @click="addGroup">{{ t('views.addGroup') }}</DsButton>
    </div>
  </div>
</template>

<script lang="ts">
export default { name: 'FilterBuilder' };
</script>

<style scoped>
.fb {
  border: var(--bd);
  border-radius: var(--r-md);
  padding: var(--sp-2);
  background: var(--bg);
}
.fb--depth-1,
.fb--depth-2,
.fb--depth-3 {
  background: var(--bg-elev);
}
.fb__head {
  display: flex;
  align-items: center;
  margin-bottom: var(--sp-2);
}
.fb__combi {
  display: inline-flex;
  border: var(--bd);
  border-radius: var(--r-md);
  overflow: hidden;
}
.fb__combi-btn {
  padding: var(--sp-1) var(--sp-3);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  background: transparent;
  border: 0;
  color: var(--text-muted);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.fb__combi-btn:hover:not(.fb__combi-btn--on) {
  background: var(--bg-hover);
  color: var(--text);
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
  gap: var(--sp-1);
}
.fb__row {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}
.fb__row--group {
  align-items: stretch;
}
.fb__row--over {
  outline: 1px dashed var(--accent);
  outline-offset: 1px;
  border-radius: var(--r-sm);
}
.fb__grip {
  cursor: grab;
  color: var(--text-faint);
  font-size: 12px;
  user-select: none;
  flex: 0 0 auto;
  padding: 0 2px;
}
.fb__grip:active {
  cursor: grabbing;
}
.fb__nested {
  flex: 1 1 auto;
  min-width: 0;
}
.fb__sel--field {
  flex: 0 1 128px;
  min-width: 0;
}
.fb__sel--op {
  flex: 0 1 140px;
  min-width: 0;
}
.fb__val {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  gap: var(--sp-1);
}
.fb__val--date .fb__rel {
  flex: 0 0 116px;
}
.fb__val--bad :deep(.ds-input) {
  border-color: var(--danger);
}
.fb__val-spacer {
  flex: 1 1 auto;
}
.fb__regex {
  flex: 0 0 auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  font-weight: 700;
  padding: 0 var(--sp-2);
  border: var(--bd);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--text-muted);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}
.fb__regex:hover {
  border-color: var(--text-faint);
  color: var(--text);
}
.fb__regex--on {
  background: var(--accent);
  color: var(--accent-fg);
  border-color: var(--accent);
}
.fb__regex--bad {
  border-color: var(--danger);
  color: var(--danger);
}
.fb__del {
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  font-size: 11px;
  padding: var(--sp-1);
  border-radius: var(--r-sm);
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.fb__del:hover {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}
.fb__empty {
  font-size: 12px;
  color: var(--text-faint);
  padding: var(--sp-1) var(--sp-2);
}
.fb__add {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
</style>
