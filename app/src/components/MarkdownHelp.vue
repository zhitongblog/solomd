<script setup lang="ts">
import { useAppMenu } from '../composables/useAppMenu';
import { computed, ref, watch } from 'vue';
import { activeKeyActions, combosFor, KEY_CATEGORIES, filterKeyActions, formatCombo, type KeyActionDef } from '../lib/keybindings';
import { useI18n } from '../i18n';
import { isMacOS } from '../lib/platform';
import { useSettingsStore } from '../stores/settings';
import { DsModal, DsTabs, DsInput } from '../ui';

type Tab = 'syntax' | 'shortcuts' | 'cli';
// `tab` picks the tab each time the panel opens (Help menu: one row per tab).
const props = defineProps<{ open: boolean; tab?: Tab }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const activeTab = ref<Tab>(props.tab ?? 'syntax');
watch(
  () => props.open,
  (open) => {
    if (open && props.tab) activeTab.value = props.tab;
  },
);
const query = ref('');
const today = new Date().toISOString().slice(0, 10);
const cliExampleNew = `solomd new "daily-${today}" "今日待办："`;

interface Shortcut {
  keys: string;
  zh: string;
  en: string;
}
const macChord = isMacOS();
const kbSettings = useSettingsStore();

/**
 * The shortcuts tab is generated from the binding table, not written by hand.
 * The hand-written list below went stale the way every such list does — it
 * was missing a third of the commands, and the welcome note that mirrored it
 * told new users the wrong key for the command palette. Only rows that are
 * NOT bindable actions (⌘-click a wikilink, Tab in a table) still come from
 * the literal list, because there is no table to read them from.
 */
const { t } = useI18n();
const helpTabs = computed(() => [
  { value: 'syntax', label: 'Markdown 语法' },
  { value: 'shortcuts', label: t('menubar.helpShortcuts') },
  { value: 'cli', label: 'CLI' },
]);
const appMenu = useAppMenu();
const shortcutName = computed(() => appMenu.shortcutNamer());
function actionName(a: KeyActionDef): string {
  return shortcutName.value(a.id, a.label);
}
const CATEGORY_ORDER = KEY_CATEGORIES;
const liveGroups = computed(() => {
  const hits = filterKeyActions(activeKeyActions(), query.value, actionName, kbSettings.keybindings, macChord);
  return CATEGORY_ORDER.map((cat) => ({
    cat,
    title: t('settings.keysCat' + cat.charAt(0).toUpperCase() + cat.slice(1)),
    items: hits.filter((a) => a.category === cat),
  })).filter((g) => g.items.length);
});
function liveKeys(a: KeyActionDef): string {
  const combos = combosFor(a.id, kbSettings.keybindings);
  return combos.length ? combos.map((c) => formatCombo(c, macChord)).join(' / ') : '—';
}
const builtinRows = computed(() => {
  const q = query.value.trim().toLowerCase();
  return BUILTIN_KEYS
    .filter((it) => !q || `${it.keys} ${it.zh} ${it.en}`.toLowerCase().includes(q));
});
function changeShortcuts(): void {
  emit('close');
  window.dispatchEvent(new CustomEvent('solomd:open-settings', { detail: { section: 'keys' } }));
}

/** Keys that are not bindable actions, so no table knows about them. */
const BUILTIN_KEYS: Shortcut[] = [
  { keys: 'Cmd/Ctrl + click [[link]]', zh: '跳转到双链目标', en: 'Open the target of a [[wikilink]]' },
  { keys: 'Tab', zh: '增加缩进 / 跨表格列', en: 'Indent / table column nav' },
  { keys: 'Shift+Tab', zh: '减少缩进', en: 'Outdent' },
];

interface Item {
  /** Bilingual category label, e.g. "标题 / Headings" */
  category: string;
  syntax: string;
  example: string;
  /** Chinese description */
  zh: string;
  /** English description */
  en: string;
}

const C = {
  headings: '标题 / Headings',
  emphasis: '强调 / Emphasis',
  lists: '列表 / Lists',
  links: '链接与图片 / Links & Images',
  code: '代码 / Code',
  quotes: '引用 / Quotes',
  tables: '表格 / Tables',
  math: '数学公式 / Math (KaTeX)',
  diagrams: '图表 / Diagrams',
  extras: '扩展语法 / Extras',
  other: '其他 / Other',
};

