<script setup lang="ts">
/**
 * Grid editor for a Markdown table.
 *
 * Editing a table as text is the point where people give up on Markdown:
 * adding a column means retyping every row, and one missing `|` turns the
 * table back into a paragraph without saying so. This edits it as a grid and
 * writes well-formed, column-aligned Markdown back.
 *
 * Nothing reaches the document until Apply — the session's `apply` closure is
 * the only write path, and Cancel simply drops the working copy.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  parseTable,
  serializeTable,
  insertRow,
  deleteRow,
  moveRow,
  insertColumn,
  deleteColumn,
  moveColumn,
  setAlign,
  setAlignMany,
  setCell,
  emptyTable,
  type TableAlign,
  type TableModel,
} from '../lib/markdown-table';
import { useI18n } from '../i18n';
import { DsModal, DsButton } from '../ui';

const props = defineProps<{ source: string }>();
const emit = defineEmits<{
  (e: 'apply', markdown: string): void;
  (e: 'close'): void;
}>();

const { t } = useI18n();

const model = ref<TableModel>(parseTable(props.source) ?? emptyTable());
const initialTable = ref(serializeTable(model.value));
const closeConfirm = ref(false);
const dirty = computed(() => serializeTable(model.value) !== initialTable.value);

function requestClose() {
  if (dirty.value) closeConfirm.value = true;
  else emit('close');
}
onMounted(() => window.addEventListener('solomd:table-close-request', requestClose));
onBeforeUnmount(() => window.removeEventListener('solomd:table-close-request', requestClose));
/** Which column the row/column buttons act on. -1 while the caret is in the
 *  header, which is still a column — the row index is what differs. */
const focused = ref<{ row: number; col: number }>({ row: -1, col: 0 });
/** #382 — multi-column selection for batch alignment (Click, Shift+Click, Cmd/Ctrl+Click, or Select All). */
const selectedCols = ref<number[]>([0]);
const gridEl = ref<HTMLElement | null>(null);

watch(
  () => props.source,
  (next) => {
    model.value = parseTable(next) ?? emptyTable();
    initialTable.value = serializeTable(model.value);
    closeConfirm.value = false;
    focused.value = { row: -1, col: 0 };
    selectedCols.value = [0];
  },
);

const preview = computed(() => serializeTable(model.value));
const colCount = computed(() => model.value.header.length);

const ALIGNS: Array<{ value: TableAlign; label: string }> = [
  { value: null, label: '─' },
  { value: 'left', label: '⟵' },
  { value: 'center', label: '↔' },
  { value: 'right', label: '⟶' },
];

/** What a cell holds, as the model stores it. Chromium reports a trailing
 *  line break for an editable block that is (or just was) empty, and the model
 *  turns line breaks into spaces — so without trimming it, "a" read back as
 *  "a ", never matched the model, and every keystroke rewrote the cell. */
function cellText(el: HTMLElement): string {
  return el.innerText.replace(/\n$/, '').replace(/\r?\n/g, ' ');
}

function onCellInput(row: number, col: number, e: Event) {
  model.value = setCell(model.value, row, col, cellText(e.target as HTMLElement));
}

/**
 * #319 — a cell's text is written by this directive, not by `{{ cell }}`.
 * Interpolation re-rendered the cell on every keystroke; rewriting the text
 * node of the element being typed in puts the caret back at the start, so
 * "abc" came out as "cba". Write only when the cell shows something other
 * than the model — a structural change (row/column inserted, moved or
 * deleted) — never while it already agrees.
 */
const vCellText = {
  mounted(el: HTMLElement, binding: { value: string }) {
    el.textContent = binding.value ?? '';
  },
  updated(el: HTMLElement, binding: { value: string }) {
    const next = binding.value ?? '';
    if (cellText(el) !== next) el.textContent = next;
  },
};

function focusCell(row: number, col: number) {
  focused.value = { row, col };
  if (!selectedCols.value.includes(col)) {
    selectedCols.value = [col];
  }
}

