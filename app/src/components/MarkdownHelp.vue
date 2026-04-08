<script setup lang="ts">
import { computed, ref } from 'vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const query = ref('');

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
  <div v-if="props.open" class="help__backdrop" @click.self="emit('close')">
    <div class="help" role="dialog" aria-label="Markdown syntax help">
      <header class="help__header">
        <h2>Markdown 速查 / Cheatsheet</h2>
        <input
          v-model="query"
          class="help__search"
          placeholder="搜索语法 / Search syntax…"
          spellcheck="false"
        />
        <button class="help__close" @click="emit('close')">×</button>
      </header>
      <div class="help__body">
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
      </div>
      <footer class="help__footer">
        点击代码块可复制 · 按 <kbd>Esc</kbd> 或点击外部关闭<br />
        Click any code block to copy · Press <kbd>Esc</kbd> or click outside to close
      </footer>
    </div>
  </div>
</template>

<style scoped>
.help__backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}
.help {
  background: var(--bg-elev);
  width: min(820px, 94vw);
  max-height: 86vh;
  border-radius: 10px;
  border: 1px solid var(--border);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.help__header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.help__header h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  flex-shrink: 0;
}
.help__search {
  flex: 1;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  font: 12px var(--font-ui);
  outline: none;
}
.help__search:focus {
  border-color: var(--accent);
}
.help__close {
  font-size: 22px;
  line-height: 1;
  padding: 0 6px;
  color: var(--text-muted);
}
.help__body {
  padding: 18px 22px 8px;
  overflow-y: auto;
  flex: 1;
}
.help__section {
  margin-bottom: 22px;
}
.help__section h3 {
  margin: 0 0 10px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--accent);
}
.help__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}
.help__item {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.help__syntax {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--accent);
  font-weight: 600;
}
.help__desc {
  font-size: 11px;
  line-height: 1.4;
}
.help__desc--zh {
  color: var(--text);
}
.help__desc--en {
  color: var(--text-muted);
  font-style: italic;
}
.help__example {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--bg-hover);
  border-radius: 4px;
  padding: 6px 8px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  cursor: pointer;
  color: var(--text);
  transition: background 0.12s;
}
.help__example:hover {
  background: var(--bg-active);
}
.help__empty {
  padding: 20px;
  color: var(--text-faint);
  text-align: center;
  font-size: 13px;
}
.help__footer {
  padding: 10px 18px;
  font-size: 11px;
  color: var(--text-faint);
  border-top: 1px solid var(--border);
  text-align: center;
}
.help__footer kbd {
  background: var(--bg-active);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: var(--font-mono);
  font-size: 10px;
}
</style>