const items: Item[] = [
  // Headings
  {
    category: C.headings,
    syntax: '# Heading',
    example: '# H1\n## H2\n### H3',
    zh: '一到六级标题，# 的数量决定级别',
    en: 'Headings 1–6, the number of # is the level',
  },

  // Emphasis
  {
    category: C.emphasis,
    syntax: '**bold**',
    example: '**bold text**',
    zh: '加粗文字',
    en: 'Bold text',
  },
  {
    category: C.emphasis,
    syntax: '*italic*',
    example: '*italic text*',
    zh: '斜体文字',
    en: 'Italic text',
  },
  {
    category: C.emphasis,
    syntax: '~~strike~~',
    example: '~~deleted~~',
    zh: '删除线',
    en: 'Strikethrough',
  },
  {
    category: C.emphasis,
    syntax: '`code`',
    example: '`inline code`',
    zh: '行内代码',
    en: 'Inline code',
  },
  {
    category: C.emphasis,
    syntax: '==mark==',
    example: '==highlighted==',
    zh: '高亮（GFM 扩展）',
    en: 'Highlight (GFM extension)',
  },

  // Lists
  {
    category: C.lists,
    syntax: '- item',
    example: '- Apple\n- Banana\n- Cherry',
    zh: '无序列表（- 或 * 都行）',
    en: 'Unordered list (- or * works)',
  },
  {
    category: C.lists,
    syntax: '1. item',
    example: '1. First\n2. Second\n3. Third',
    zh: '有序列表',
    en: 'Ordered list',
  },
  {
    category: C.lists,
    syntax: '- [ ] task',
    example: '- [ ] Todo\n- [x] Done',
    zh: '任务列表，可点击切换状态',
    en: 'Task list, click checkbox to toggle',
  },
  {
    category: C.lists,
    syntax: '  - nested',
    example: '- Outer\n  - Inner\n    - Deeper',
    zh: '缩进 2 个空格 = 嵌套一层',
    en: 'Indent 2 spaces to nest deeper',
  },

  // Links & images
  {
    category: C.links,
    syntax: '[text](url)',
    example: '[Google](https://google.com)',
    zh: '链接：[显示文字](网址)',
    en: 'Link: [text](url)',
  },
  {
    category: C.links,
    syntax: '![alt](url)',
    example: '![Logo](./logo.png)',
    zh: '图片：和链接一样，前面加 !',
    en: 'Image: same as link, prefixed with !',
  },
  {
    category: C.links,
    syntax: '<url>',
    example: '<https://example.com>',
    zh: '自动链接',
    en: 'Autolink',
  },
  {
    category: C.links,
    syntax: '[text][ref]',
    example: 'See [the docs][1].\n\n[1]: https://example.com',
    zh: '引用式链接，便于复用 URL',
    en: 'Reference-style link, reuse the URL',
  },
  {
    category: C.links,
    syntax: '[[note]]',
    example: '[[Welcome]]\n[[Welcome|home page]]\n[[Welcome#Get started]]',
    zh: '双链：跳转工作区中同名笔记。Cmd/Ctrl+点击打开。开 `[[` 自动补全。',
    en: 'Wikilink to a note in the workspace folder. Cmd/Ctrl+click to open. Type `[[` for autocomplete. Optional `|alias` and `#heading`.',
  },

  // Code
  {
    category: C.code,
    syntax: '```lang',
    example: '```js\nconsole.log("hi")\n```',
    zh: '代码块，可指定语言名启用语法高亮（js/python/rust/...）',
    en: 'Fenced code block, set the language for syntax highlighting',
  },
  {
    category: C.code,
    syntax: '    indent',
    example: '    indented code',
    zh: '4 空格缩进也是代码块',
    en: 'Indenting 4 spaces also makes a code block',
  },

  // Quotes
  {
    category: C.quotes,
    syntax: '> quote',
    example: '> Knowledge is power.\n> — Bacon',
    zh: '引用块，可多行',
    en: 'Blockquote, can span multiple lines',
  },
  {
    category: C.quotes,
    syntax: '> > nested',
    example: '> outer\n> > inner',
    zh: '嵌套引用',
    en: 'Nested blockquote',
  },

  // Tables
  {
    category: C.tables,
    syntax: '| h1 | h2 |',
    example: '| Name | Age |\n|------|-----|\n| Ada  | 36  |\n| Bob  | 24  |',
    zh: '表格：第二行 --- 必须有，对齐用 :--- :---: ---:',
    en: 'Table: second row of --- is required; alignment with :--- :---: ---:',
  },

  // Math (KaTeX)
  {
    category: C.math,
    syntax: '$inline$',
    example: '$E = mc^2$',
    zh: '行内数学公式',
    en: 'Inline math',
  },
  {
    category: C.math,
    syntax: '$$block$$',
    example: '$$\n\\int_0^\\infty e^{-x^2} dx\n$$',
    zh: '块级数学公式',
    en: 'Block math',
  },

  // Mermaid
  {
    category: C.diagrams,
    syntax: '```mermaid',
    example: '```mermaid\nflowchart LR\nA --> B\nB --> C\n```',
    zh: '流程图（mermaid 代码块），支持 flowchart / sequence / gantt 等',
    en: 'Diagram via Mermaid: flowchart / sequence / gantt etc.',
  },

  // Extras
  {
    category: C.extras,
    syntax: '[^1]',
    example: 'See note[^1].\n\n[^1]: This is the note.',
    zh: '脚注：正文标记 + 底部定义',
    en: 'Footnote: marker in text + definition at bottom',
  },
  {
    category: C.extras,
    syntax: '---\nkey: val\n---',
    example: '---\ntitle: My Doc\nauthor: Alex\n---\n\n# body',
    zh: 'YAML front-matter（文档元数据，必须在首行）',
    en: 'YAML front-matter (document metadata, must be at line 1)',
  },

  // Other
  {
    category: C.other,
    syntax: '---',
    example: 'Above\n\n---\n\nBelow',
    zh: '水平分隔线（也可用 *** 或 ___）',
    en: 'Horizontal rule (--- or *** or ___)',
  },
  {
    category: C.other,
    syntax: '\\*escape',
    example: '\\*literal asterisk\\*',
    zh: '反斜杠转义特殊字符',
    en: 'Backslash to escape special characters',
  },
  {
    category: C.other,
    syntax: '  ↵',
    example: 'line one  \nline two',
    zh: '行尾两个空格 = 强制换行',
    en: 'Two trailing spaces = hard line break',
  },
];

