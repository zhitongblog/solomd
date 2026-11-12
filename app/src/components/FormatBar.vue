<script setup lang="ts">
/**
 * 5.0 — the formatting toolbar, in the editor column above the text.
 *
 * The half of #296 that the shortcuts and the menus cannot be: the commands
 * you have not learnt yet, and the ones you reach for once a week. Bold,
 * underline, italic, strikethrough | heading, subscript, superscript, quote |
 * list continuation, auto numbering, task list | inline code, code block,
 * link, image, table | undo, redo, format document.
 *
 * Every button goes through a path that already exists, so a button can never
 * do something its shortcut or its menu item does not:
 *   - formatting      → `solomd:format-markdown` (useShortcuts dispatches the
 *                       same event; Editor.vue applies it to whichever of its
 *                       three editors this pane runs)
 *   - insert / format → `solomd:menu-action`, App.vue's menu dispatcher, so
 *                       table, image and Prettier all run by their command id
 *   - undo / redo     → `solomd:editor-history`, the touch bar's channel
 *
 * Two buttons open a panel on hover instead of acting: the heading levels and
 * the table size grid. Everything else is a plain button with a hover tip.
 *
 * Buttons never take focus (`mousedown.prevent` on the root, as the menubar
 * and the touch bar do) — the caret and the selection have to stay where the
 * command will find them. The bar is desktop-only: the phone has KeyboardBar,
 * and the settings switch is hidden there for the same reason.
 */
import { computed, ref } from 'vue';
import Icon from './Icons.vue';
import { useI18n } from '../i18n';
import { useTilesStore } from '../stores/tiles';
import { useSettingsStore } from '../stores/settings';
import { themeFamily } from '../lib/themes';
import {
  INSERT_TABLE_DEFAULT_COLS,
  INSERT_TABLE_DEFAULT_ROWS,
  tableMarkdown,
} from '../lib/insert-table';
import {
  TABLE_GRID_CELLS,
  TABLE_GRID_COLS,
  gridSizeAt,
  inGridSelection,
  type GridSize,
} from '../lib/table-grid';
import { HIGHLIGHT_COLOR_SWATCHES, type FormatKind } from '../lib/md-format';

const { t } = useI18n();
const tiles = useTilesStore();
const settings = useSettingsStore();

function format(kind: FormatKind, color?: string) {
  window.dispatchEvent(new CustomEvent('solomd:format-markdown', { detail: { kind, color } }));
}
function onCustomHighlightInput(e: Event) {
  const val = (e.target as HTMLInputElement).value;
  if (themeFamily(settings.theme) === 'dark') {
    settings.setCustomThemeColors({ customHighlightDark: val });
  } else {
    settings.setCustomThemeColors({ customHighlightLight: val });
  }
}
/** A palette command by id — the same thing its menu item runs. */
function command(id: string) {
  window.dispatchEvent(new CustomEvent('solomd:menu-action', { detail: id }));
}
function history(op: 'undo' | 'redo') {
  window.dispatchEvent(new CustomEvent('solomd:editor-history', { detail: { op } }));
}

// ---- heading panel: the six levels, as the level they produce ----
const headingLevels: FormatKind[] = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

// ---- table panel: a grid you can slide across, plus the visual editor ----
const cells = Array.from({ length: TABLE_GRID_CELLS }, (_, i) => i);
const hover = ref<GridSize | null>(null);
/** Only a press that started on a cell may insert, so releasing a drag that
 *  began somewhere else — or a plain click elsewhere — cannot drop a table. */
const armed = ref(false);
const size = computed(() => hover.value ?? { cols: 1, rows: 1 });

const cellSize = (index: number): GridSize =>
  gridSizeAt(Math.floor(index / TABLE_GRID_COLS), index % TABLE_GRID_COLS);

function pick(index: number) {
  hover.value = cellSize(index);
}
function startPick(index: number) {
  armed.value = true;
  pick(index);
}
function endPick() {
  if (!armed.value) return;
  armed.value = false;
  insertTable();
}
/** Leaving the grid ends a drag that is still held; the highlighted size
 *  stays as the readout, the way the last hovered cell does in Word. */
