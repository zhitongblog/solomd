<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed, nextTick } from 'vue';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, search } from '@codemirror/search';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import mermaid from 'mermaid';
import { LanguageDescription } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { html as htmlLang } from '@codemirror/lang-html';
import { css as cssLang } from '@codemirror/lang-css';
import { json as jsonLang } from '@codemirror/lang-json';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { go } from '@codemirror/lang-go';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { vim } from '@replit/codemirror-vim';
import { cmThemeFor } from '../lib/themes';
import { useTabsStore } from '../stores/tabs';
import { useSettingsStore, buildEditorFontStack } from '../stores/settings';
import type { Tab } from '../types';
import { livePreviewExtension, richHighlightOnly } from '../lib/cm-live-preview';
import { liveEditExtension } from '../lib/cm-live-render';
import { liveBlocksExtension, liveBlocksTheme, extractImageRoot } from '../lib/cm-live-blocks';
import { findTldrawFences, replaceBoardSnapshot } from '../lib/tldraw-board';
import { dragAwareExtension } from '../lib/cm-drag-aware';
import { imagePasteExtension, insertImageFromPath as cmInsertImageFromPath } from '../lib/cm-image-paste';
import { focusModeExtension, typewriterModeExtension } from '../lib/cm-focus-mode';
import { wikilinkExtension, wikilinkComplete } from '../lib/cm-wikilink';
import { tagAutocompleteExtension, tagComplete } from '../lib/cm-tag-autocomplete';
import { citationsExtension, citationCompleteSource } from '../lib/cm-citations';
import { autocompletion } from '@codemirror/autocomplete';
import { aiRewriteExtension } from '../lib/cm-ai-rewrite';
import { IS_APP_STORE_BUILD } from '../lib/app-build';
import { slashCommandsExtension } from '../lib/cm-slash-commands';
import { useI18n } from '../i18n';
import { spellcheckExtension } from '../lib/cm-spellcheck';
import { spellcheckTheme } from '../lib/cm-spellcheck-theme';
import { usePandocExport } from '../composables/usePandocExport';
import type { CitationEntry } from '../lib/citations';
import { taskListExtension } from '../lib/cm-task-list';
import { imeCompositionGuard } from '../lib/cm-ime-guard';
import {
  sessionRestoreExtension,
  readSession,
  clearSession,
} from '../lib/cm-session-restore';
import { renderMarkdown, extractImageRoot as extractMarkdownImageRoot } from '../lib/markdown';
import { rewriteImageUrls } from '../lib/image-resolve';

type PlainBlock = {
  id: string;
  start: number;
  end: number;
  text: string;
  hasTrailingNewline: boolean;
  html: string;
};

const codeLanguages = [
  LanguageDescription.of({ name: 'javascript', alias: ['js', 'jsx'], support: javascript({ jsx: true }) }),
  LanguageDescription.of({ name: 'typescript', alias: ['ts', 'tsx'], support: javascript({ jsx: true, typescript: true }) }),
  LanguageDescription.of({ name: 'python', alias: ['py'], support: python() }),
  LanguageDescription.of({ name: 'rust', alias: ['rs'], support: rust() }),
  LanguageDescription.of({ name: 'html', support: htmlLang() }),
  LanguageDescription.of({ name: 'css', support: cssLang() }),
  LanguageDescription.of({ name: 'json', support: jsonLang() }),
  LanguageDescription.of({ name: 'cpp', alias: ['c', 'c++'], support: cpp() }),
  LanguageDescription.of({ name: 'java', support: java() }),
  LanguageDescription.of({ name: 'go', alias: ['golang'], support: go() }),
  LanguageDescription.of({ name: 'yaml', alias: ['yml'], support: yaml() }),
  LanguageDescription.of({ name: 'sql', support: sql() }),
  LanguageDescription.of({ name: 'xml', support: xml() }),
];

const props = withDefaults(
  defineProps<{
    tab: Tab;
    focusMode?: boolean;
    typewriterMode?: boolean;
    spellCheck?: boolean;
  }>(),
  {
    focusMode: false,
    typewriterMode: false,
    spellCheck: true,
  },
);
const emit = defineEmits<{
  (e: 'cursor', line: number, col: number): void;
  (e: 'selection', text: string): void;
}>();

const tabs = useTabsStore();
const settings = useSettingsStore();
const { t } = useI18n();
const pandoc = usePandocExport();
let cachedCitations: CitationEntry[] = [];
pandoc.loadCitations().then((c) => { cachedCitations = c; }).catch(() => {});
watch(
  () => settings.workspaceBibliography,
  () => {
    pandoc.invalidateCitationsCache();
    pandoc.loadCitations().then((c) => { cachedCitations = c; }).catch(() => {});
  },
);

const host = ref<HTMLDivElement | null>(null);
let view: EditorView | null = null;
let cleanupRelayout: (() => void) | null = null;
let contentSyncTimer: ReturnType<typeof setTimeout> | null = null;

const themeCompartment = new Compartment();
const langCompartment = new Compartment();
const wrapCompartment = new Compartment();
const lineNumCompartment = new Compartment();
const fontSizeCompartment = new Compartment();
const richCompartment = new Compartment();
const spellCheckCompartment = new Compartment();
const focusCompartment = new Compartment();
const typewriterCompartment = new Compartment();
const vimCompartment = new Compartment();
const slashCompartment = new Compartment();
const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform);
const usePlainWindowsEditor = isWindows;

function syncEditorContentSoon(text: string) {
  if (contentSyncTimer) clearTimeout(contentSyncTimer);
  contentSyncTimer = setTimeout(() => {
    contentSyncTimer = null;
    tabs.setContent(props.tab.id, text);
  }, 350);
}

const plainEditor = ref<HTMLTextAreaElement | null>(null);
const plainLiveHost = ref<HTMLDivElement | null>(null);
const plainBlockEditors = ref<Record<number, HTMLTextAreaElement | null>>({});
const plainText = ref(props.tab.content || '');
const plainActiveBlock = ref(0);
let plainComposing = false;
let plainMermaidIdSeq = 0;
const plainRenderCache = new Map<string, string>();

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: settings.theme === 'dark' ? 'dark' : 'default',
});

const plainLiveEnabled = computed(
  () => usePlainWindowsEditor && settings.viewMode === 'liveEdit' && props.tab.language === 'markdown',
);

const plainEditorStyle = computed(() => ({
  '--plain-editor-font-size': `${settings.fontSize || 14}px`,
  '--plain-editor-font-family': buildEditorFontStack(settings.fontFamily),
  '--plain-preview-font-size': `${settings.previewFontSize || settings.fontSize || 15}px`,
}));