const categories = computed(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of filtered.value) {
    if (!seen.has(it.category)) {
      seen.add(it.category);
      out.push(it.category);
    }
  }
  return out;
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => {
    const hay = `${it.category} ${it.syntax} ${it.example} ${it.zh} ${it.en}`.toLowerCase();
    return q.split(/\s+/).every((tok) => hay.includes(tok));
  });
});

function itemsOf(cat: string) {
  return filtered.value.filter((it) => it.category === cat);
}

async function copyExample(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {}
}
</script>

<template>
  <DsModal
    :model-value="props.open"
    width="820px"
    @update:model-value="emit('close')"
  >
    <template #header>
      <div class="help__hdr">
        <DsTabs
          :model-value="activeTab"
          :tabs="helpTabs"
          class="help__tabs"
          @update:model-value="activeTab = ($event as Tab)"
        />
        <DsInput
          v-if="activeTab !== 'cli'"
          :model-value="query"
          size="sm"
          class="help__search"
          :placeholder="activeTab === 'syntax' ? '搜索语法 / Search syntax…' : t('settings.keysSearch')"
          @update:model-value="query = $event"
        />
      </div>
    </template>
      <div class="help__body">
        <template v-if="activeTab === 'syntax'">
          <section v-for="cat in categories" :key="cat" class="help__section">
            <h3>{{ cat }}</h3>
            <div class="help__grid">
              <div v-for="(it, i) in itemsOf(cat)" :key="i" class="help__item">
                <div class="help__syntax">{{ it.syntax }}</div>
                <div class="help__desc help__desc--zh">{{ it.zh }}</div>
                <div class="help__desc help__desc--en">{{ it.en }}</div>
                <pre
                  class="help__example"
                  @click="copyExample(it.example)"
                  title="Click to copy / 点击复制"
                >{{ it.example }}</pre>
              </div>
            </div>
          </section>
          <p v-if="!filtered.length" class="help__empty">No matching syntax</p>
        </template>

        <template v-if="activeTab === 'shortcuts'">
          <p class="help__lead">
            {{ t('settings.keysHelpLead') }}
            <button class="help__link" @click="changeShortcuts()">{{ t('settings.keysHelpChange') }}</button>
          </p>
          <section v-for="g in liveGroups" :key="g.cat" class="help__section">
            <h3>{{ g.title }}</h3>
            <table class="help__keys">
              <tbody>
              <tr v-for="a in g.items" :key="a.id">
                <td class="help__keys-key"><kbd>{{ liveKeys(a) }}</kbd></td>
                <td class="help__keys-desc">
                  <div>{{ actionName(a) }}</div>
                  <div v-if="actionName(a) !== a.label" class="help__keys-en">{{ a.label }}</div>
                </td>
              </tr>
              </tbody>
            </table>
          </section>
          <section v-if="builtinRows.length" class="help__section">
            <h3>{{ t('settings.keysBuiltin') }}</h3>
            <table class="help__keys">
              <tbody>
              <tr v-for="(s, i) in builtinRows" :key="i">
                <td class="help__keys-key"><kbd>{{ s.keys }}</kbd></td>
                <td class="help__keys-desc">
                  <div>{{ s.zh }}</div>
                  <div class="help__keys-en">{{ s.en }}</div>
                </td>
              </tr>
              </tbody>
            </table>
          </section>
          <p v-if="!liveGroups.length && !builtinRows.length" class="help__lead">{{ t('settings.keysNoMatch') }}</p>
        </template>

        <template v-if="activeTab === 'cli'">
          <p class="help__lead">
            SoloMD 自带一个 <code>solomd</code> 命令行工具，方便从终端开 / 建 / 搜笔记。
          </p>
          <section class="help__section">
            <h3>安装 / Install</h3>
            <pre class="help__code" @click="copyExample('curl -fsSL https://raw.githubusercontent.com/zhitongblog/solomd/main/scripts/install-cli.sh | bash')" title="Click to copy">curl -fsSL https://raw.githubusercontent.com/zhitongblog/solomd/main/scripts/install-cli.sh | bash</pre>
            <p class="help__hint">
              脚本会装到 <code>/usr/local/bin/solomd</code>（或 <code>~/.local/bin</code>）。装完直接 <code>solomd help</code>。
            </p>
          </section>
          <section class="help__section">
            <h3>子命令 / Commands</h3>
            <table class="help__keys">
              <tbody>
              <tr><td class="help__keys-key"><code>solomd open &lt;title|path&gt;</code></td><td class="help__keys-desc"><div>在 SoloMD 中打开指定笔记</div><div class="help__keys-en">Open note in SoloMD</div></td></tr>
              <tr><td class="help__keys-key"><code>solomd new &lt;title&gt; [text]</code></td><td class="help__keys-desc"><div>在笔记目录创建新笔记并打开</div><div class="help__keys-en">Create + open new note</div></td></tr>
              <tr><td class="help__keys-key"><code>solomd list [folder]</code></td><td class="help__keys-desc"><div>列出文件夹内的 markdown 文件</div><div class="help__keys-en">List markdown files in a folder</div></td></tr>
              <tr><td class="help__keys-key"><code>solomd search &lt;query&gt;</code></td><td class="help__keys-desc"><div>在笔记目录搜索文本（自动用 ripgrep）</div><div class="help__keys-en">Search markdown content (uses ripgrep if available)</div></td></tr>
              <tr><td class="help__keys-key"><code>solomd cat &lt;title|path&gt;</code></td><td class="help__keys-desc"><div>在终端打印笔记内容</div><div class="help__keys-en">Print note content to stdout</div></td></tr>
              <tr><td class="help__keys-key"><code>solomd help</code></td><td class="help__keys-desc"><div>显示帮助</div><div class="help__keys-en">Show help</div></td></tr>
              </tbody>
            </table>
          </section>
          <section class="help__section">
            <h3>笔记目录 / Notes directory</h3>
            <p class="help__hint">
              默认 <code>~/Documents/SoloMD</code>。用环境变量 <code>SOLOMD_NOTES</code> 改：
            </p>
            <pre class="help__code" @click="copyExample('export SOLOMD_NOTES=$HOME/Notes')" title="Click to copy">export SOLOMD_NOTES=$HOME/Notes</pre>
            <p class="help__hint">
              <code>title</code> 参数会自动解析为 <code>$SOLOMD_NOTES/&lt;title&gt;.md</code>；如果带 <code>/</code> 或 <code>.md</code>/<code>.txt</code> 后缀，则按路径处理。
            </p>
          </section>
          <section class="help__section">
            <h3>常用范例 / Examples</h3>
            <pre class="help__code" @click="copyExample(cliExampleNew)" title="Click to copy">{{ cliExampleNew }}</pre>
            <pre class="help__code" @click="copyExample('solomd search 重要')" title="Click to copy">solomd search 重要</pre>
            <pre class="help__code" @click="copyExample('solomd open ./my-doc.md')" title="Click to copy">solomd open ./my-doc.md</pre>
          </section>
        </template>
      </div>
    <template #footer>
      <div class="help__footer">
        点击代码块可复制 · 按 <kbd>Esc</kbd> 或点击外部关闭<br />
        Click any code block to copy · Press <kbd>Esc</kbd> or click outside to close
      </div>
    </template>
  </DsModal>