function leaveGrid() {
  armed.value = false;
}
function insertTable() {
  const { cols, rows } = size.value;
  window.dispatchEvent(
    new CustomEvent('solomd:insert-markdown', {
      detail: { snippet: tableMarkdown(cols, rows), paneId: tiles.focusedPaneId },
    }),
  );
  hover.value = null;
}

interface MermaidTemplate {
  id: string;
  labelZh: string;
  labelEn: string;
  code: string;
  fence?: string;
}

const MERMAID_TEMPLATES: MermaidTemplate[] = [
  {
    id: 'flowchart',
    labelZh: '流程图 (Flowchart)',
    labelEn: 'Flowchart',
    code: 'flowchart TD\n  A[开始] --> B{条件判断}\n  B -->|是| C[执行处理]\n  B -->|否| D[结束]',
  },
  {
    id: 'sequence',
    labelZh: '时序图 (Sequence)',
    labelEn: 'Sequence Diagram',
    code: 'sequenceDiagram\n  Alice->>Bob: 发起请求\n  Bob-->>Alice: 返回响应',
  },
  {
    id: 'gantt',
    labelZh: '甘特图 (Gantt)',
    labelEn: 'Gantt Chart',
    code: 'gantt\n  title 项目计划\n  dateFormat YYYY-MM-DD\n  section 阶段一\n    需求分析 :a1, 2026-01-01, 3d\n    开发实现 :after a1, 5d',
  },
  {
    id: 'class',
    labelZh: '类图 (Class)',
    labelEn: 'Class Diagram',
    code: 'classDiagram\n  class Animal {\n    +String name\n    +eat()\n  }\n  Animal <|-- Duck',
  },
  {
    id: 'state',
    labelZh: '状态图 (State)',
    labelEn: 'State Diagram',
    code: 'stateDiagram-v2\n  [*] --> 待处理\n  待处理 --> 进行中\n  进行中 --> [*]',
  },
  {
    id: 'pie',
    labelZh: '饼图 (Pie)',
    labelEn: 'Pie Chart',
    code: 'pie title 占比分布\n  "类别 A" : 45\n  "类别 B" : 35\n  "类别 C" : 20',
  },
  {
    id: 'mindmap',
    labelZh: '思维导图 (Mindmap)',
    labelEn: 'Mindmap',
    code: 'mindmap\n  root((核心主题))\n    分支一\n      子项 A\n    分支二\n      子项 B',
  },
  {
    id: 'markmap',
    labelZh: 'Markmap 思维导图 (```markmap)',
    labelEn: 'Markmap Mindmap (```markmap)',
    fence: 'markmap',
    code: '# 核心主题\n## 分支一\n- 子节点 A\n- 子节点 B\n## 分支二\n- 子节点 C',
  },
  {
    id: 'whiteboard',
    labelZh: '交互式画板 / 白板 (Whiteboard)',
    labelEn: 'Interactive Whiteboard (tldraw)',
    fence: 'tldraw id="board-1" height="420" width=""',
    code: '{}',
  },
  {
    id: 'excalidraw',
    labelZh: 'Excalidraw 绘图 (```excalidraw)',
    labelEn: 'Excalidraw Diagram (```excalidraw)',
    fence: 'excalidraw',
    code: '{\n  "type": "excalidraw",\n  "version": 2,\n  "elements": [\n    { "id": "box1", "type": "rectangle", "x": 20, "y": 20, "width": 140, "height": 60, "backgroundColor": "#a5d8ff" },\n    { "id": "txt1", "type": "text", "x": 45, "y": 42, "text": "Excalidraw", "fontSize": 16 }\n  ]\n}',
  },
];

function insertMermaidTemplate(tpl: MermaidTemplate) {
  const fence = tpl.fence || 'mermaid';
  const snippet = `\n\`\`\`${fence}\n${tpl.code}\n\`\`\`\n`;
  window.dispatchEvent(
    new CustomEvent('solomd:insert-markdown', {
      detail: { snippet, paneId: tiles.focusedPaneId },
    }),
  );
}
</script>