/** #382 — Click / Shift+Click / Ctrl(Cmd)+Click on a column header chip selects one or multiple columns. */
function onSelectColumnHeader(col: number, e: MouseEvent) {
  e.preventDefault();
  if (e.shiftKey) {
    const anchor = focused.value.col;
    const lo = Math.min(anchor, col);
    const hi = Math.max(anchor, col);
    const range: number[] = [];
    for (let i = lo; i <= hi; i++) range.push(i);
    selectedCols.value = range;
  } else if (e.metaKey || e.ctrlKey) {
    if (selectedCols.value.includes(col)) {
      if (selectedCols.value.length > 1) {
        selectedCols.value = selectedCols.value.filter((c) => c !== col);
      }
    } else {
      selectedCols.value = [...selectedCols.value, col].sort((a, b) => a - b);
    }
    focused.value = { row: focused.value.row, col };
  } else {
    selectedCols.value = [col];
    focused.value = { row: focused.value.row, col };
  }
}

function toggleSelectAllCols() {
  const all = Array.from({ length: colCount.value }, (_, i) => i);
  if (selectedCols.value.length === colCount.value) {
    selectedCols.value = [focused.value.col];
  } else {
    selectedCols.value = all;
  }
}

const activeAlignCols = computed<number[]>(() => {
  const valid = selectedCols.value.filter((c) => c >= 0 && c < colCount.value);
  return valid.length > 0 ? valid : [focused.value.col];
});

function isAlignActive(a: TableAlign): boolean {
  const cols = activeAlignCols.value;
  return cols.length > 0 && cols.every((c) => (model.value.aligns[c] ?? null) === a);
}

/** Restore focus into the grid after a structural change, so the keyboard
 *  does not get dropped back to the page on every button press. */
async function refocus(row: number, col: number) {
  focused.value = { row, col };
  await nextTick();
  const sel = `[data-cell="${row}:${col}"]`;
  (gridEl.value?.querySelector(sel) as HTMLElement | null)?.focus();
}

function addRowBelow() {
  const at = focused.value.row + 1;
  model.value = insertRow(model.value, at);
  void refocus(at, focused.value.col);
}
function addRowAbove() {
  const at = Math.max(0, focused.value.row);
  model.value = insertRow(model.value, at);
  void refocus(at, focused.value.col);
}
function removeRow() {
  if (focused.value.row < 0) return;
  const at = focused.value.row;
  model.value = deleteRow(model.value, at);
  void refocus(Math.min(at, model.value.rows.length - 1), focused.value.col);
}
function rowUp() {
  const at = focused.value.row;
  if (at <= 0) return;
  model.value = moveRow(model.value, at, at - 1);
  void refocus(at - 1, focused.value.col);
}
function rowDown() {
  const at = focused.value.row;
  if (at < 0 || at >= model.value.rows.length - 1) return;
  model.value = moveRow(model.value, at, at + 1);
  void refocus(at + 1, focused.value.col);
}

function addColRight() {
  const at = focused.value.col + 1;
  model.value = insertColumn(model.value, at);
  void refocus(focused.value.row, at);
}
function addColLeft() {
  const at = focused.value.col;
  model.value = insertColumn(model.value, at);
  void refocus(focused.value.row, at);
}
function removeCol() {
  const at = focused.value.col;
  model.value = deleteColumn(model.value, at);
  void refocus(focused.value.row, Math.min(at, model.value.header.length - 1));
}
function colLeft() {
  const at = focused.value.col;
  if (at <= 0) return;
  model.value = moveColumn(model.value, at, at - 1);
  void refocus(focused.value.row, at - 1);
}
function colRight() {
  const at = focused.value.col;
  if (at >= model.value.header.length - 1) return;
  model.value = moveColumn(model.value, at, at + 1);
  void refocus(focused.value.row, at + 1);
}
function chooseAlign(a: TableAlign) {
  syncDomCellsToModel();
  const cols = activeAlignCols.value;
  model.value = cols.length > 1
    ? setAlignMany(model.value, cols, a)
    : setAlign(model.value, cols[0] ?? focused.value.col, a);
}