</template>

<style scoped>
/* Header row inside DsModal's header slot: tab strip on the left, the
   syntax search box on the right. */
.help__hdr {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}
.help__tabs {
  flex-shrink: 0;
}
/* DsTabs always renders a (here empty) panel under the tablist — collapse it
   since we host the real content in the modal body. */
.help__tabs :deep(.ds-tabs__panel) {
  display: none;
}
.help__tabs :deep(.ds-tabs__list) {
  border-bottom: none;
}
.help__search {
  flex: 1;
  min-width: 0;
  max-width: 320px;
}
.help__body {
  /* DsModal body already provides padding + scroll; just trim the top so the
     first section sits closer to the header. */
  margin: -4px 0 0;
}
.help__section {
  margin-bottom: 22px;
}
.help__section h3 {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-3);
}
.help__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}
.help__item {
  background: var(--bg-elev);
  border-radius: var(--r-lg);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.help__syntax {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--accent-text);
  font-weight: 600;
}
.help__desc {
  font-size: 12px;
  line-height: 1.45;
}
.help__desc--zh {
  color: var(--text);
}
.help__desc--en {
  color: var(--text-3);
}
.help__example {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--fill-1);
  border-radius: var(--r-sm);
  padding: 6px 8px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  cursor: default;
  color: var(--text);
  transition: background-color var(--dur-fast) var(--ease);
}
.help__example:hover {
  background: var(--fill-2);
}
.help__empty {
  padding: 20px;
  color: var(--text-3);
  text-align: center;
  font-size: 13px;
}
.help__footer {
  padding: 10px 18px;
  font-size: 12px;
  color: var(--text-3);
  border-top: var(--bd-hair);
  text-align: center;
}
.help__footer kbd {
  font: inherit;
  color: var(--text-2);
}