const plainBlocks = computed<PlainBlock[]>(() => {
  if (!plainLiveEnabled.value) return [];
  return splitPlainMarkdownBlocks(plainText.value || '').map((block, index) => ({
    ...block,
    id: `${block.start}:${index}`,
    html: index === plainActiveBlock.value ? '' : renderPlainBlock(block.text),
  }));
});

function renderPlainBlock(src: string): string {
  const root = extractMarkdownImageRoot(plainText.value || '');
  const key = `${props.tab.filePath || ''}\u0000${root}\u0000${src}`;
  const cached = plainRenderCache.get(key);
  if (cached != null) return cached;
  const html = rewriteImageUrls(
    renderMarkdown(src || '\n', { breaks: true }),
    root,
    props.tab.filePath,
  );
  plainRenderCache.set(key, html);
  if (plainRenderCache.size > 300) plainRenderCache.clear();
  return html;
}

async function processPlainLiveRenderedBlocks() {
  if (!plainLiveEnabled.value || !plainLiveHost.value) return;
  await nextTick();
  const hostEl = plainLiveHost.value;

  const mermaidBlocks = hostEl.querySelectorAll('.plain-block__render pre > code.language-mermaid');
  for (const block of Array.from(mermaidBlocks)) {
    const pre = block.parentElement as HTMLElement | null;
    if (!pre || pre.dataset.rendered === '1') continue;
    pre.dataset.rendered = '1';
    const code = (block.textContent || '').trim();
    const id = `plain-mmd-${++plainMermaidIdSeq}`;
    try {
      const { svg } = await mermaid.render(id, code);
      const wrap = document.createElement('div');
      wrap.className = 'plain-mermaid-block';
      wrap.innerHTML = svg;
      pre.replaceWith(wrap);
    } catch (e) {
      pre.classList.add('plain-block__broken');
      pre.textContent = `Mermaid error: ${(e as Error).message}`;
    }
  }

  const tldrawBlocks = hostEl.querySelectorAll('.plain-block__render pre > code.language-tldraw');
  if (tldrawBlocks.length === 0) return;
  const { boardToSvg } = await import('../lib/tldraw-runtime');
  const fences = findTldrawFences(plainText.value || '');
  const theme = {
    colorScheme: (settings.theme === 'dark' ? 'dark' : 'light') as 'dark' | 'light',
    locale: settings.language || 'en',
  };
  for (const block of Array.from(tldrawBlocks)) {
    const pre = block.parentElement as HTMLElement | null;
    if (!pre || pre.dataset.rendered === '1') continue;
    pre.dataset.rendered = '1';
    const body = (block.textContent || '').trim();
    const fence = fences.find((item) => item.snapshot.trim() === body) ?? null;
    const wrap = document.createElement('div');
    wrap.className = 'plain-whiteboard-block';
    try {
      const svg = await boardToSvg(fence?.snapshot ?? body, theme);
      if (svg) {
        wrap.innerHTML = svg;
        if (fence?.boardId) {
          wrap.classList.add('plain-whiteboard-block--clickable');
          wrap.setAttribute('role', 'button');
          wrap.setAttribute('tabindex', '0');
          wrap.title = t('whiteboard.openFull');
          const openFull = () => {
            window.dispatchEvent(
              new CustomEvent('solomd:whiteboard-open', {
                detail: { boardId: fence.boardId, tabId: props.tab.id, snapshot: fence.snapshot },
              }),
            );
          };
          wrap.addEventListener('click', openFull);
          wrap.addEventListener('keydown', (ev) => {
            if ((ev as KeyboardEvent).key === 'Enter' || (ev as KeyboardEvent).key === ' ') {
              ev.preventDefault();
              openFull();
            }
          });
        }
      } else {
        wrap.classList.add('plain-block__broken');
        wrap.textContent = t('whiteboard.empty');
      }
      pre.replaceWith(wrap);
    } catch {
      pre.classList.add('plain-block__broken');
      pre.textContent = t('whiteboard.loadFailed');
    }
  }
}

function splitPlainMarkdownBlocks(
  src: string,
): Array<{ start: number; end: number; text: string; hasTrailingNewline: boolean }> {
  if (!src) return [{ start: 0, end: 0, text: '', hasTrailingNewline: false }];

  const lines: Array<{ start: number; end: number; text: string; raw: string }> = [];
  let pos = 0;
  while (pos < src.length) {
    const nl = src.indexOf('\n', pos);
    const end = nl >= 0 ? nl + 1 : src.length;
    const raw = src.slice(pos, end);
    lines.push({
      start: pos,
      end,
      raw,
      text: raw.endsWith('\n') ? raw.slice(0, -1) : raw,
    });
    pos = end;
  }

  const blocks: Array<{ start: number; end: number; text: string; hasTrailingNewline: boolean }> = [];
  const pushRange = (start: number, end: number) => {
    if (end < start) return;
    // The editable text must NOT carry the block-separating trailing newline.
    // Keeping it created a phantom empty last line in the active <textarea>:
    // the caret could land after it and typed/IME-committed text dropped onto a
    // fresh line ("每输入一个换一行"). start/end still cover the full range so the
    // separator is reconstructed in updatePlainBlock.
    const raw = src.slice(start, end);
    const hasTrailingNewline = raw.endsWith('\n');
    blocks.push({ start, end, text: hasTrailingNewline ? raw.slice(0, -1) : raw, hasTrailingNewline });
  };
  const kindFor = (line: { text: string }) => {
    const text = line.text;
    const trimmed = text.trim();
    if (trimmed === '') return 'blank';
    if (/^(```|~~~)/.test(trimmed)) return 'fence';
    if (/^#{1,6}\s+/.test(trimmed)) return 'heading';
    if (/^(---|\*\*\*|___)\s*$/.test(trimmed)) return 'thematic';
    if (/^\s{0,3}>\s?/.test(text)) return 'quote';
    if (/^\s{0,3}([-+*]|\d+[.)])\s+/.test(text)) return 'list';
    if (/^\s{0,3}([-*])\s+\[[ xX]\]\s+/.test(text)) return 'list';
    if (/^\s{0,3}\|.*\|\s*$/.test(text)) return 'table';
    if (/^\s{4,}\S/.test(text)) return 'indented';
    return 'paragraph';
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const kind = kindFor(line);

    if (kind === 'blank' || kind === 'heading' || kind === 'thematic') {
      pushRange(line.start, line.end);
      i++;
      continue;
    }

    if (kind === 'fence') {
      const marker = line.text.trim().startsWith('~~~') ? '~~~' : '```';
      let j = i + 1;
      while (j < lines.length) {
        if (lines[j].text.trim().startsWith(marker)) {
          j++;
          break;
        }
        j++;
      }
      pushRange(line.start, lines[j - 1]?.end ?? line.end);
      i = j;
      continue;
    }

    if (kind === 'table') {
      let j = i + 1;
      while (j < lines.length && (kindFor(lines[j]) === 'table' || /^\s{0,3}\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[j].text))) j++;
      pushRange(line.start, lines[j - 1]?.end ?? line.end);
      i = j;
      continue;
    }

    if (kind === 'list' || kind === 'quote' || kind === 'indented') {
      let j = i + 1;
      while (j < lines.length) {
        const nextKind = kindFor(lines[j]);
        if (nextKind !== kind && nextKind !== 'blank') break;
        if (nextKind === 'blank' && j + 1 < lines.length && kindFor(lines[j + 1]) !== kind) break;
        j++;
      }
      pushRange(line.start, lines[j - 1]?.end ?? line.end);
      i = j;
      continue;
    }

    let j = i + 1;
    while (j < lines.length && kindFor(lines[j]) === 'paragraph') j++;
    pushRange(line.start, lines[j - 1]?.end ?? line.end);
    i = j;
  }

  if (blocks.length === 0) {
    const hasTrailingNewline = src.endsWith('\n');
    return [
      {
        start: 0,
        end: src.length,
        text: hasTrailingNewline ? src.slice(0, -1) : src,
        hasTrailingNewline,
      },
    ];
  }
  // A document that ends with a newline has an empty final line. Represent it as
  // its own (zero-width) block so the caret has somewhere to land when the user
  // presses Enter at the end of the last line — otherwise the newline is absorbed
  // as a separator with no following block and the caret appears not to move.
  if (src.endsWith('\n')) {
    blocks.push({ start: src.length, end: src.length, text: '', hasTrailingNewline: false });
  }
  return blocks;
}