<template>
  <div
    class="fbar"
    role="toolbar"
    :aria-label="t('formatBar.label')"
    data-format-bar
    @mousedown.prevent
  >
    <!-- bold · underline · italic · strikethrough -->
    <button class="fbar__btn" :title="t('cmd.fmt.bold')" :aria-label="t('cmd.fmt.bold')" @click="format('bold')">
      <Icon name="bold" />
    </button>
    <button
      class="fbar__btn"
      :title="t('cmd.fmt.underline')"
      :aria-label="t('cmd.fmt.underline')"
      @click="format('underline')"
    >
      <Icon name="underline" />
    </button>
    <button class="fbar__btn" :title="t('cmd.fmt.italic')" :aria-label="t('cmd.fmt.italic')" @click="format('italic')">
      <Icon name="italic" />
    </button>
    <button class="fbar__btn" :title="t('cmd.fmt.strike')" :aria-label="t('cmd.fmt.strike')" @click="format('strike')">
      <Icon name="strikethrough" />
    </button>
    <div class="fbar__pop">
      <button
        class="fbar__btn"
        :title="t('cmd.fmt.highlight')"
        :aria-label="t('cmd.fmt.highlight')"
        aria-haspopup="true"
        @click="format('highlight')"
      >
        <Icon name="highlight" />
      </button>
      <div class="fbar__panel">
        <div class="fbar__panel-box fbar__hl-box">
          <div class="fbar__hl-swatches">
            <button
              class="fbar__hl-swatch fbar__hl-swatch--default"
              :title="settings.language === 'zh' ? '默认高亮 (==文字==)' : 'Default highlight (==text==)'"
              @click="format('highlight', '')"
            >
              ==
            </button>
            <button
              v-for="sw in HIGHLIGHT_COLOR_SWATCHES"
              :key="sw.id"
              class="fbar__hl-swatch"
              :style="{ backgroundColor: sw.color }"
              :title="settings.language === 'zh' ? sw.labelZh : sw.labelEn"
              @click="format('highlight', sw.color)"
            />
          </div>
          <label class="fbar__hl-custom" @mousedown.stop>
            <span>{{ settings.language === 'zh' ? '自定义默认高亮色' : 'Custom highlight color' }}</span>
            <input
              type="color"
              :value="themeFamily(settings.theme) === 'dark' ? (settings.customHighlightDark || '#ffd43b') : (settings.customHighlightLight || '#ffd400')"
              @input="onCustomHighlightInput"
            />
          </label>
        </div>
      </div>
    </div>

    <span class="fbar__sep" aria-hidden="true" />

    <!-- heading (levels on hover) · subscript · superscript · quote -->
    <div class="fbar__pop">
      <button
        class="fbar__btn"
        :title="t('formatBar.headingTip')"
        :aria-label="t('formatBar.heading')"
        aria-haspopup="true"
      >
        <Icon name="heading" />
      </button>
      <div class="fbar__panel">
        <div class="fbar__panel-box fbar__panel-box--menu">
          <button
            v-for="level in headingLevels"
            :key="level"
            class="fbar__menu-item"
            :title="t(`cmd.fmt.${level}`)"
            @click="format(level)"
          >
            <span class="fbar__menu-key">{{ level.toUpperCase() }}</span>
            <span class="fbar__menu-text" :class="`fbar__menu-text--${level}`">{{ t(`cmd.fmt.${level}`) }}</span>
          </button>
        </div>
      </div>
    </div>
    <button
      class="fbar__btn"
      :title="t('cmd.fmt.subscript')"
      :aria-label="t('cmd.fmt.subscript')"
      @click="format('subscript')"
    >
      <Icon name="subscript" />
    </button>
    <button
      class="fbar__btn"
      :title="t('cmd.fmt.superscript')"
      :aria-label="t('cmd.fmt.superscript')"
      @click="format('superscript')"
    >
      <Icon name="superscript" />
    </button>
    <button class="fbar__btn" :title="t('cmd.fmt.quote')" :aria-label="t('cmd.fmt.quote')" @click="format('quote')">
      <Icon name="quote" />
    </button>

    <span class="fbar__sep" aria-hidden="true" />

    <!-- unordered list · ordered list · task list -->
    <button
      class="fbar__btn"
      :title="t('cmd.fmt.ul')"
      :aria-label="t('cmd.fmt.ul')"
      @click="format('ul')"
    >
      <Icon name="list-bullet" />
    </button>
    <button
      class="fbar__btn"
      :title="t('cmd.fmt.ol')"
      :aria-label="t('cmd.fmt.ol')"
      @click="format('ol')"
    >
      <Icon name="list-number" />
    </button>
    <button class="fbar__btn" :title="t('cmd.fmt.task')" :aria-label="t('cmd.fmt.task')" @click="format('task')">
      <Icon name="task" />
    </button>

    <span class="fbar__sep" aria-hidden="true" />

    <!-- inline code · code block · link · image · table (grid on hover) -->
    <button class="fbar__btn" :title="t('cmd.fmt.code')" :aria-label="t('cmd.fmt.code')" @click="format('code')">
      <Icon name="code" />
    </button>
    <button
      class="fbar__btn"
      :title="t('cmd.fmt.codeblock')"
      :aria-label="t('cmd.fmt.codeblock')"
      @click="format('codeblock')"
    >
      <Icon name="codeblock" />
    </button>
    <button class="fbar__btn" :title="t('cmd.fmt.link')" :aria-label="t('cmd.fmt.link')" @click="format('link')">
      <Icon name="link" />
    </button>
    <button
      class="fbar__btn"
      :title="t('formatBar.image')"
      :aria-label="t('formatBar.image')"
      @click="command('editor.insertImage')"
    >
      <Icon name="image" />
    </button>
    <button
      class="fbar__btn"
      :title="settings.language === 'zh' ? '插入附件…' : 'Insert attachment…'"
      :aria-label="settings.language === 'zh' ? '插入附件…' : 'Insert attachment…'"
      @click="command('editor.insertAttachment')"
    >
      <Icon name="paperclip" />
    </button>
    <div class="fbar__pop">
      <button
        class="fbar__btn"
        :title="t('formatBar.tableTip')"
        :aria-label="t('formatBar.tableTip')"
        aria-haspopup="true"
        @click="command('insert.table')"
      >
        <Icon name="table" />
      </button>
      <div class="fbar__panel">
        <div class="fbar__panel-box">
          <div class="fbar__grid" @mouseleave="leaveGrid" @mouseup.prevent="endPick">
            <button
              v-for="cell in cells"
              :key="cell"
              class="fbar__cell"
              :class="{
                'fbar__cell--on': inGridSelection(
                  Math.floor(cell / TABLE_GRID_COLS),
                  cell % TABLE_GRID_COLS,
                  hover,
                ),
              }"
              tabindex="-1"
              aria-hidden="true"
              @mouseenter="pick(cell)"
              @mousedown.prevent="startPick(cell)"
            />
          </div>
          <p class="fbar__grid-size">{{ size.cols }} × {{ size.rows }}</p>
          <button
            class="fbar__panel-action"
            :title="t('insertTableDialog.title')"
            @click="command('insert.table')"
          >
            {{
              t('formatBar.tableCustom', {
                cols: INSERT_TABLE_DEFAULT_COLS,
                rows: INSERT_TABLE_DEFAULT_ROWS,
              })
            }}
          </button>
        </div>
      </div>
    </div>
    <!-- #497 — Mermaid diagram template quick picker -->
    <div class="fbar__pop">
      <button
        class="fbar__btn"
        :title="settings.language === 'zh' ? '插入 Mermaid 图表' : 'Insert Mermaid Diagram'"
        :aria-label="settings.language === 'zh' ? '插入 Mermaid 图表' : 'Insert Mermaid Diagram'"
        aria-haspopup="true"
        @click="insertMermaidTemplate(MERMAID_TEMPLATES[0])"
      >
        <Icon name="diagram" />
      </button>
      <div class="fbar__panel">
        <div class="fbar__panel-box fbar__panel-box--menu">
          <button
            v-for="tpl in MERMAID_TEMPLATES"
            :key="tpl.id"
            class="fbar__menu-item"
            :title="settings.language === 'zh' ? tpl.labelZh : tpl.labelEn"
            @click="insertMermaidTemplate(tpl)"
          >
            <span class="fbar__menu-text">
              {{ settings.language === 'zh' ? tpl.labelZh : tpl.labelEn }}
            </span>
          </button>
        </div>
      </div>
    </div>

    <span class="fbar__sep" aria-hidden="true" />

    <!-- undo · redo · format the document (the format.markdown command) -->
    <button class="fbar__btn" :title="t('formatBar.undo')" :aria-label="t('formatBar.undo')" @click="history('undo')">
      <Icon name="undo" />
    </button>
    <button class="fbar__btn" :title="t('formatBar.redo')" :aria-label="t('formatBar.redo')" @click="history('redo')">
      <Icon name="redo" />
    </button>
    <button
      class="fbar__btn"
      :title="t('cmd.format.markdown')"
      :aria-label="t('cmd.format.markdown')"
      @click="command('format.markdown')"
    >
      <Icon name="sparkle" />
    </button>
  </div>