.help__tabs {
  display: flex;
  gap: 4px;
}
.help__tabs button {
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  font: 12px var(--font-ui);
  cursor: pointer;
  transition: all 0.12s;
}
.help__tabs button:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.help__tabs button.active {
  color: var(--text);
  background: var(--bg-elev);
  border-color: var(--border);
  font-weight: 600;
}
.help__lead {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.55;
}
.help__lead code,
.help__hint code {
  /* 5.0 inline code: --fill-1, radius 4, --text */
  background: var(--fill-1);
  padding: 1px 5px;
  border-radius: var(--r-xs);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
}
.help__keys {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.help__keys tr {
  border-bottom: var(--bd-hair);
}
.help__keys tr:last-child { border-bottom: 0; }
.help__keys td {
  padding: 8px 4px;
  vertical-align: top;
}
.help__keys-key {
  white-space: nowrap;
  width: 40%;
}
.help__keys-key kbd {
  font-family: var(--font-ui);
  font-size: 12px;
  letter-spacing: 0.02em;
  color: var(--text-2);
  background: var(--fill-1);
  border-radius: var(--r-xs);
  padding: 1px 6px;
}
.help__keys-key code {
  background: var(--fill-1);
  padding: 2px 8px;
  border-radius: var(--r-xs);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--accent-text);
}
.help__keys-desc div {
  font-size: 12px;
  color: var(--text);
  line-height: 1.4;
}
.help__keys-en {
  color: var(--text-3) !important;
  font-size: 12px !important;
}
.help__hint {
  margin: 6px 0;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.5;
}
.help__code {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--fill-1);
  border-radius: var(--r-sm);
  padding: 8px 10px;
  margin: 6px 0;
  white-space: pre-wrap;
  word-break: break-word;
  cursor: default;
  color: var(--text);
}
.help__code:hover {
  background: var(--fill-2);
}
.help__link {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--accent-text);
  cursor: default;
}
</style>