function plainLineHeightPx(): number {
  const editor = plainLiveEnabled.value
    ? plainBlockEditors.value[plainActiveBlock.value]
    : plainEditor.value;
  if (!editor) return Math.max(16, (settings.fontSize || 14) * 1.6);
  const style = window.getComputedStyle(editor);
  const n = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(n) && n > 0) return n;
  const fs = Number.parseFloat(style.fontSize);
  return Number.isFinite(fs) && fs > 0 ? fs * 1.6 : 24;
}

function plainSelectionText(): string {
  if (plainLiveEnabled.value) {
    const el = plainBlockEditors.value[plainActiveBlock.value];
    if (!el) return '';
    const from = el.selectionStart ?? 0;
    const to = el.selectionEnd ?? 0;
    return from === to ? '' : el.value.slice(from, to);
  }
  const el = plainEditor.value;
  if (!el) return '';
  const from = el.selectionStart ?? 0;
  const to = el.selectionEnd ?? 0;
  return from === to ? '' : el.value.slice(from, to);
}

function emitPlainCursorAndSelection() {
  if (plainLiveEnabled.value) {
    const el = plainBlockEditors.value[plainActiveBlock.value];
    const block = plainBlocks.value[plainActiveBlock.value];
    if (!el || !block) return;
    const head = el.selectionStart ?? 0;
    const before = plainText.value.slice(0, block.start) + el.value.slice(0, head);
    const lines = before.split('\n');
    const line = lines.length;
    const col = lines[lines.length - 1]?.length ?? 0;
    emit('cursor', line, col + 1);
    emit('selection', plainSelectionText());
    return;
  }
  const el = plainEditor.value;
  if (!el) return;
  const head = el.selectionStart ?? 0;
  const lines = el.value.slice(0, head).split('\n');
  const line = lines.length;
  const col = lines[lines.length - 1]?.length ?? 0;
  emit('cursor', line, col + 1);
  emit('selection', plainSelectionText());
}

function plainSetCaret(pos: number) {
  if (plainLiveEnabled.value) {
    const blocks = plainBlocks.value;
    const found = blocks.findIndex((block) => pos >= block.start && pos <= block.end);
    const index = found < 0 ? 0 : found;
    activatePlainBlock(index, Math.max(0, pos - (blocks[index]?.start ?? 0)));
    return;
  }
  const el = plainEditor.value;
  if (!el) return;
  const safe = Math.max(0, Math.min(pos, el.value.length));
  el.focus();
  el.setSelectionRange(safe, safe);
  emitPlainCursorAndSelection();
}

function plainLineStartOffset(line: number): number {
  if (plainLiveEnabled.value) {
    const lines = plainText.value.split('\n');
    const safeLine = Math.max(1, Math.min(line, lines.length));
    let offset = 0;
    for (let i = 1; i < safeLine; i++) offset += lines[i - 1].length + 1;
    return offset;
  }
  const el = plainEditor.value;
  if (!el) return 0;
  const safeLine = Math.max(1, Math.min(line, el.value.split('\n').length));
  if (safeLine <= 1) return 0;
  let offset = 0;
  let current = 1;
  while (current < safeLine && offset < el.value.length) {
    const next = el.value.indexOf('\n', offset);
    if (next < 0) return el.value.length;
    offset = next + 1;
    current++;
  }
  return offset;
}

function plainScrollToLine(line: number) {
  if (plainLiveEnabled.value) {
    plainSetCaret(plainLineStartOffset(line));
    return;
  }
  const el = plainEditor.value;
  if (!el) return;
  const safeLine = Math.max(1, line);
  el.scrollTop = Math.max(0, (safeLine - 1) * plainLineHeightPx() - 40);
  syncPlainLiveScroll();
}

function syncPlainLiveScroll() {
  emitPlainCursorAndSelection();
}

function plainInsertText(snippet: string) {
  if (plainLiveEnabled.value) {
    const index = plainActiveBlock.value;
    const el = plainBlockEditors.value[index];
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const nextBlock = `${el.value.slice(0, start)}${snippet}${el.value.slice(end)}`;
    updatePlainBlock(index, nextBlock, start + snippet.length);
    return;
  }
  const el = plainEditor.value;
  if (!el) return;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  const next = `${el.value.slice(0, start)}${snippet}${el.value.slice(end)}`;
  el.value = next;
  const caret = start + snippet.length;
  el.setSelectionRange(caret, caret);
  plainText.value = next;
  tabs.setContent(props.tab.id, next);
  emitPlainCursorAndSelection();
}