/** #387 — Quickly resize the table to targetCols × targetRows via direct numeric input. */
function setColCount(raw: Event) {
  syncDomCellsToModel();
  const target = Math.max(1, Math.min(20, Math.round(Number((raw.target as HTMLInputElement).value) || colCount.value)));
  let m = model.value;
  while (m.header.length < target) m = insertColumn(m, m.header.length);
  while (m.header.length > target && m.header.length > 1) m = deleteColumn(m, m.header.length - 1);
  model.value = m;
  focused.value = { row: focused.value.row, col: Math.min(focused.value.col, m.header.length - 1) };
}
function setRowCount(raw: Event) {
  syncDomCellsToModel();
  const target = Math.max(1, Math.min(200, Math.round(Number((raw.target as HTMLInputElement).value) || model.value.rows.length)));
  let m = model.value;
  while (m.rows.length < target) m = insertRow(m, m.rows.length);
  while (m.rows.length > target && m.rows.length > 1) m = deleteRow(m, m.rows.length - 1);
  model.value = m;
  focused.value = { row: Math.min(focused.value.row, m.rows.length - 1), col: focused.value.col };
}

function syncDomCellsToModel() {
  const root = gridEl.value;
  if (!root) return;
  const cells = root.querySelectorAll<HTMLElement>('[data-cell]');
  cells.forEach((el) => {
    const key = el.getAttribute('data-cell');
    if (!key) return;
    const [rStr, cStr] = key.split(':');
    const r = Number(rStr);
    const c = Number(cStr);
    if (!Number.isFinite(r) || !Number.isFinite(c)) return;
    const text = cellText(el);
    if (r === -1) {
      if (model.value.header[c] !== undefined && model.value.header[c] !== text) {
        model.value = setCell(model.value, -1, c, text);
      }
    } else if (model.value.rows[r]?.[c] !== undefined && model.value.rows[r][c] !== text) {
      model.value = setCell(model.value, r, c, text);
    }
  });
}

function apply() {
  syncDomCellsToModel();
  emit('apply', serializeTable(model.value));
  emit('close');
}

/**
 * Tab moves to the next cell rather than out of the dialog, which is what a
 * grid is expected to do; Escape / close-tab request a guarded close. Enter inside a cell is swallowed
 * because a newline would split the row across two table lines.
 */
function onKeydown(e: KeyboardEvent) {
  if (closeConfirm.value || e.isComposing) return;
  if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'w')) {
    e.preventDefault();
    e.stopPropagation();
    requestClose();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    if ((e.target as HTMLElement | null)?.tagName === 'INPUT') {
      (e.target as HTMLElement).blur();
      return;
    }
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) apply();
    return;
  }
  // #383 — keyboard shortcuts for inserting rows/columns inside the table editor.
  if (e.key === 'Insert') {
    e.preventDefault();
    syncDomCellsToModel();
    if ((e.ctrlKey || e.metaKey) && e.altKey) addColLeft();
    else if (e.ctrlKey || e.metaKey) addColRight();
    else if (e.altKey) addRowAbove();
    else addRowBelow();
    return;
  }
  if (e.key !== 'Tab') return;
  const { row, col } = focused.value;
  e.preventDefault();
  const cols = colCount.value;
  let flat = (row + 1) * cols + col + (e.shiftKey ? -1 : 1);
  const total = (model.value.rows.length + 1) * cols;
  flat = ((flat % total) + total) % total;
  void refocus(Math.floor(flat / cols) - 1, flat % cols);
}
</script>