</template>

<style scoped>
.fbar {
  position: relative;
  z-index: var(--z-sticky);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  min-height: 38px;
  padding: 4px var(--sp-2);
  background: var(--bg);
  border-bottom: var(--bd-hair);
  user-select: none;
  -webkit-user-select: none;
}
.fbar__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-2);
  cursor: default;
}
.fbar__btn:hover {
  background: var(--fill-1);
  color: var(--text);
}
.fbar__btn:active,
.fbar__btn--on {
  background: var(--fill-2);
  color: var(--text);
}
.fbar__btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.fbar__sep {
  width: 1px;
  height: 18px;
  margin: 0 var(--sp-2);
  background: var(--hairline);
}

.fbar__pop {
  position: relative;
  display: inline-flex;
}
.fbar__panel {
  position: absolute;
  top: 100%;
  left: 0;
  display: none;
  padding-top: 6px;
}
.fbar__pop:hover .fbar__panel,
.fbar__pop:focus-within .fbar__panel {
  display: block;
}
.fbar__panel-box {
  min-width: 168px;
  padding: var(--sp-2);
  border: var(--bd-hair);
  border-radius: var(--r-md);
  background: var(--bg-pop);
  box-shadow: var(--sh-pop);
}
.fbar__panel-box--menu {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.fbar__menu-item {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  padding: 4px var(--sp-2);
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: default;
}
.fbar__menu-item:hover {
  background: var(--fill-1);
}
.fbar__menu-key {
  flex: none;
  width: 20px;
  color: var(--text-2);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.fbar__menu-text {
  line-height: 1.2;
  white-space: nowrap;
}
.fbar__menu-text--h1 { font-size: 19px; font-weight: 700; }
.fbar__menu-text--h2 { font-size: 17px; font-weight: 700; }
.fbar__menu-text--h3 { font-size: 15px; font-weight: 600; }
.fbar__menu-text--h4 { font-size: 14px; font-weight: 600; }
.fbar__menu-text--h5 { font-size: 13px; font-weight: 600; }
.fbar__menu-text--h6 { font-size: 12px; font-weight: 600; color: var(--text-2); }

.fbar__grid {
  display: grid;
  grid-template-columns: repeat(6, 18px);
  grid-auto-rows: 18px;
  gap: 2px;
}
.fbar__cell {
  width: 18px;
  height: 18px;
  padding: 0;
  border: var(--bd-hair);
  border-radius: 2px;
  background: transparent;
  cursor: default;
}
.fbar__cell--on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.fbar__grid-size {
  margin: var(--sp-2) 0 0;
  color: var(--text-2);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.fbar__panel-action {
  display: block;
  width: 100%;
  margin-top: var(--sp-1);
  padding: 4px var(--sp-2);
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text);
  font-size: 12px;
  text-align: left;
  cursor: default;
}
.fbar__panel-action:hover {
  background: var(--fill-1);
}
.fbar__hl-box {
  min-width: 196px;
}
.fbar__hl-swatches {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.fbar__hl-swatch {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid rgba(0, 0, 0, 0.14);
  border-radius: 4px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: #1f2328;
  transition: transform 0.1s ease, box-shadow 0.1s ease;
}
.fbar__hl-swatch:hover {
  transform: scale(1.1);
  box-shadow: 0 0 0 2px var(--accent);
}
.fbar__hl-swatch--default {
  background: var(--mark-bg, rgba(255, 212, 0, 0.52));
  color: var(--text);
}
.fbar__hl-custom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  padding-top: 6px;
  border-top: var(--bd-hair);
  font-size: 11px;
  color: var(--text-2);
  cursor: pointer;
}
.fbar__hl-custom input[type="color"] {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
}
</style>