function syncPlainEditorFromStore(text: string) {
  const el = plainEditor.value;
  plainText.value = text;
  if (!el) return;
  if (el.value !== text) el.value = text;
  nextTick(() => {
    emitPlainCursorAndSelection();
    syncPlainLiveScroll();
  });
}

function syncPlainEditorAfterModeSwitch() {
  if (!usePlainWindowsEditor) return;
  nextTick(() => {
    if (plainLiveEnabled.value) {
      const block = plainBlocks.value[plainActiveBlock.value];
      const el = plainBlockEditors.value[plainActiveBlock.value];
      if (block && el && el.value !== block.text) el.value = block.text;
      if (el) autoSizePlainBlock(el);
      emitPlainCursorAndSelection();
      return;
    }
    const el = plainEditor.value;
    if (!el) return;
    if (el.value !== plainText.value) el.value = plainText.value;
    emitPlainCursorAndSelection();
    syncPlainLiveScroll();
  });
}

function handlePlainInput(event: Event) {
  if (plainLiveEnabled.value) return;
  const el = event.target as HTMLTextAreaElement;
  plainText.value = el.value;
  tabs.setContent(props.tab.id, el.value);
  emitPlainCursorAndSelection();
  nextTick(syncPlainLiveScroll);
}

/**
 * Greedily align the visible (rendered) text prefix back to the Markdown source
 * so a click in the preview maps to a source caret offset. Markdown syntax that
 * is hidden in the preview (`#`, `*`, `` ` ``, `[`, `](url)`, …) is skipped in
 * the source while the visible characters are matched one-for-one. Plain prose
 * maps exactly; formatted text degrades to a near-by position.
 */
function mapRenderedPrefixToSource(source: string, renderedPrefix: string): number {
  let si = 0;
  let ri = 0;
  while (si < source.length && ri < renderedPrefix.length) {
    if (source[si] === renderedPrefix[ri]) {
      si += 1;
      ri += 1;
    } else {
      // Source character is hidden Markdown syntax (or a skipped newline).
      si += 1;
    }
  }
  return si;
}

/** Visible text from the start of `render` up to the click point, or null. */
function renderedPrefixAtPoint(render: HTMLElement, x: number, y: number): string | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (typeof doc.caretRangeFromPoint === 'function') {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  } else if (typeof doc.caretPositionFromPoint === 'function') {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) {
      node = p.offsetNode;
      offset = p.offset;
    }
  }
  if (!node || !render.contains(node)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(render);
  try {
    pre.setEnd(node, offset);
  } catch {
    return null;
  }
  return pre.toString();
}

function estimatePlainBlockCaretFromClick(index: number, event: MouseEvent): number | undefined {
  const block = plainBlocks.value[index];
  const target = event.currentTarget as HTMLElement | null;
  const render = target?.querySelector('.plain-block__render') as HTMLElement | null;
  if (!block || !render) return undefined;

  // Preferred: map the exact click point in the rendered preview back to a
  // source offset, so a single click lands the caret where the user clicked
  // instead of snapping to the line start.
  const renderedPrefix = renderedPrefixAtPoint(render, event.clientX, event.clientY);
  if (renderedPrefix != null) {
    return mapRenderedPrefixToSource(block.text, renderedPrefix);
  }

  // Fallback: estimate the clicked line from the vertical position and place
  // the caret at that line's start.
  const lines = block.text.split('\n');
  if (lines.length <= 1) return 0;
  const rect = render.getBoundingClientRect();
  const style = window.getComputedStyle(render);
  const lineHeight = Number.parseFloat(style.lineHeight) || (Number.parseFloat(style.fontSize) || 15) * 1.7;
  const lineIndex = Math.max(0, Math.min(lines.length - 1, Math.floor((event.clientY - rect.top) / lineHeight)));
  let caret = 0;
  for (let i = 0; i < lineIndex; i++) caret += lines[i].length + 1;
  return caret;
}

function activatePlainBlockFromClick(index: number, event: MouseEvent) {
  if (index === plainActiveBlock.value) return;
  activatePlainBlock(index, estimatePlainBlockCaretFromClick(index, event));
}

function activatePlainBlock(index: number, caret?: number) {
  plainActiveBlock.value = Math.max(0, Math.min(index, plainBlocks.value.length - 1));
  nextTick(() => {
    const el = plainBlockEditors.value[plainActiveBlock.value];
    if (!el) return;
    el.focus();
    if (caret != null) {
      const pos = Math.max(0, Math.min(caret, el.value.length));
      el.setSelectionRange(pos, pos);
    }
    autoSizePlainBlock(el);
    emitPlainCursorAndSelection();
  });
}

function setPlainBlockEditor(index: number, el: HTMLTextAreaElement | null) {
  plainBlockEditors.value[index] = el;
  if (!el) return;
  const block = plainBlocks.value[index];
  if (block && el.value !== block.text) el.value = block.text;
  nextTick(() => autoSizePlainBlock(el));
}

