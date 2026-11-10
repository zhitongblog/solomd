<script setup lang="ts">
/**
 * #500 — "Insert Table" dialog with both:
 *   1. Interactive 8×8 visual hover grid (click any cell to insert immediately).
 *   2. Direct Rows × Columns numeric inputs (supports up to 50×20, Enter confirms).
 */
import { ref, watch, nextTick, computed } from 'vue';
import { DsModal, DsButton } from '../ui';
import { useI18n } from '../i18n';
import { useSettingsStore } from '../stores/settings';
import type { TableAlign } from '../lib/markdown-table';

const { t } = useI18n();
const settings = useSettingsStore();

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: 'confirm', rows: number, cols: number, align: TableAlign): void;
  (e: 'cancel'): void;
}>();

const GRID_MAX_ROWS = 8;
const GRID_MAX_COLS = 8;

const rows = ref(3);
const cols = ref(3);
const align = ref<TableAlign>(null);
const hoverRow = ref<number | null>(null);
const hoverCol = ref<number | null>(null);
const rowsInputRef = ref<HTMLInputElement | null>(null);

const isZh = computed(() => settings.language === 'zh');

const alignOptions = computed<Array<{ value: TableAlign; label: string; icon: string }>>(() => [
  { value: null, label: isZh.value ? '默认' : 'Default', icon: '─' },
  { value: 'left', label: isZh.value ? '左对齐' : 'Left', icon: '⟵' },
  { value: 'center', label: isZh.value ? '居中' : 'Center', icon: '↔' },
  { value: 'right', label: isZh.value ? '右对齐' : 'Right', icon: '⟶' },
]);

const activeGridRows = computed(() => hoverRow.value ?? Math.min(GRID_MAX_ROWS, Math.max(1, rows.value)));
const activeGridCols = computed(() => hoverCol.value ?? Math.min(GRID_MAX_COLS, Math.max(1, cols.value)));

watch(
  () => props.open,
  (o) => {
    if (o) {
      rows.value = 3;
      cols.value = 3;
      align.value = null;
      hoverRow.value = null;
      hoverCol.value = null;
      nextTick(() => {
        rowsInputRef.value?.focus();
        rowsInputRef.value?.select();
      });
    }
  },
);

function clampRows(v: number): number {
  if (!Number.isFinite(v)) return 3;
  return Math.max(1, Math.min(50, Math.round(v)));
}

function clampCols(v: number): number {
  if (!Number.isFinite(v)) return 3;
  return Math.max(1, Math.min(20, Math.round(v)));
}

function onGridHover(r: number, c: number) {
  hoverRow.value = r;
  hoverCol.value = c;
  rows.value = r;
  cols.value = c;
}

function onGridLeave() {
  hoverRow.value = null;
  hoverCol.value = null;
}

function onGridClick(r: number, c: number) {
  emit('confirm', clampRows(r), clampCols(c), align.value);
}

function onConfirm() {
  emit('confirm', clampRows(rows.value), clampCols(cols.value), align.value);
}
</script>