<template>
  <div class="tbl__backdrop" @keydown="onKeydown">
    <div class="tbl" role="dialog" aria-modal="true" :inert="closeConfirm">
      <header class="tbl__head">
        <span class="tbl__title">{{ t('tableEditor.heading') }}</span>
        <span class="tbl__size">
          <input
            class="tbl__size-input"
            type="number"
            min="1"
            max="20"
            :value="colCount"
            :title="t('tableEditor.column')"
            @change="setColCount"
          />
          <span>×</span>
          <input
            class="tbl__size-input"
            type="number"
            min="1"
            max="200"
            :value="model.rows.length"
            :title="t('tableEditor.row')"
            @change="setRowCount"
          />
        </span>
        <button class="tbl__x" :title="t('tableEditor.cancel')" @click="requestClose">×</button>
      </header>

      <div class="tbl__toolbar">
        <div class="tbl__group">
          <span class="tbl__grouplabel">{{ t('tableEditor.row') }}</span>
          <button @click="addRowAbove" :title="`${t('tableEditor.rowAbove')} (Alt+Insert)`">↑+</button>
          <button @click="addRowBelow" :title="`${t('tableEditor.rowBelow')} (Insert)`">↓+</button>
          <button @click="rowUp" :title="t('tableEditor.rowUp')">⤒</button>
          <button @click="rowDown" :title="t('tableEditor.rowDown')">⤓</button>
          <button class="tbl__danger" @click="removeRow" :title="t('tableEditor.rowDelete')">✕</button>
        </div>
        <div class="tbl__group">
          <span class="tbl__grouplabel">{{ t('tableEditor.column') }}</span>
          <button @click="addColLeft" :title="`${t('tableEditor.colLeft')} (Ctrl+Alt+Insert)`">+←</button>
          <button @click="addColRight" :title="`${t('tableEditor.colRight')} (Ctrl+Insert)`">+→</button>
          <button @click="colLeft" :title="t('tableEditor.colMoveLeft')">⇤</button>
          <button @click="colRight" :title="t('tableEditor.colMoveRight')">⇥</button>
          <button class="tbl__danger" @click="removeCol" :title="t('tableEditor.colDelete')">✕</button>
        </div>
        <div class="tbl__group">
          <span class="tbl__grouplabel">{{ t('tableEditor.align') }}</span>
          <button
            type="button"
            class="tbl__select-all-cols"
            :class="{ 'tbl__on': selectedCols.length === colCount && colCount > 1 }"
            :title="t('tableEditor.selectAllCols') !== 'tableEditor.selectAllCols' ? t('tableEditor.selectAllCols') : '全选所有列 (Shift/Ctrl+点击列头可多选)'"
            @click="toggleSelectAllCols"
          >∀</button>
          <button
            v-for="a in ALIGNS"
            :key="String(a.value)"
            :class="{ 'tbl__on': isAlignActive(a.value) }"
            @click="chooseAlign(a.value)"
          >{{ a.label }}</button>
        </div>
      </div>

      <div class="tbl__gridwrap" ref="gridEl">
        <table class="tbl__grid">
          <thead>
            <tr class="tbl__colbar">
              <th
                v-for="(_, c) in model.header"
                :key="`colbar-${c}`"
                class="tbl__colbar-th"
                :class="{ 'tbl__colbar-th--selected': activeAlignCols.includes(c) }"
                :title="'点击选列，Shift+点击连选，Ctrl/⌘+点击多选'"
                @mousedown="onSelectColumnHeader(c, $event)"
              >
                <span class="tbl__colbar-label">{{ c + 1 }}</span>
                <span class="tbl__colbar-align">{{
                  model.aligns[c] === 'left'
                    ? '⟵'
                    : model.aligns[c] === 'center'
                      ? '↔'
                      : model.aligns[c] === 'right'
                        ? '⟶'
                        : '─'
                }}</span>
              </th>
            </tr>
            <tr>
              <th
                v-for="(cell, c) in model.header"
                :key="`h${c}`"
                :class="{
                  'tbl__focus': focused.row === -1 && focused.col === c,
                  'tbl__col-selected': activeAlignCols.length > 1 && activeAlignCols.includes(c),
                }"
              >
                <div
                  class="tbl__cell"
                  contenteditable="plaintext-only"
                  :data-cell="`-1:${c}`"
                  :style="{ textAlign: model.aligns[c] ?? 'left' }"
                  @focus="focusCell(-1, c)"
                  @input="(e) => onCellInput(-1, c, e)"
                  v-cell-text="cell"
                ></div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, r) in model.rows" :key="`r${r}`">
              <td
                v-for="(cell, c) in row"
                :key="`c${r}-${c}`"
                :class="{
                  'tbl__focus': focused.row === r && focused.col === c,
                  'tbl__col-selected': activeAlignCols.length > 1 && activeAlignCols.includes(c),
                }"
              >
                <div
                  class="tbl__cell"
                  contenteditable="plaintext-only"
                  :data-cell="`${r}:${c}`"
                  :style="{ textAlign: model.aligns[c] ?? 'left' }"
                  @focus="focusCell(r, c)"
                  @input="(e) => onCellInput(r, c, e)"
                  v-cell-text="cell"
                ></div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <details class="tbl__preview">
        <summary>{{ t('tableEditor.preview') }}</summary>
        <pre>{{ preview }}</pre>
      </details>

      <footer class="tbl__foot">
        <span class="tbl__hint">{{ t('tableEditor.hint') }}</span>
        <button class="tbl__btn" @click="requestClose">{{ t('tableEditor.cancel') }}</button>
        <button class="tbl__btn tbl__btn--primary" @click="apply">{{ t('tableEditor.apply') }}</button>
      </footer>
    </div>
  </div>
  <DsModal
    v-model="closeConfirm"
    class="tbl__close-confirm"
    style="z-index: 2200"
    :title="t('unsaved.title')"
    width="400px"
    :close-on-backdrop="false"
  >
    <p>{{ t('unsaved.message', { file: t('tableEditor.heading') }) }}</p>
    <template #footer>
      <DsButton data-table-close="cancel" variant="secondary" data-autofocus @click="closeConfirm = false">{{ t('unsaved.cancel') }}</DsButton>
      <DsButton data-table-close="discard" variant="danger" @click="emit('close')">{{ t('unsaved.dontSave') }}</DsButton>
      <DsButton data-table-close="apply" variant="primary" @click="apply">{{ t('tableEditor.apply') }}</DsButton>
    </template>
  </DsModal>