function autoSizePlainBlock(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${Math.max(plainLineHeightPx(), el.scrollHeight)}px`;
}

function handlePlainBlockInput(index: number, event: Event) {
  const el = event.target as HTMLTextAreaElement;
  autoSizePlainBlock(el);
  if (plainComposing) return;
  updatePlainBlock(index, el.value, el.selectionStart ?? el.value.length);
}

function handlePlainBlockCompositionStart() {
  plainComposing = true;
}

function handlePlainBlockCompositionEnd(index: number, event: CompositionEvent) {
  plainComposing = false;
  const el = event.target as HTMLTextAreaElement;
  autoSizePlainBlock(el);
  updatePlainBlock(index, el.value, el.selectionStart ?? el.value.length);
}

function updatePlainBlock(index: number, text: string, caret?: number) {
  const block = plainBlocks.value[index];
  if (!block) return;
  const nextCaret = block.start + (caret ?? text.length);
  // Re-attach the block separator that splitPlainMarkdownBlocks stripped from
  // the editable text, so neighbouring blocks don't merge on every edit.
  const tail = block.hasTrailingNewline ? '\n' : '';
  const next = `${plainText.value.slice(0, block.start)}${text}${tail}${plainText.value.slice(block.end)}`;
  plainText.value = next;
  tabs.setContent(props.tab.id, next);
  const nextBlocks = splitPlainMarkdownBlocks(next);
  // Locate the block that now holds the caret. Use a half-open range
  // [start, end): when the caret sits exactly on a block boundary (e.g. after
  // pressing Enter at a line end) it belongs to the *following* block — the new
  // line — not the end of the previous one, otherwise the caret appears stuck.
  // Fall back to the block being edited (clamped) when nothing matches — e.g.
  // the caret is at the very document end — rather than snapping to block 0,
  // which would deactivate the edited block and flip it into preview mode.
  let found = nextBlocks.findIndex(
    (candidate) => nextCaret >= candidate.start && nextCaret < candidate.end,
  );
  // A half-open search can't match the caret when it sits at the very end of the
  // document (including the zero-width trailing empty-line block) — land it on
  // the last block there.
  if (found < 0) found = nextBlocks.length - 1;
  const nextIndex = found;
  const nextBlock = nextBlocks[nextIndex];
  plainActiveBlock.value = nextIndex;
  // Fast path only when the block is structurally unchanged. We must also
  // confirm the new block text matches what the <textarea> already holds:
  // typing can split one block into several (e.g. a char before a list "- "
  // marker turns that line into a paragraph). When that happens the inline
  // :ref re-runs setPlainBlockEditor and rewrites el.value to the now-shorter
  // block text, which collapses the caret to the line end — so we must fall
  // through to the nextTick branch and restore the caret explicitly.
  if (nextIndex === index && nextBlock?.start === block.start && nextBlock?.text === text) {
    emitPlainCursorAndSelection();
    return;
  }
  nextTick(() => {
    const activeBlock = plainBlocks.value[plainActiveBlock.value];
    const el = plainBlockEditors.value[plainActiveBlock.value];
    if (!el) return;
    // The active block changed to a different <textarea> (e.g. a re-split moved
    // the caret into another block, or Enter created a new line). The old
    // textarea unmounted, dropping focus to <body>, which leaves the caret
    // invisible and swallows subsequent keystrokes — so re-focus the new one.
    if (document.activeElement !== el) el.focus();
    autoSizePlainBlock(el);
    if (activeBlock) {
      const pos = Math.max(0, Math.min(nextCaret - activeBlock.start, el.value.length));
      el.setSelectionRange(pos, pos);
    }
    emitPlainCursorAndSelection();
  });
}

function slashExt() {
  if (!settings.slashCommandsEnabled) return [];
  return slashCommandsExtension({
    enabled: () => settings.slashCommandsEnabled,
    labelFor: (id) => {
      const v = t(`slashCommands.labels.${id}`);
      return v.startsWith('slashCommands.') ? undefined : v;
    },
    hintFor: (id) => {
      const v = t(`slashCommands.hints.${id}`);
      return v.startsWith('slashCommands.') ? undefined : v;
    },
    emptyHint: (q) => t('slashCommands.empty', { query: q }),
  });
}

function markdownExt() {
  // Use `markdownLanguage` as the base so GFM features (including task
  // list parsing with TaskMarker nodes) are enabled.
  return markdown({ base: markdownLanguage, codeLanguages, addKeymap: true });
}

function spellCheckExt(on: boolean) {
  return EditorView.contentAttributes.of({ spellcheck: on ? 'true' : 'false' });
}

function richExtensionsFor(tab: Tab) {
  if (tab.language !== 'markdown') return [];
  // v2.3 live-edit takes precedence over the existing livePreview toggle —
  // the WYSIWYG bundle ALREADY includes rich highlighting + marker hiding,
  // and stacking livePreviewExtension on top would cause duplicate
  // marker-replace decorations.
  if (settings.viewMode === 'liveEdit') {
    // v3.6 issue #44: in live-edit mode, also collapse standalone image
    // lines + GFM tables into block widgets when the cursor is elsewhere.
    // Cursor enters → widget unmounts → source returns. Image paths
    // resolve via the same extractImageRoot used by Preview/Export.
    return liveEditExtension([
      liveBlocksExtension({
        getImageRoot: () => extractImageRoot(tab.content || ''),
        getFilePath: () => tab.filePath,
        // F7 — live tldraw whiteboard theme + writeback.
        getBoardTheme: () => ({
          colorScheme: settings.theme === 'dark' ? 'dark' : 'light',
          locale: settings.language || 'en',
        }),
        getTabId: () => tab.id,
        getBoardStrings: () => ({
          loading: t('whiteboard.loading'),
          openFull: t('whiteboard.openFull'),
          loadFailed: t('whiteboard.loadFailed'),
        }),
        onBoardEdit: (boardId, snapshotJson) => {
          const cur = tabs.tabs.find((x) => x.id === tab.id);
          if (!cur) return;
          const next = replaceBoardSnapshot(cur.content || '', boardId, snapshotJson);
          if (next !== cur.content) tabs.setContent(tab.id, next);
        },
      }),
      liveBlocksTheme,
    ]);
  }
  return settings.livePreview ? livePreviewExtension() : richHighlightOnly();
}

const fontSizeTheme = (px: number, family: string) =>
  EditorView.theme({
    '&': { fontSize: `${px}px`, height: '100%' },
    '.cm-scroller': { fontFamily: buildEditorFontStack(family), lineHeight: '1.6' },
    '.cm-content': { padding: '12px 16px' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      border: 'none',
      color: 'var(--text-faint)',
    },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--accent)' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(255,159,64,0.25) !important' },
    // v4.3.0 issue #67: distinct current-match highlight for the Cmd+F search
    // panel. CM6 marks the active result with `.cm-searchMatch-selected` —
    // by default it's the same translucent color as the other matches so the
    // user can't tell which one they're on. Brighten it to the accent color
    // and tint the others down so the current one pops.
    '.cm-searchMatch': { backgroundColor: 'rgba(255,159,64,0.22)', borderRadius: '2px' },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'var(--accent, #ff9f40)',
      color: 'var(--accent-fg, #fff)',
      outline: '1px solid var(--accent, #ff9f40)',
    },
  });

function buildExtensions() {
  if (usePlainWindowsEditor) return [];
  const markdownSafeMode = false;
  const windowsImeSafeMode = false;
  return [
    imeCompositionGuard(),
    history(),
    ...(windowsImeSafeMode
      ? []
      : [
          dragAwareExtension(),
          drawSelection(),
          // #90 — column/rectangular selection: hold Alt (Option on macOS) and
          // drag to select a vertical block. `crosshairCursor` swaps the I-beam
          // for a crosshair while Alt is held so the user knows the mode is
          // armed. CM6 already turns multiple selections on by default; no
          // need to flip `EditorState.allowMultipleSelections`.
          rectangularSelection(),
          crosshairCursor(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          search({ top: true }),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        ]),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    lineNumCompartment.of(settings.showLineNumbers ? lineNumbers() : []),
    wrapCompartment.of(settings.wordWrap ? EditorView.lineWrapping : []),
    langCompartment.of(
      windowsImeSafeMode
        ? []
        : props.tab.language === 'markdown'
          ? [markdownExt()]
          : [],
    ),
    richCompartment.of(
      windowsImeSafeMode ? [] : richExtensionsFor(props.tab),
    ),
    themeCompartment.of(cmThemeFor(settings.theme)),
    vimCompartment.of(settings.vimMode ? vim() : []),
    fontSizeCompartment.of(fontSizeTheme(settings.fontSize, settings.fontFamily)),
    spellCheckCompartment.of(spellCheckExt(props.spellCheck)),
    focusCompartment.of(props.focusMode ? focusModeExtension() : []),
    typewriterCompartment.of(props.typewriterMode ? typewriterModeExtension() : []),
    imagePasteExtension({
      getFilePath: () => props.tab.filePath,
      getDocContent: () => props.tab.content,
      getAttachmentMode: () => settings.attachmentMode,
      getAssetsDirName: () => settings.assetsDirName,
      getCustomPath: () => settings.attachmentCustomPath,
    }),
    ...(!windowsImeSafeMode && props.tab.language === 'markdown' && !markdownSafeMode
      ? [
          wikilinkExtension(),
          tagAutocompleteExtension(),
          citationsExtension(() => cachedCitations),
          // Single autocompletion config combining all 3 markdown sources
          // (wikilinks `[[`, tags `#`, citations `@`). CM6 disallows
          // multiple `autocompletion({ override })` extensions.
          autocompletion({
            override: [
              wikilinkComplete,
              tagComplete,
              citationCompleteSource(() => cachedCitations),
            ],
            defaultKeymap: true,
            // Typing-triggered completion is the last remaining source of
            // IME-hostile churn here. Keep the sources available for explicit
            // invocation, but do not wake them up on every keystroke.
            activateOnTyping: false,
          }),
          ...(IS_APP_STORE_BUILD ? [] : [aiRewriteExtension()]),
          spellcheckExtension({ enabled: () => settings.spellcheckEnabled }),
          spellcheckTheme,
          slashCompartment.of(slashExt()),
        ]
      : []),
    ...(windowsImeSafeMode || markdownSafeMode ? [] : [taskListExtension()]),
    sessionRestoreExtension(props.tab.id),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        const text = u.state.doc.toString();
        if (!u.view.composing) syncEditorContentSoon(text);
      }
      if (u.selectionSet) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        emit('cursor', line.number, head - line.from + 1);
        // v4.3.0 issue #70: emit selection text so StatusBar can show
        // selected word/char count. Empty string when nothing's selected.
        const sel = u.state.selection.main;
        emit('selection', sel.empty ? '' : u.state.sliceDoc(sel.from, sel.to));
      }
    }),
  ];
}

