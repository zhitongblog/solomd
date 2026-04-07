<script setup lang="ts">
import { computed, ref } from 'vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const query = ref('');

interface Item {
  category: string;
  syntax: string;
  example: string;
  preview: string;
  description: string;
}

const items: Item[] = [
  // Headings
  {
    category: 'Headings',
    syntax: '# Heading',
    example: '# H1\n## H2\n### H3',
    preview: 'H1 / H2 / H3',
    description: '一到六级标题，# 数量 = 级别',
  },
  // Emphasis
  {
    category: 'Emphasis',
    syntax: '**bold**',
    example: '**bold text**',
    preview: '**bold text**',
    description: '加粗文字',
  },
  {
    category: 'Emphasis',
    syntax: '*italic*',
    example: '*italic text*',
    preview: '*italic text*',
    description: '斜体文字',
  },
  {
    category: 'Emphasis',
    syntax: '~~strike~~',
    example: '~~deleted~~',
    preview: '~~deleted~~',
    description: '删除线',
  },
  {
    category: 'Emphasis',
    syntax: '`code`',
    example: '`inline code`',
    preview: '`inline code`',
    description: '行内代码',
  },
  // Lists
  {
    category: 'Lists',
    syntax: '- item',
    example: '- Apple\n- Banana\n- Cherry',
    preview: '• Apple\n• Banana\n• Cherry',
    description: '无序列表（- 或 * 都行）',
  },
  {
    category: 'Lists',
    syntax: '1. item',
    example: '1. First\n2. Second\n3. Third',
    preview: '1. First\n2. Second\n3. Third',
    description: '有序列表',
  },
  {
    category: 'Lists',
    syntax: '- [ ] task',
    example: '- [ ] Todo\n- [x] Done',
    preview: '☐ Todo\n☑ Done',
    description: '任务列表（GFM）',
  },
  {
    category: 'Lists',
    syntax: '  - nested',
    example: '- Outer\n  - Inner\n    - Deeper',
    preview: '• Outer\n  • Inner\n    • Deeper',
    description: '缩进 2 个空格 = 嵌套',
  },
  // Links & images
  {
    category: 'Links & Images',
    syntax: '[text](url)',
    example: '[Google](https://google.com)',
    preview: '[Google](url)',
    description: '链接：[显示文字](网址)',
  },
  {
    category: 'Links & Images',
    syntax: '![alt](url)',
    example: '![Logo](./logo.png)',
    preview: '🖼 image',
    description: '图片：和链接一样，前面加 !',
  },
  {
    category: 'Links & Images',
    syntax: '<url>',
    example: '<https://example.com>',
    preview: '<https://example.com>',
    description: '自动链接',
  },
  // Code
  {
    category: 'Code',
    syntax: '```lang',
    example: '```js\nconsole.log("hi")\n```',
    preview: 'Code block with syntax highlighting',
    description: '代码块，可指定语言（js/python/rust/...）',
  },
  // Quotes
  {
    category: 'Quotes',
    syntax: '> quote',
    example: '> Knowledge is power.\n> — Bacon',
    preview: '┃ Knowledge is power.\n┃ — Bacon',
    description: '引用块，可多行',
  },
  // Tables
  {
    category: 'Tables',
    syntax: '| h1 | h2 |',
    example: '| Name | Age |\n|------|-----|\n| Ada  | 36  |\n| Bob  | 24  |',
    preview: '| Name | Age |\n|------|-----|',
    description: '表格：第二行 --- 必须有，对齐用 :--- :---: ---:',
  },
  // Horizontal rule
  {
    category: 'Other',
    syntax: '---',
    example: 'Above\n\n---\n\nBelow',
    preview: '─────',
    description: '水平分隔线（也可用 *** 或 ___）',
  },
  // Footnote / GFM
  {
    category: 'Other',
    syntax: '\\*escape',
    example: '\\*literal asterisk\\*',
    preview: '*literal asterisk*',
    description: '反斜杠转义特殊字符',
  },
  // Math (KaTeX)
  {
    category: 'Math (KaTeX)',
    syntax: '$inline$',
    example: '$E = mc^2$',
    preview: 'E = mc²',
    description: '行内数学公式',
  },
  {
    category: 'Math (KaTeX)',
    syntax: '$$block$$',
    example: '$$\n\\int_0^\\infty e^{-x^2} dx\n$$',
    preview: '∫₀^∞ e^(-x²) dx',
    description: '块级数学公式',
  },
  // Mermaid
  {
    category: 'Mermaid Diagrams',
    syntax: '```mermaid',
    example: '```mermaid\nflowchart LR\nA --> B\nB --> C\n```',
    preview: 'A → B → C',
    description: '流程图（mermaid 代码块）',
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
    const hay = `${it.category} ${it.syntax} ${it.example} ${it.description}`.toLowerCase();
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
        <h2>Markdown Cheatsheet</h2>
        <input
          v-model="query"
          class="help__search"
          placeholder="Search syntax…"
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
              <div class="help__desc">{{ it.description }}</div>
              <pre
                class="help__example"
                @click="copyExample(it.example)"
                :title="'Click to copy'"
              >{{ it.example }}</pre>
            </div>
          </div>
        </section>
        <p v-if="!filtered.length" class="help__empty">No matching syntax</p>
      </div>
      <footer class="help__footer">
        Click any code block to copy.  ·  Press <kbd>Esc</kbd> or click outside to close.
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
  color: var(--text-muted);
  line-height: 1.4;
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