</template>

<style scoped>
.tbl__backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2100;
}
.tbl {
  display: flex;
  flex-direction: column;
  width: min(880px, 92vw);
  max-height: 86vh;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  overflow: hidden;
}
.tbl__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.tbl__title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  flex: 1;
}
.tbl__size {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.tbl__size-input {
  width: 44px;
  height: 22px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-elev);
  color: var(--text);
  font: inherit;
  font-size: 11px;
  text-align: center;
  outline: none;
}
.tbl__size-input:focus {
  border-color: var(--accent, #ff9f40);
}
.tbl__x {
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.tbl__toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
.tbl__group {
  display: flex;
  align-items: center;
  gap: 4px;
}
.tbl__grouplabel {
  font-size: 11px;
  color: var(--text-faint);
  margin-right: 2px;
}
.tbl__group button {
  min-width: 28px;
  padding: 3px 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-muted);
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
}
.tbl__group button:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.tbl__group button.tbl__on {
  border-color: var(--accent, #ff9f40);
  color: var(--accent, #ff9f40);
}
.tbl__danger:hover {
  color: var(--danger, #d64545) !important;
  border-color: var(--danger, #d64545);
}
.tbl__gridwrap {
  flex: 1;
  overflow: auto;
  padding: 10px 14px;
}
.tbl__grid {
  border-collapse: collapse;
  width: 100%;
  font-size: 13px;
}
.tbl__grid th,
.tbl__grid td {
  border: 1px solid var(--border);
  padding: 0;
  vertical-align: top;
}
.tbl__grid th {
  background: var(--bg-elev);
  font-weight: 600;
}
.tbl__colbar-th {
  padding: 2px 6px !important;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
  text-align: center;
  background: color-mix(in srgb, var(--bg-elev) 75%, var(--bg)) !important;
}
.tbl__colbar-th:hover {
  color: var(--text);
  background: var(--bg-hover) !important;
}
.tbl__colbar-th--selected {
  color: var(--accent, #ff9f40);
  background: color-mix(in srgb, var(--accent, #ff9f40) 14%, var(--bg-elev)) !important;
}
.tbl__colbar-label {
  margin-right: 4px;
}
.tbl__colbar-align {
  opacity: 0.75;
}
.tbl__col-selected {
  background: color-mix(in srgb, var(--accent, #ff9f40) 8%, transparent) !important;
}
.tbl__focus {
  outline: 2px solid var(--accent, #ff9f40);
  outline-offset: -2px;
}
.tbl__cell {
  min-width: 80px;
  min-height: 1.6em;
  padding: 6px 8px;
  outline: none;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.tbl__preview {
  border-top: 1px solid var(--border);
  padding: 6px 14px;
  font-size: 11px;
  color: var(--text-muted);
}
.tbl__preview pre {
  margin: 6px 0 0;
  padding: 8px;
  background: var(--bg-elev);
  border-radius: 6px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
}
.tbl__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}
.tbl__hint {
  flex: 1;
  font-size: 11px;
  color: var(--text-faint);
}
.tbl__btn {
  padding: 5px 14px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}
.tbl__btn--primary {
  background: var(--accent, #ff9f40);
  border-color: var(--accent, #ff9f40);
  color: var(--accent-fg, #1a1a1a);
  font-weight: 600;
}
</style>