function maybeRestoreSession() {
  const saved = readSession(props.tab.id);
  if (!saved || saved === '' || props.tab.content !== '') return;
  if (usePlainWindowsEditor) {
    if (plainLiveEnabled.value) {
      plainText.value = saved;
      tabs.setContent(props.tab.id, saved);
      return;
    }
    const el = plainEditor.value;
    if (!el || el.value.length > 0) return;
    el.value = saved;
    tabs.setContent(props.tab.id, saved);
    emitPlainCursorAndSelection();
    return;
  }
  if (
    view &&
    view.state.doc.length === 0 &&
    saved !== view.state.doc.toString()
  ) {
    view.dispatch({ changes: { from: 0, to: 0, insert: saved } });
  }
}

onMounted(() => {
  if (usePlainWindowsEditor) {
    syncPlainEditorFromStore(props.tab.content);
    maybeRestoreSession();
    void processPlainLiveRenderedBlocks();
    return;
  }
  if (!host.value) return;
  view = new EditorView({
    state: EditorState.create({ doc: props.tab.content, extensions: buildExtensions() }),
    parent: host.value,
  });
  maybeRestoreSession();
  // Expose the focused EditorView on `window` for dev-bridge / self-test
  // harnesses. Vite injects `import.meta.env.DEV === true` only in dev
  // builds; production bundles dead-code-eliminate this entire block.
  if (import.meta.env.DEV) {
    (window as unknown as { __solomdActiveView?: EditorView }).__solomdActiveView = view;
  }
  // Right-sidebar pane visibility / splitter drags change the available
  // editor width, but CodeMirror's ResizeObserver may lag for a frame.
  // Listen for an explicit relayout event and force a re-measure. Used
  // by the search pane toggle (PR #50) and the rs-pane-host stack.
  const onRelayout = () => view?.requestMeasure();
  window.addEventListener('solomd:relayout', onRelayout);
  cleanupRelayout = () => window.removeEventListener('solomd:relayout', onRelayout);
});

onBeforeUnmount(() => {
  cleanupRelayout?.();
  if (contentSyncTimer) {
    clearTimeout(contentSyncTimer);
    contentSyncTimer = null;
  }
  if (import.meta.env.DEV) {
    const w = window as unknown as { __solomdActiveView?: EditorView };
    if (w.__solomdActiveView === view) delete w.__solomdActiveView;
  }
  view?.destroy();
  view = null;
});

// Switching tabs: replace doc (and rebuild extensions so the
// session-restore plugin is recreated with the new tab id).
watch(
  () => props.tab.id,
  () => {
    if (!view) return;
    view.setState(
      EditorState.create({ doc: props.tab.content, extensions: buildExtensions() })
    );
    maybeRestoreSession();
  }
);

// Clean-save watcher: when the buffer matches savedContent, drop any
// stale session snapshot for this tab.
watch(
  () => [props.tab.content, props.tab.savedContent] as const,
  ([content, saved]) => {
    if (content === saved) clearSession(props.tab.id);
  },
);

watch(
  () => props.spellCheck,
  (v) => {
    view?.dispatch({
      effects: spellCheckCompartment.reconfigure(spellCheckExt(v)),
    });
  },
);

watch(
  () => props.focusMode,
  (v) => {
    view?.dispatch({
      effects: focusCompartment.reconfigure(v ? focusModeExtension() : []),
    });
  },
);

watch(
  () => props.typewriterMode,
  (v) => {
    view?.dispatch({
      effects: typewriterCompartment.reconfigure(
        v ? typewriterModeExtension() : [],
      ),
    });
  },
);