<template>
  <DsModal
    :model-value="open"
    :title="t('toolbar.insertTable')"
    width="340px"
    @update:model-value="emit('cancel')"
  >
    <div class="itd-body">
      <div class="itd-grid-header">
        <span class="itd-grid-hint">{{ isZh ? '点选网格或直接输入行列数' : 'Click grid or enter dimensions' }}</span>
        <span class="itd-grid-badge">{{ clampRows(rows) }} × {{ clampCols(cols) }}</span>
      </div>

      <div
        class="itd-grid"
        role="grid"
        :aria-label="t('toolbar.insertTable')"
        @mouseleave="onGridLeave"
      >
        <div
          v-for="r in GRID_MAX_ROWS"
          :key="'r-' + r"
          class="itd-grid__row"
          role="row"
        >
          <button
            v-for="c in GRID_MAX_COLS"
            :key="'c-' + c"
            type="button"
            class="itd-grid__cell"
            :class="{
              'itd-grid__cell--active': r <= activeGridRows && c <= activeGridCols,
              'itd-grid__cell--header': r === 1 && r <= activeGridRows && c <= activeGridCols,
            }"
            :title="`${r} × ${c}`"
            @mouseenter="onGridHover(r, c)"
            @click="onGridClick(r, c)"
          />
        </div>
      </div>

      <div class="itd-inputs">
        <label class="itd-field">
          <span class="itd-field__label">{{ isZh ? '行数（含表头）' : 'Rows (incl. header)' }}</span>
          <input
            ref="rowsInputRef"
            v-model.number="rows"
            type="number"
            min="1"
            max="50"
            class="itd-field__input"
            @keydown.enter.prevent="onConfirm"
          />
        </label>
        <span class="itd-inputs__sep">×</span>
        <label class="itd-field">
          <span class="itd-field__label">{{ isZh ? '列数' : 'Columns' }}</span>
          <input
            v-model.number="cols"
            type="number"
            min="1"
            max="20"
            class="itd-field__input"
            @keydown.enter.prevent="onConfirm"
          />
        </label>
      </div>

      <div class="itd-align">
        <span class="itd-field__label">{{ isZh ? '对齐方式' : 'Alignment' }}</span>
        <div class="itd-align__seg" role="radiogroup" :aria-label="isZh ? '对齐方式' : 'Alignment'">
          <button
            v-for="opt in alignOptions"
            :key="String(opt.value)"
            type="button"
            role="radio"
            class="itd-align__btn"
            :class="{ 'itd-align__btn--active': align === opt.value }"
            :aria-checked="align === opt.value"
            :data-align="opt.value ?? 'default'"
            @click="align = opt.value"
          >
            <span class="itd-align__icon">{{ opt.icon }}</span>
            <span>{{ opt.label }}</span>
          </button>
        </div>
      </div>
    </div>

    <template #footer>
      <DsButton variant="secondary" @click="emit('cancel')">
        {{ isZh ? '取消' : 'Cancel' }}
      </DsButton>
      <DsButton variant="primary" class="insert-table-dlg__btn--primary" @click="onConfirm">
        {{ isZh ? '插入表格' : 'Insert Table' }}
      </DsButton>
    </template>
  </DsModal>
</template>

<style scoped>
.itd-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.itd-grid-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
}
.itd-grid-hint {
  color: var(--text-2);
}
.itd-grid-badge {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--accent-text, var(--accent));
  background: var(--accent-soft);
  padding: 2px 8px;
  border-radius: var(--r-sm, 4px);
}
.itd-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-self: center;
  padding: 10px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--r-md, 8px);
}
.itd-grid__row {
  display: flex;
  gap: 4px;
}
.itd-grid__cell {
  width: 24px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg);
  cursor: pointer;
  transition: background 0.08s ease, border-color 0.08s ease, transform 0.08s ease;
}
.itd-grid__cell--active {
  background: color-mix(in srgb, var(--accent) 22%, var(--bg));
  border-color: var(--accent);
}
.itd-grid__cell--header {
  background: color-mix(in srgb, var(--accent) 42%, var(--bg));
}
.itd-grid__cell:hover {
  transform: scale(1.06);
}
.itd-inputs {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.itd-field {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.itd-field__label {
  font-size: 12px;
  color: var(--text-2);
  font-weight: 500;
}
.itd-field__input {
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm, 6px);
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  font-family: var(--font-mono);
  outline: none;
}
.itd-field__input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.itd-inputs__sep {
  padding-bottom: 6px;
  color: var(--text-3);
  font-weight: 600;
}
.itd-align {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.itd-align__seg {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  padding: 3px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--r-sm, 6px);
}
.itd-align__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.1s ease, color 0.1s ease, border-color 0.1s ease;
}
.itd-align__btn:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.itd-align__btn--active {
  background: var(--bg);
  color: var(--accent-text, var(--accent));
  border-color: var(--accent);
  font-weight: 600;
}
.itd-align__icon {
  font-family: var(--font-mono);
  font-size: 11px;
}
</style>
