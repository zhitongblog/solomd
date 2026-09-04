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
import { computed, nextTick, ref, watch } from 'vue';
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
  setCell,
  emptyTable,
  type TableAlign,
  type TableModel,
} from '../lib/markdown-table';
import { useI18n } from '../i18n';

const props = defineProps<{ source: string }>();
const emit = defineEmits<{
  (e: 'apply', markdown: string): void;
  (e: 'close'): void;
}>();

const { t } = useI18n();

const model = ref<TableModel>(parseTable(props.source) ?? emptyTable());
/** Which column the row/column buttons act on. -1 while the caret is in the
 *  header, which is still a column — the row index is what differs. */
const focused = ref<{ row: number; col: number }>({ row: -1, col: 0 });
const gridEl = ref<HTMLElement | null>(null);

watch(
  () => props.source,
  (next) => {
    model.value = parseTable(next) ?? emptyTable();
    focused.value = { row: -1, col: 0 };
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

function onCellInput(row: number, col: number, e: Event) {
  const value = (e.target as HTMLElement).innerText;
  model.value = setCell(model.value, row, col, value);
}

function focusCell(row: number, col: number) {
  focused.value = { row, col };
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
  model.value = setAlign(model.value, focused.value.col, a);
}

function apply() {
  emit('apply', serializeTable(model.value));
  emit('close');
}

/**
 * Tab moves to the next cell rather than out of the dialog, which is what a
 * grid is expected to do; Escape cancels. Enter inside a cell is swallowed
 * because a newline would split the row across two table lines.
 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) apply();
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
  <div class="tbl__backdrop" @click.self="emit('close')" @keydown="onKeydown">
    <div class="tbl" role="dialog" aria-modal="true">
      <header class="tbl__head">
        <span class="tbl__title">{{ t('tableEditor.heading') }}</span>
        <span class="tbl__size">{{ colCount }} × {{ model.rows.length }}</span>
        <button class="tbl__x" :title="t('tableEditor.cancel')" @click="emit('close')">×</button>
      </header>

      <div class="tbl__toolbar">
        <div class="tbl__group">
          <span class="tbl__grouplabel">{{ t('tableEditor.row') }}</span>
          <button @click="addRowAbove" :title="t('tableEditor.rowAbove')">↑+</button>
          <button @click="addRowBelow" :title="t('tableEditor.rowBelow')">↓+</button>
          <button @click="rowUp" :title="t('tableEditor.rowUp')">⤒</button>
          <button @click="rowDown" :title="t('tableEditor.rowDown')">⤓</button>
          <button class="tbl__danger" @click="removeRow" :title="t('tableEditor.rowDelete')">✕</button>
        </div>
        <div class="tbl__group">
          <span class="tbl__grouplabel">{{ t('tableEditor.column') }}</span>
          <button @click="addColLeft" :title="t('tableEditor.colLeft')">+←</button>
          <button @click="addColRight" :title="t('tableEditor.colRight')">+→</button>
          <button @click="colLeft" :title="t('tableEditor.colMoveLeft')">⇤</button>
          <button @click="colRight" :title="t('tableEditor.colMoveRight')">⇥</button>
          <button class="tbl__danger" @click="removeCol" :title="t('tableEditor.colDelete')">✕</button>
        </div>
        <div class="tbl__group">
          <span class="tbl__grouplabel">{{ t('tableEditor.align') }}</span>
          <button
            v-for="a in ALIGNS"
            :key="String(a.value)"
            :class="{ 'tbl__on': model.aligns[focused.col] === a.value }"
            @click="chooseAlign(a.value)"
          >{{ a.label }}</button>
        </div>
      </div>

      <div class="tbl__gridwrap" ref="gridEl">
        <table class="tbl__grid">
          <thead>
            <tr>
              <th
                v-for="(cell, c) in model.header"
                :key="`h${c}`"
                :class="{ 'tbl__focus': focused.row === -1 && focused.col === c }"
              >
                <div
                  class="tbl__cell"
                  contenteditable="plaintext-only"
                  :data-cell="`-1:${c}`"
                  :style="{ textAlign: model.aligns[c] ?? 'left' }"
                  @focus="focusCell(-1, c)"
                  @input="(e) => onCellInput(-1, c, e)"
                >{{ cell }}</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, r) in model.rows" :key="`r${r}`">
              <td
                v-for="(cell, c) in row"
                :key="`c${r}-${c}`"
                :class="{ 'tbl__focus': focused.row === r && focused.col === c }"
              >
                <div
                  class="tbl__cell"
                  contenteditable="plaintext-only"
                  :data-cell="`${r}:${c}`"
                  :style="{ textAlign: model.aligns[c] ?? 'left' }"
                  @focus="focusCell(r, c)"
                  @input="(e) => onCellInput(r, c, e)"
                >{{ cell }}</div>
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
        <button class="tbl__btn" @click="emit('close')">{{ t('tableEditor.cancel') }}</button>
        <button class="tbl__btn tbl__btn--primary" @click="apply">{{ t('tableEditor.apply') }}</button>
      </footer>
    </div>
  </div>
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
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
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