// External content updates (e.g. after Save replacing savedContent only — content stays).
watch(
  () => props.tab.content,
  (next) => {
    if (usePlainWindowsEditor) {
      syncPlainEditorFromStore(next);
      return;
    }
    if (!view) return;
    if (view.state.doc.toString() !== next) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
      });
    }
  }
);

watch(
  () => settings.theme,
  (t) => {
    view?.dispatch({ effects: themeCompartment.reconfigure(cmThemeFor(t)) });
  }
);

watch(
  () => settings.vimMode,
  (v) => {
    view?.dispatch({ effects: vimCompartment.reconfigure(v ? vim() : []) });
  }
);

watch(
  () => settings.wordWrap,
  (w) => {
    view?.dispatch({ effects: wrapCompartment.reconfigure(w ? EditorView.lineWrapping : []) });
  }
);

watch(
  () => settings.showLineNumbers,
  (s) => {
    view?.dispatch({ effects: lineNumCompartment.reconfigure(s ? lineNumbers() : []) });
  }
);

watch(
  [() => settings.fontSize, () => settings.fontFamily],
  ([n, f]) => {
    view?.dispatch({ effects: fontSizeCompartment.reconfigure(fontSizeTheme(n, f)) });
  }
);

watch(
  () => props.tab.language,
  (l) => {
    view?.dispatch({
      effects: [
        langCompartment.reconfigure(l === 'markdown' ? [markdownExt()] : []),
        richCompartment.reconfigure(richExtensionsFor(props.tab)),
      ],
    });
  }
);

watch(
  () => settings.livePreview,
  () => {
    view?.dispatch({ effects: richCompartment.reconfigure(richExtensionsFor(props.tab)) });
  }
);

// v2.3: switching into / out of `liveEdit` swaps the rich extension
// bundle (live-edit decorations are MUCH more aggressive than the
// livePreview fallback, so we need a real reconfigure).
watch(
  () => settings.viewMode,
  () => {
    view?.dispatch({ effects: richCompartment.reconfigure(richExtensionsFor(props.tab)) });
    syncPlainEditorAfterModeSwitch();
    void processPlainLiveRenderedBlocks();
  }
);

watch(
  () => [plainLiveEnabled.value, plainText.value, plainActiveBlock.value, settings.theme, settings.language],
  () => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: settings.theme === 'dark' ? 'dark' : 'default',
    });
    void processPlainLiveRenderedBlocks();
  },
  { flush: 'post' },
);

// v2.5: hot-toggle the slash-command extension when the user flips
// the setting. Only meaningful for markdown buffers — other languages
// never have the compartment in their bundle.
watch(
  () => settings.slashCommandsEnabled,
  () => {
    if (!view) return;
    if (props.tab.language !== 'markdown') return;
    view.dispatch({ effects: slashCompartment.reconfigure(slashExt()) });
  },
);

function gotoLine(line: number) {
  if (usePlainWindowsEditor) {
    if (plainLiveEnabled.value) {
      plainSetCaret(plainLineStartOffset(line));
      plainScrollToLine(line);
      return;
    }
    const el = plainEditor.value;
    if (!el) return;
    plainSetCaret(plainLineStartOffset(line));
    plainScrollToLine(line);
    return;
  }
  if (!view) return;
  const safe = Math.max(1, Math.min(line, view.state.doc.lines));
  const lineObj = view.state.doc.line(safe);
  view.dispatch({
    selection: { anchor: lineObj.from },
    effects: EditorView.scrollIntoView(lineObj.from, { y: 'start', yMargin: 40 }),
  });
  view.focus();
}

async function insertImageFromPath(srcPath: string): Promise<void> {
  if (usePlainWindowsEditor) {
    plainInsertText(srcPath);
    return;
  }
  if (!view) return;
  await cmInsertImageFromPath(view, srcPath, {
    getFilePath: () => props.tab.filePath,
    getDocContent: () => props.tab.content,
    getAttachmentMode: () => settings.attachmentMode,
    getAssetsDirName: () => settings.assetsDirName,
  });
}

/** Returns the 1-indexed line currently at the top of the visible viewport. */
function getViewLine(): number | null {
  if (usePlainWindowsEditor) {
    if (plainLiveEnabled.value) {
      const block = plainBlocks.value[plainActiveBlock.value];
      if (!block) return 1;
      return plainText.value.slice(0, block.start).split('\n').length;
    }
    const el = plainEditor.value;
    if (!el) return null;
    const top = el.scrollTop;
    const line = Math.max(1, Math.floor(top / plainLineHeightPx()) + 1);
    return line;
  }
  if (!view) return null;
  const top = view.scrollDOM.scrollTop;
  const block = view.lineBlockAtHeight(top);
  return view.state.doc.lineAt(block.from).number;
}

/** Scroll the given 1-indexed line to the top of the viewport (without moving cursor). */
function scrollToLine(line: number): void {
  if (usePlainWindowsEditor) {
    plainScrollToLine(line);
    return;
  }
  if (!view) return;
  const safe = Math.max(1, Math.min(line, view.state.doc.lines));
  const lineObj = view.state.doc.line(safe);
  view.dispatch({
    effects: EditorView.scrollIntoView(lineObj.from, { y: 'start', yMargin: 8 }),
  });
}

/**
 * Insert markdown snippet at the current cursor. If `snippet` contains a
 * literal `$|$` marker, the cursor lands there after insert (marker stripped).
 * Otherwise the cursor is placed at the end of the inserted text.
 */
function insertMarkdown(snippet: string): void {
  if (usePlainWindowsEditor) {
    plainInsertText(snippet);
    return;
  }
  if (!view) return;
  const CURSOR = '$|$';
  const cursorIdx = snippet.indexOf(CURSOR);
  const finalText = cursorIdx >= 0 ? snippet.replace(CURSOR, '') : snippet;
  const sel = view.state.selection.main;
  // Add a leading newline if not already at the start of a line, for block-level snippets.
  const needsLeadingBreak = snippet.startsWith('\n') && sel.from > 0 &&
    view.state.doc.sliceString(sel.from - 1, sel.from) !== '\n';
  const insertText = needsLeadingBreak ? '\n' + finalText : finalText;
  const adjust = needsLeadingBreak ? 1 : 0;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: insertText },
    selection: {
      anchor: cursorIdx >= 0 ? sel.from + cursorIdx + adjust : sel.from + insertText.length,
    },
  });
  view.focus();
}

defineExpose({ gotoLine, insertImageFromPath, getViewLine, scrollToLine, insertMarkdown });

const cls = computed(() => ({
  'cm-host': true,
  'cm-host--dark': settings.theme === 'dark',
}));
</script>

