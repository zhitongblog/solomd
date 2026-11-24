/**
 * #653 — User-defined Snippets (代码片段) with variable expansion, selection
 * wrapping (`%%` / `${sel}`), cursor placement (`@@`), and recently-used pinning.
 */

export interface SnippetItem {
  id: string;
  name: string;
  description?: string;
  content: string;
  category?: string;
  updatedAt: number;
}

export interface SnippetExpandContext {
  selection: string;
  filebase: string;
  title: string;
  filebaseprev: string;
  filebasenext: string;
  now?: Date;
}

export interface ExpandedSnippet {
  /** Final text with `@@` stripped. */
  text: string;
  /** Caret offset inside `text` where `@@` appeared, or `text.length` if absent. */
  cursorOffset: number;
}

const STORAGE_KEY = 'solomd.snippets.v1';

const EN_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const CN_WEEKDAYS = [
  '星期日',
  '星期一',
  '星期二',
  '星期三',
  '星期四',
  '星期五',
  '星期六',
];

export const DEFAULT_SNIPPETS: SnippetItem[] = [
  {
    id: 'builtin-alert-info',
    name: 'Note · 信息提示块 (HTML)',
    category: 'Alert',
    content:
      '<div style="display:flex;gap:12px;padding:14px 16px;margin:16px 0;border-left:4px solid #185FA5;border-radius:6px;background:#E6F1FB;font-size:14px;line-height:1.6;color:#2C2C2A;"><span style="flex:0 0 auto;color:#185FA5;font-size:18px;line-height:1.4;">📖</span><div><div style="font-weight:600;color:#0C447C;margin-bottom:4px;">Note · 说明</div><div>%%@@</div></div></div>\n',
    updatedAt: 1,
  },
  {
    id: 'builtin-alert-warning',
    name: 'Warning · 警告提示块 (:::alert-warning)',
    category: 'Alert',
    content: ':::alert-warning 注意\n%%@@\n:::\n',
    updatedAt: 1,
  },
  {
    id: 'builtin-alert-danger',
    name: 'Danger · 危险提示块 (:::alert-danger)',
    category: 'Alert',
    content: ':::alert-danger 警告\n%%@@\n:::\n',
    updatedAt: 1,
  },
  {
    id: 'builtin-prev-next-links',
    name: '上下篇双链导航',
    category: 'Navigation',
    content: '上一篇：[[${filebaseprev}]] | 下一篇：[[${filebasenext}]]@@\n',
    updatedAt: 1,
  },
  {
    id: 'builtin-date-header',
    name: '日期时间戳头',
    category: 'Meta',
    content: '> ${date} ${weekdaycn} ${time} · ${filebase}\n\n%%@@',
    updatedAt: 1,
  },
];

export const SNIPPET_VARIABLES: Array<{ token: string; descZh: string; descEn: string }> = [
  { token: '%%', descZh: '选中内容（等价 ${sel}）', descEn: 'Selected text (alias of ${sel})' },
  { token: '@@', descZh: '插入后光标落点', descEn: 'Caret position after insert' },
  { token: '${sel}', descZh: '主编辑器中选中的内容', descEn: 'Selected text in editor' },
  { token: '${filebase}', descZh: '当前笔记文件名（不含扩展名）', descEn: 'Current note basename' },
  { token: '${title}', descZh: '当前笔记第 1 个一级标题', descEn: 'First H1 heading in note' },
  { token: '${filebaseprev}', descZh: '导航树前一个笔记文件名', descEn: 'Previous note basename in tree' },
  { token: '${filebasenext}', descZh: '导航树后一个笔记文件名', descEn: 'Next note basename in tree' },
  { token: '${date}', descZh: '当前日期 YYYY-MM-DD', descEn: 'Current date YYYY-MM-DD' },
  { token: '${time}', descZh: '当前时间 HH:MM:SS', descEn: 'Current time HH:MM:SS' },
  { token: '${ts}', descZh: '14 位时间戳 YYYYMMDDHHMMSS', descEn: '14-digit timestamp' },
  { token: '${year}', descZh: '4 位年份', descEn: '4-digit year' },
  { token: '${mm}', descZh: '2 位月份 (01-12)', descEn: '2-digit month' },
  { token: '${dd}', descZh: '2 位日期 (01-31)', descEn: '2-digit day' },
  { token: '${weekday}', descZh: '英文星期', descEn: 'English weekday' },
  { token: '${weekdaycn}', descZh: '中文星期', descEn: 'Chinese weekday' },
];

export function extractFirstH1Title(markdown: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return '';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Expand a snippet template with all #653 built-in variables, `%%` / `${sel}`
 * selection wrapping, and `@@` caret positioning.
 */
export function expandSnippet(
  template: string,
  ctx: SnippetExpandContext,
): ExpandedSnippet {
  const now = ctx.now ?? new Date();
  const year = String(now.getFullYear());
  const m = String(now.getMonth() + 1);
  const mm = pad2(now.getMonth() + 1);
  const d = String(now.getDate());
  const dd = pad2(now.getDate());
  const H = String(now.getHours());
  const HH = pad2(now.getHours());
  const M = String(now.getMinutes());
  const MM = pad2(now.getMinutes());
  const S = String(now.getSeconds());
  const SS = pad2(now.getSeconds());

  const vars: Record<string, string> = {
    sel: ctx.selection,
    filebase: ctx.filebase,
    year,
    m,
    mm,
    d,
    dd,
    date: `${year}-${mm}-${dd}`,
    weekday: EN_WEEKDAYS[now.getDay()] ?? '',
    weekdaycn: CN_WEEKDAYS[now.getDay()] ?? '',
    H,
    HH,
    M,
    MM,
    S,
    SS,
    time: `${HH}:${MM}:${SS}`,
    ts: `${year}${mm}${dd}${HH}${MM}${SS}`,
    title: ctx.title,
    filebaseprev: ctx.filebaseprev,
    filebasenext: ctx.filebasenext,
  };

  // Replace `%%` (selection alias) and `${varName}` tokens.
  let expanded = template.replace(/%%/g, () => ctx.selection);
  expanded = expanded.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (match, key: string) =>
    key in vars ? vars[key] : match,
  );

  // Locate first `@@` caret marker and strip all `@@` markers.
  const caretIdx = expanded.indexOf('@@');
  if (caretIdx >= 0) {
    const text = expanded.replace(/@@/g, '');
    return { text, cursorOffset: caretIdx };
  }
  return { text: expanded, cursorOffset: expanded.length };
}

/** Convert an expanded snippet into SoloMD's `$|$` insertMarkdown payload. */
export function toInsertMarkdownPayload(expanded: ExpandedSnippet): string {
  return (
    expanded.text.slice(0, expanded.cursorOffset) +
    '$|$' +
    expanded.text.slice(expanded.cursorOffset)
  );
}

export function loadSnippets(): SnippetItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SNIPPETS.map((s) => ({ ...s }));
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (x): x is SnippetItem =>
          x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.content === 'string',
      );
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_SNIPPETS.map((s) => ({ ...s }));
}

export function saveSnippets(items: SnippetItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* quota */
  }
}

/** Move the most recently used snippet to index 0 (auto-pin recent). */
export function pinSnippetToTop(items: SnippetItem[], id: string): SnippetItem[] {
  const idx = items.findIndex((s) => s.id === id);
  if (idx <= 0) return items;
  const next = items.slice();
  const [item] = next.splice(idx, 1);
  next.unshift({ ...item, updatedAt: Date.now() });
  return next;
}