<template>
  <div v-if="!usePlainWindowsEditor" :class="cls" ref="host"></div>
  <div v-else-if="plainLiveEnabled" ref="plainLiveHost" :class="[cls, 'plain-block-editor']" :style="plainEditorStyle">
    <div
      v-for="(block, index) in plainBlocks"
      :key="block.id"
      class="plain-block"
      :class="{ 'plain-block--active': index === plainActiveBlock }"
      @click="(event) => activatePlainBlockFromClick(index, event)"
    >
      <textarea
        v-if="index === plainActiveBlock"
        :ref="(el) => setPlainBlockEditor(index, el as HTMLTextAreaElement | null)"
        class="plain-block__textarea"
        spellcheck="false"
        wrap="off"
        @input="(event) => handlePlainBlockInput(index, event)"
        @compositionstart="handlePlainBlockCompositionStart"
        @compositionend="(event) => handlePlainBlockCompositionEnd(index, event)"
        @click.stop
        @keyup="emitPlainCursorAndSelection"
        @mouseup="emitPlainCursorAndSelection"
        @select="emitPlainCursorAndSelection"
        @focus="emitPlainCursorAndSelection"
      ></textarea>
      <div
        v-else
        class="plain-block__render"
        v-html="block.html"
      ></div>
    </div>
  </div>
  <div v-else :class="cls" :style="plainEditorStyle">
    <textarea
      ref="plainEditor"
      class="plain-editor"
      spellcheck="false"
      wrap="off"
      @input="handlePlainInput"
      @keyup="emitPlainCursorAndSelection"
      @mouseup="emitPlainCursorAndSelection"
      @select="emitPlainCursorAndSelection"
      @focus="emitPlainCursorAndSelection"
    ></textarea>
  </div>
</template>

<style scoped>
.cm-host {
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--bg);
}
:deep(.cm-editor) {
  height: 100%;
  outline: none;
}
:deep(.cm-editor.cm-focused) {
  outline: none;
}
.plain-editor {
  height: 100%;
  width: 100%;
  resize: none;
  border: 0;
  outline: none;
  box-sizing: border-box;
  padding: 12px 16px;
  background: var(--bg);
  color: var(--text);
  font-family: var(--plain-editor-font-family, var(--font-editor, var(--font-mono)));
  font-size: var(--plain-editor-font-size, 14px);
  line-height: 1.6;
  tab-size: 2;
  white-space: pre;
  overflow: auto;
}
.plain-block-editor {
  overflow: auto;
  padding: 12px 16px 80px;
  box-sizing: border-box;
  font-family: var(--plain-editor-font-family, var(--font-editor, var(--font-mono)));
  font-size: var(--plain-editor-font-size, 14px);
  line-height: 1.6;
}
.plain-block {
  position: relative;
  min-height: 1.6em;
  padding: 1px 0;
}
.plain-block--active {
  background: var(--bg);
}
.plain-block__textarea {
  display: block;
  width: 100%;
  min-height: 1.6em;
  resize: none;
  border: 0;
  outline: none;
  box-sizing: border-box;
  padding: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  caret-color: var(--accent);
  font: inherit;
  line-height: inherit;
  tab-size: 2;
  white-space: pre;
}
.plain-block__textarea::selection {
  background: rgba(255, 159, 64, 0.28);
}
.plain-block__render {
  color: var(--text);
  overflow: visible;
  font-family: var(--font-ui);
  font-size: var(--plain-preview-font-size, 15px);
  line-height: 1.7;
  padding: 0.05em 0;
}
.plain-block__render :deep(h1),
.plain-block__render :deep(h2),
.plain-block__render :deep(h3),
.plain-block__render :deep(h4) {
  font-weight: 700;
  line-height: 1.25;
  margin: 1.1em 0 0.45em;
}
.plain-block__render :deep(h1),
.plain-block__render :deep(h2) {
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.25em;
}
.plain-block__render :deep(h1) {
  font-size: 2em;
}
.plain-block__render :deep(h2) {
  font-size: 1.5em;
}
.plain-block__render :deep(h3) {
  font-size: 1.2em;
}
.plain-block__render :deep(p),
.plain-block__render :deep(ul),
.plain-block__render :deep(ol),
.plain-block__render :deep(blockquote),
.plain-block__render :deep(pre),
.plain-block__render :deep(table) {
  margin-top: 0;
  margin-bottom: 0.8em;
}
.plain-block__render :deep(p) {
  white-space: pre-wrap;
}
.plain-block__render :deep(a) {
  color: var(--accent);
  text-decoration: none;
}
.plain-block__render :deep(a:hover) {
  text-decoration: underline;
}
.plain-block__render :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--bg-hover);
  padding: 0.15em 0.4em;
  border-radius: 4px;
}
.plain-block__render :deep(pre) {
  font-family: var(--font-mono);
  background: var(--bg-hover);
  padding: 14px 16px;
  border-radius: 6px;
  overflow-x: auto;
}
.plain-block__render :deep(pre code) {
  display: block;
  background: transparent;
  padding: 0;
}
.plain-block__render :deep(blockquote) {
  border-left: 3px solid var(--accent);
  padding: 0.2em 1em;
  color: var(--text-muted);
}
.plain-block__render :deep(ul),
.plain-block__render :deep(ol) {
  padding-left: 1.6em;
}
.plain-block__render :deep(table) {
  border-collapse: collapse;
  max-width: 100%;
}
.plain-block__render :deep(th),
.plain-block__render :deep(td) {
  border: 1px solid var(--border);
  padding: 6px 12px;
}
.plain-block__render :deep(thead th) {
  background: var(--bg-soft);
  font-weight: 600;
}
.plain-block__render :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1.6em 0;
}
.plain-block__render :deep(img) {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}
.plain-block__render :deep(.katex-display) {
  overflow-x: auto;
  overflow-y: hidden;
  margin: 1em 0;
  text-align: center;
}
.plain-block__render :deep(.plain-mermaid-block),
.plain-block__render :deep(.plain-whiteboard-block) {
  margin: 1em 0;
  max-width: 100%;
  overflow: auto;
}
.plain-block__render :deep(.plain-mermaid-block svg),
.plain-block__render :deep(.plain-whiteboard-block svg) {
  max-width: 100%;
  height: auto;
}
.plain-block__render :deep(.plain-whiteboard-block) {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
}
.plain-block__render :deep(.plain-whiteboard-block--clickable) {
  cursor: pointer;
}
.plain-block__render :deep(.plain-block__broken) {
  color: var(--danger);
  white-space: pre-wrap;
}
</style>
