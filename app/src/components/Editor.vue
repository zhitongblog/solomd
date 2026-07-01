<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed, nextTick } from 'vue';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, search, openSearchPanel } from '@codemirror/search';
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
import { useToastsStore } from '../stores/toasts';
import type { Tab } from '../types';
import { livePreviewExtension, richHighlightOnly } from '../lib/cm-live-preview';
import { liveEditExtension } from '../lib/cm-live-render';
import { liveBlocksExtension, liveBlocksTheme, extractImageRoot } from '../lib/cm-live-blocks';
import { findTldrawFences, replaceBoardSnapshot } from '../lib/tldraw-board';
import { dragAwareExtension } from '../lib/cm-drag-aware';
import { imagePasteExtension, insertImageFromPath as cmInsertImageFromPath, handleTextareaImagePaste, type ImagePasteOptions } from '../lib/cm-image-paste';
import { resolveUploader, uploadImage, type ImageUploadSettings } from '../lib/image-upload';
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
import { installSvgImageFallbacks, rewriteImageUrls } from '../lib/image-resolve';
import { SLASH_BLOCKS, filterBlocks, expandSnippet } from '../lib/slash-blocks';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';

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
const workspaceIndex = useWorkspaceIndexStore();
const toasts = useToastsStore();
const { t } = useI18n();

/** Shared image paste/drop/insert options — file context + the configured
 *  image-host uploader (图床) + toast surface. Used by the CodeMirror paste
 *  extension, the plain-textarea paste path, and `insertImageFromPath`. */
function imagePasteOpts(): ImagePasteOptions {
  return {
    getFilePath: () => props.tab.filePath,
    getDocContent: () => props.tab.content,
    getAttachmentMode: () => settings.attachmentMode,
    getAssetsDirName: () => settings.assetsDirName,
    getCustomPath: () => settings.attachmentCustomPath,
    getUploader: (filename: string) =>
      resolveUploader(settings as unknown as ImageUploadSettings, filename),
    notify: (kind, key, params) => {
      const msg = t(key, params as Record<string, string | number>);
      if (kind === 'success') toasts.success(msg);
      else if (kind === 'error') toasts.error(msg);
      else toasts.info(msg);
    },
  };
}
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
// `?forcePlain` query flag forces the Windows plain-textarea editor on any OS —
// a dev/test hook so the Windows-only path can be exercised on macOS/Linux. It
// can only be set programmatically (the Tauri shell has no URL bar), so it is
// inert for real users.
const isWindows =
  (typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)) ||
  (typeof location !== 'undefined' && location.search.includes('forcePlain'));
// Windows uses the plain-textarea editor: WebView2 + contentEditable drops the
// first IME character and doubles CJK punctuation (worst on Sogou), and even
// freezing CodeMirror's decorations during composition does not fix it — the
// bug is in WebView2's contentEditable IME handling itself. A plain <textarea>
// relies on the browser's native IME path and avoids both. (Verified: a
// CodeMirror spike on Windows still ate the first char + doubled punctuation.)
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
  // A standalone thematic-break block ("---" / "***" / "___") would be misread
  // as a YAML front-matter fence when rendered in isolation (each block renders
  // on its own), producing an empty md-frontmatter element instead of a rule.
  // Emit the <hr> directly.
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(src)) return '<hr>';
  const root = extractMarkdownImageRoot(plainText.value || '');
  const key = `${props.tab.filePath || ''}\u0000${root}\u0000${src}`;
  const cached = plainRenderCache.get(key);
  if (cached != null) return cached;
  const html = rewriteImageUrls(
    // Drop `disabled` on task checkboxes so they can be clicked to toggle in the
    // preview (handled by activatePlainBlockFromClick → togglePlainTask).
    renderMarkdown(src || '\n', { breaks: true }).replace(
      /(<input class="task-list-item-checkbox" type="checkbox"[^>]*?)\s+disabled=""/g,
      '$1',
    ),
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
  installSvgImageFallbacks(hostEl);

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
    maybeTypewriterScroll();
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

// Typewriter mode: keep the active block vertically centred (matches the
// CodeMirror typewriterModeExtension).
function maybeTypewriterScroll() {
  if (!props.typewriterMode || !plainLiveEnabled.value) return;
  nextTick(() => {
    const host = plainLiveHost.value;
    const el = plainBlockEditors.value[plainActiveBlock.value];
    if (!host || !el) return;
    const hostRect = host.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const delta = elRect.top + elRect.height / 2 - (hostRect.top + hostRect.height / 2);
    if (Math.abs(delta) > 1) host.scrollTop += delta;
  });
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

function handlePlainPaste(event: ClipboardEvent) {
  // Clipboard image paste (Ctrl+V of a screenshot). Text paste falls through to
  // the textarea's native handling. plainInsertText records its own undo step.
  void handleTextareaImagePaste(event, imagePasteOpts(), (text) => plainInsertText(text));
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
  recordPlainHistory();
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

function focusPlainEditor() {
  // Plain editors don't take focus on their own (the CodeMirror path calls
  // view.focus()). Without this, a freshly opened/created document has focus on
  // <body> and keystrokes go nowhere until the user clicks the editor.
  nextTick(() => {
    const el = plainLiveEnabled.value
      ? plainBlockEditors.value[plainActiveBlock.value]
      : plainEditor.value;
    el?.focus();
  });
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
  if (!plainComposing) recordPlainHistory();
  plainText.value = el.value;
  tabs.setContent(props.tab.id, el.value);
  emitPlainCursorAndSelection();
  nextTick(syncPlainLiveScroll);
}

// ---- Plain editor: document-level undo/redo (the WebView2-safe textarea path
// has no CodeMirror history). Snapshots are the whole document + an absolute
// caret offset, with rapid edits coalesced into one step. ----
type PlainSnapshot = { content: string; caret: number };
const plainUndoStack: PlainSnapshot[] = [];
let plainRedoStack: PlainSnapshot[] = [];
let plainHistoryTs = 0;

function plainAbsoluteCaret(): number {
  if (plainLiveEnabled.value) {
    const el = plainBlockEditors.value[plainActiveBlock.value];
    const block = plainBlocks.value[plainActiveBlock.value];
    if (!el || !block) return plainText.value.length;
    return block.start + (el.selectionStart ?? 0);
  }
  const el = plainEditor.value;
  return el ? el.selectionStart ?? el.value.length : plainText.value.length;
}

function recordPlainHistory() {
  const now = Date.now();
  const top = plainUndoStack[plainUndoStack.length - 1];
  if (top && top.content === plainText.value) {
    plainHistoryTs = now;
    return;
  }
  // Coalesce bursts of typing into a single undo step.
  if (plainUndoStack.length && now - plainHistoryTs < 500) {
    plainHistoryTs = now;
    return;
  }
  plainUndoStack.push({ content: plainText.value, caret: plainAbsoluteCaret() });
  if (plainUndoStack.length > 300) plainUndoStack.shift();
  plainRedoStack = [];
  plainHistoryTs = now;
}

function applyPlainContent(content: string, caret: number) {
  plainText.value = content;
  tabs.setContent(props.tab.id, content);
  const safe = Math.max(0, Math.min(caret, content.length));
  if (!plainLiveEnabled.value) {
    nextTick(() => {
      const el = plainEditor.value;
      if (el) {
        if (el.value !== content) el.value = content;
        el.focus();
        el.setSelectionRange(safe, safe);
      }
      emitPlainCursorAndSelection();
    });
    return;
  }
  nextTick(() => plainSetCaret(safe));
}

function plainUndo() {
  if (!plainUndoStack.length) return;
  plainRedoStack.push({ content: plainText.value, caret: plainAbsoluteCaret() });
  const prev = plainUndoStack.pop() as PlainSnapshot;
  plainHistoryTs = 0;
  applyPlainContent(prev.content, prev.caret);
}

function plainRedo() {
  if (!plainRedoStack.length) return;
  plainUndoStack.push({ content: plainText.value, caret: plainAbsoluteCaret() });
  const next = plainRedoStack.pop() as PlainSnapshot;
  plainHistoryTs = 0;
  applyPlainContent(next.content, next.caret);
}

// ---- Plain editor: in-document find / replace (the textarea path has no
// CodeMirror search panel). Matches are computed over the whole document;
// navigating selects the match in the right block. ----
const plainFindOpen = ref(false);
const plainFindQuery = ref('');
const plainReplaceValue = ref('');
const plainFindCaseSensitive = ref(false);
const plainFindInput = ref<HTMLInputElement | null>(null);
const plainMatches = ref<Array<{ start: number; end: number }>>([]);
const plainMatchIndex = ref(0);

function runPlainSearch() {
  const q = plainFindQuery.value;
  if (!q) {
    plainMatches.value = [];
    plainMatchIndex.value = 0;
    return;
  }
  const hay = plainFindCaseSensitive.value ? plainText.value : plainText.value.toLowerCase();
  const needle = plainFindCaseSensitive.value ? q : q.toLowerCase();
  const out: Array<{ start: number; end: number }> = [];
  let i = hay.indexOf(needle);
  while (i >= 0) {
    out.push({ start: i, end: i + q.length });
    i = hay.indexOf(needle, i + Math.max(1, q.length));
  }
  plainMatches.value = out;
  if (plainMatchIndex.value >= out.length) plainMatchIndex.value = 0;
}

function openPlainFind() {
  plainFindOpen.value = true;
  const selected = plainSelectionText();
  if (selected && !selected.includes('\n')) plainFindQuery.value = selected;
  nextTick(() => {
    plainFindInput.value?.focus();
    plainFindInput.value?.select();
    runPlainSearch();
    if (plainMatches.value.length) gotoPlainMatch(0);
  });
}

function closePlainFind() {
  plainFindOpen.value = false;
}

function selectPlainRange(start: number, end: number) {
  if (plainLiveEnabled.value) {
    const blocks = plainBlocks.value;
    const bi = blocks.findIndex((b) => start >= b.start && start < b.end);
    plainActiveBlock.value = bi < 0 ? Math.max(0, blocks.length - 1) : bi;
    nextTick(() => {
      const el = plainBlockEditors.value[plainActiveBlock.value];
      const b = plainBlocks.value[plainActiveBlock.value];
      if (!el || !b) return;
      el.focus();
      const s = Math.max(0, Math.min(start - b.start, el.value.length));
      const e = Math.max(s, Math.min(end - b.start, el.value.length));
      el.setSelectionRange(s, e);
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      emitPlainCursorAndSelection();
    });
    return;
  }
  const el = plainEditor.value;
  if (!el) return;
  el.focus();
  el.setSelectionRange(start, end);
  emitPlainCursorAndSelection();
}

function gotoPlainMatch(delta: number) {
  if (!plainMatches.value.length) {
    runPlainSearch();
    if (!plainMatches.value.length) return;
  }
  const n = plainMatches.value.length;
  plainMatchIndex.value = ((plainMatchIndex.value + delta) % n + n) % n;
  const m = plainMatches.value[plainMatchIndex.value];
  if (m) selectPlainRange(m.start, m.end);
}

function replacePlainCurrent() {
  const m = plainMatches.value[plainMatchIndex.value];
  if (!m) return;
  recordPlainHistory();
  const r = plainReplaceValue.value;
  const next = plainText.value.slice(0, m.start) + r + plainText.value.slice(m.end);
  applyPlainContent(next, m.start + r.length);
  nextTick(() => {
    runPlainSearch();
    if (plainMatches.value.length) {
      if (plainMatchIndex.value >= plainMatches.value.length) plainMatchIndex.value = 0;
      const nm = plainMatches.value[plainMatchIndex.value];
      if (nm) selectPlainRange(nm.start, nm.end);
    }
  });
}

function replacePlainAll() {
  if (!plainFindQuery.value || !plainMatches.value.length) return;
  recordPlainHistory();
  const r = plainReplaceValue.value;
  let result = '';
  let last = 0;
  for (const m of plainMatches.value) {
    result += plainText.value.slice(last, m.start) + r;
    last = m.end;
  }
  result += plainText.value.slice(last);
  applyPlainContent(result, result.length);
  nextTick(runPlainSearch);
}

// ---- Plain editor: autocomplete popup (/ slash commands, [[ wikilinks,
// # tags, @ citations). Triggers as you type; ↑/↓ navigate, Enter/Tab insert,
// Esc dismisses. Reuses the same data the CodeMirror editor uses. ----
type AcKind = 'slash' | 'wikilink' | 'tag' | 'citation';
interface AcItem { label: string; hint?: string; insert: string; cursorOffset: number }
const acOpen = ref(false);
const acItems = ref<AcItem[]>([]);
const acIndex = ref(0);
const acPos = ref<{ left: number; top: number }>({ left: 0, top: 0 });
let acTriggerStart = -1;

function closePlainAutocomplete() {
  acOpen.value = false;
  acItems.value = [];
  acTriggerStart = -1;
}

function baseNoteName(path: string): string {
  return (path.split(/[\\/]/).pop() || path).replace(/\.md$/i, '');
}

function buildAcItems(kind: AcKind, query: string): AcItem[] {
  const q = query.toLowerCase();
  if (kind === 'slash') {
    return filterBlocks(SLASH_BLOCKS, query).slice(0, 8).map((b) => {
      const ex = expandSnippet(b.snippet, '');
      return { label: b.label, hint: b.hint, insert: ex.text, cursorOffset: ex.cursorOffset };
    });
  }
  if (kind === 'wikilink') {
    return (workspaceIndex.entries || [])
      .map((e) => e.title || baseNoteName(e.path))
      .filter((n) => n && n.toLowerCase().includes(q))
      .slice(0, 8)
      .map((n) => ({ label: n, hint: 'wiki', insert: `[[${n}]]`, cursorOffset: n.length + 4 }));
  }
  if (kind === 'tag') {
    return (workspaceIndex.tags || [])
      .filter((t) => t.tag.toLowerCase().includes(q))
      .slice(0, 8)
      .map((t) => ({ label: `#${t.tag}`, hint: String(t.count), insert: `#${t.tag} `, cursorOffset: t.tag.length + 2 }));
  }
  // citation
  return cachedCitations
    .filter((c) => (c.key || '').toLowerCase().includes(q))
    .slice(0, 8)
    .map((c) => ({ label: `@${c.key}`, hint: (c.title ? String(c.title).slice(0, 32) : ''), insert: `@${c.key} `, cursorOffset: c.key.length + 2 }));
}

function caretRectFromHighlight(_caret: number): { left: number; bottom: number } | null {
  // Anchor the autocomplete popup to the active block's textarea (bottom-left).
  // A textarea can't give per-caret pixel coords without a mirror element, and
  // blocks are short, so anchoring below the block is accurate enough.
  const el = plainBlockEditors.value[plainActiveBlock.value];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, bottom: r.top + Math.min(r.height, 24) };
}

function maybeOpenPlainAutocomplete(el: HTMLTextAreaElement) {
  if (plainComposing) return;
  const caret = el.selectionStart ?? 0;
  const before = el.value.slice(0, caret);
  let kind: AcKind | null = null;
  let query = '';
  let m: RegExpMatchArray | null;
  if ((m = before.match(/(?:^|\n)[ \t]*\/([^\s/]*)$/))) { kind = 'slash'; query = m[1]; acTriggerStart = caret - m[1].length - 1; }
  else if ((m = before.match(/\[\[([^\]\n]*)$/))) { kind = 'wikilink'; query = m[1]; acTriggerStart = caret - m[1].length - 2; }
  else if ((m = before.match(/(?:^|[\s(])#([^\s#]*)$/))) { kind = 'tag'; query = m[1]; acTriggerStart = caret - m[1].length - 1; }
  else if ((m = before.match(/(?:^|[\s(])@([^\s@]*)$/))) { kind = 'citation'; query = m[1]; acTriggerStart = caret - m[1].length - 1; }
  if (!kind) { closePlainAutocomplete(); return; }
  const items = buildAcItems(kind, query);
  if (!items.length) { closePlainAutocomplete(); return; }
  acItems.value = items;
  acIndex.value = 0;
  acOpen.value = true;
  nextTick(() => {
    const rect = caretRectFromHighlight(acTriggerStart);
    if (rect) acPos.value = { left: Math.round(rect.left), top: Math.round(rect.bottom + 4) };
  });
}

function applyPlainAutocomplete(item: AcItem) {
  const el = plainBlockEditors.value[plainActiveBlock.value];
  if (!el || acTriggerStart < 0) { closePlainAutocomplete(); return; }
  const index = plainActiveBlock.value;
  const caret = el.selectionStart ?? el.value.length;
  const start = acTriggerStart;
  const value = el.value.slice(0, start) + item.insert + el.value.slice(caret);
  const newCaret = start + item.cursorOffset;
  closePlainAutocomplete();
  updatePlainBlock(index, value, newCaret);
  nextTick(() => {
    const e2 = plainBlockEditors.value[plainActiveBlock.value];
    if (e2) {
      e2.focus();
      const p = Math.min(newCaret, e2.value.length);
      e2.setSelectionRange(p, p);
    }
  });
}

/** Returns true if the keydown was consumed by the autocomplete popup. */
function handleAutocompleteKeydown(event: KeyboardEvent): boolean {
  if (!acOpen.value || !acItems.value.length) return false;
  if (event.key === 'ArrowDown') { event.preventDefault(); acIndex.value = (acIndex.value + 1) % acItems.value.length; return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); acIndex.value = (acIndex.value - 1 + acItems.value.length) % acItems.value.length; return true; }
  if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); applyPlainAutocomplete(acItems.value[acIndex.value]); return true; }
  if (event.key === 'Escape') { event.preventDefault(); closePlainAutocomplete(); return true; }
  return false;
}

/** Compute a Tab/Shift+Tab indent edit over the textarea's current selection. */
function computePlainTabEdit(
  el: HTMLTextAreaElement,
  outdent: boolean,
): { value: string; selStart: number; selEnd: number } {
  const INDENT = '  ';
  const v = el.value;
  const s = el.selectionStart ?? 0;
  const e = el.selectionEnd ?? 0;
  if (!outdent && s === e) {
    return { value: v.slice(0, s) + INDENT + v.slice(e), selStart: s + INDENT.length, selEnd: s + INDENT.length };
  }
  const lineStart = v.lastIndexOf('\n', s - 1) + 1;
  const nl = v.indexOf('\n', e);
  const lineEnd = nl < 0 ? v.length : nl;
  const region = v.slice(lineStart, lineEnd);
  const lines = region.split('\n');
  let deltaFirst = 0;
  let deltaTotal = 0;
  const newLines = lines.map((ln, i) => {
    if (outdent) {
      const m = ln.match(/^( {1,2}|\t)/);
      const removed = m ? m[0].length : 0;
      if (i === 0) deltaFirst = -removed;
      deltaTotal -= removed;
      return ln.slice(removed);
    }
    if (i === 0) deltaFirst = INDENT.length;
    deltaTotal += INDENT.length;
    return INDENT + ln;
  });
  const value = v.slice(0, lineStart) + newLines.join('\n') + v.slice(lineEnd);
  const selStart = Math.max(lineStart, s + deltaFirst);
  const selEnd = Math.max(selStart, e + deltaTotal);
  return { value, selStart, selEnd };
}

/** Shared keydown handling (undo/redo, Tab indent) for the plain editors. */
function handlePlainKeydownShared(event: KeyboardEvent): boolean {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.altKey && (event.key === 'f' || event.key === 'F')) {
    event.preventDefault();
    openPlainFind();
    return true;
  }
  if (mod && !event.altKey && (event.key === 'z' || event.key === 'Z')) {
    event.preventDefault();
    if (event.shiftKey) plainRedo();
    else plainUndo();
    return true;
  }
  if (mod && !event.altKey && (event.key === 'y' || event.key === 'Y')) {
    event.preventDefault();
    plainRedo();
    return true;
  }
  // Ctrl/Cmd+J — AI rewrite of the selection (matches cm-ai-rewrite). The
  // overlay + accept path are shared with the CodeMirror editor; accept replaces
  // the (retained) selection via the insert-markdown channel.
  if (!IS_APP_STORE_BUILD && mod && !event.altKey && (event.key === 'j' || event.key === 'J')) {
    const sel = plainAbsoluteSelection();
    const text = plainSelectionText();
    if (sel && text) {
      event.preventDefault();
      window.dispatchEvent(
        new CustomEvent('solomd:ai-rewrite-open', { detail: { selection: text, from: sel.from, to: sel.to } }),
      );
      return true;
    }
  }
  return false;
}

function plainAbsoluteSelection(): { from: number; to: number } | null {
  if (plainLiveEnabled.value) {
    const el = plainBlockEditors.value[plainActiveBlock.value];
    const block = plainBlocks.value[plainActiveBlock.value];
    if (!el || !block) return null;
    return { from: block.start + (el.selectionStart ?? 0), to: block.start + (el.selectionEnd ?? 0) };
  }
  const el = plainEditor.value;
  if (!el) return null;
  return { from: el.selectionStart ?? 0, to: el.selectionEnd ?? 0 };
}

/**
 * Markdown list / quote continuation on Enter (matches CodeMirror's behaviour):
 * Enter at the end of a list/quote item starts the next item (ordered numbers
 * increment); Enter on an empty item removes the marker and ends the list.
 * Returns the new {value, caret} or null to let the textarea handle Enter.
 */
function computeSmartEnter(el: HTMLTextAreaElement): { value: string; caret: number } | null {
  if (el.selectionStart !== el.selectionEnd) return null;
  const v = el.value;
  const caret = el.selectionStart ?? 0;
  const lineStart = v.lastIndexOf('\n', caret - 1) + 1;
  const nl = v.indexOf('\n', caret);
  const lineEnd = nl < 0 ? v.length : nl;
  const line = v.slice(lineStart, lineEnd);

  const ul = line.match(/^(\s*)([-*+])\s+(\[[ xX]\]\s+)?(.*)$/);
  const ol = line.match(/^(\s*)(\d+)([.)])\s+(.*)$/);
  const bq = line.match(/^(\s*)(>)\s?(.*)$/);
  let marker: string | null = null;
  let content = '';
  if (ul) { marker = `${ul[1]}${ul[2]} ${ul[3] ? '[ ] ' : ''}`; content = ul[4]; }
  else if (ol) { marker = `${ol[1]}${Number(ol[2]) + 1}${ol[3]} `; content = ol[4]; }
  else if (bq) { marker = `${bq[1]}> `; content = bq[3]; }
  if (marker === null) return null;

  // Empty item → remove the marker (end the list), leaving a blank line.
  if (content.trim() === '') {
    return { value: v.slice(0, lineStart) + v.slice(caret), caret: lineStart };
  }
  // Continue the list/quote with a fresh marker.
  const insert = `\n${marker}`;
  return { value: v.slice(0, caret) + insert + v.slice(caret), caret: caret + insert.length };
}

function handlePlainBlockKeydown(index: number, event: KeyboardEvent) {
  if (plainComposing) return;
  if (handleAutocompleteKeydown(event)) return;
  if (handlePlainKeydownShared(event)) return;
  // Block-boundary Backspace / Delete. Each block is a standalone <textarea>, so
  // native Backspace at offset 0 (or Delete at the end) can't reach the
  // neighbouring block — it silently no-ops at every block edge, which users
  // experience as Backspace/Delete "时灵时不灵". We fold the deletion onto the
  // full source instead: deleting the single separator char before/after the
  // block transparently removes a blank line or joins two paragraphs, exactly
  // as a single whole-document <textarea> would. (Plain key only — let the
  // browser keep word-delete / selection-delete.)
  if (
    (event.key === 'Backspace' || event.key === 'Delete') &&
    !event.ctrlKey && !event.metaKey && !event.altKey
  ) {
    const el = event.target as HTMLTextAreaElement;
    const block = plainBlocks.value[index];
    const selStart = el.selectionStart ?? 0;
    const selEnd = el.selectionEnd ?? 0;
    if (block && selStart === selEnd) {
      if (event.key === 'Backspace' && selStart === 0 && block.start > 0) {
        event.preventDefault();
        const delAt = block.start - 1; // the separator/char before this block
        applyPlainFullEdit(
          plainText.value.slice(0, delAt) + plainText.value.slice(delAt + 1),
          delAt,
        );
        return;
      }
      if (event.key === 'Delete' && selStart === el.value.length) {
        const delAt = block.start + el.value.length; // separator after visible text
        if (delAt < plainText.value.length) {
          event.preventDefault();
          applyPlainFullEdit(
            plainText.value.slice(0, delAt) + plainText.value.slice(delAt + 1),
            delAt,
          );
          return;
        }
      }
    }
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    const el = event.target as HTMLTextAreaElement;
    const edit = computePlainTabEdit(el, event.shiftKey);
    updatePlainBlock(index, edit.value, edit.selStart);
    // updatePlainBlock's fast path may skip caret restore (block text unchanged
    // in length-mapping terms); force the selection so the caret follows the
    // indent and a range stays selected for repeated Tab.
    nextTick(() => {
      const e2 = plainBlockEditors.value[plainActiveBlock.value];
      if (e2) {
        e2.focus();
        e2.setSelectionRange(edit.selStart, edit.selEnd);
      }
    });
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const el = event.target as HTMLTextAreaElement;
    const smart = computeSmartEnter(el);
    if (smart) {
      event.preventDefault();
      updatePlainBlock(index, smart.value, smart.caret);
      nextTick(() => {
        const e2 = plainBlockEditors.value[plainActiveBlock.value];
        if (e2) {
          e2.focus();
          const p = Math.min(smart.caret, e2.value.length);
          e2.setSelectionRange(p, p);
        }
      });
    }
  }
}

function handlePlainEditorKeydown(event: KeyboardEvent) {
  if (plainComposing) return;
  if (handlePlainKeydownShared(event)) return;
  if (event.key === 'Tab') {
    event.preventDefault();
    const el = event.target as HTMLTextAreaElement;
    const edit = computePlainTabEdit(el, event.shiftKey);
    recordPlainHistory();
    el.value = edit.value;
    el.setSelectionRange(edit.selStart, edit.selEnd);
    plainText.value = edit.value;
    tabs.setContent(props.tab.id, edit.value);
    emitPlainCursorAndSelection();
  }
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
  // Clicking a rendered task checkbox toggles its source marker instead of
  // entering edit mode.
  const target = event.target as HTMLElement | null;
  if (
    target instanceof HTMLInputElement &&
    target.type === 'checkbox' &&
    target.classList.contains('task-list-item-checkbox')
  ) {
    const render = (event.currentTarget as HTMLElement).querySelector('.plain-block__render');
    const boxes = render
      ? Array.from(render.querySelectorAll('input.task-list-item-checkbox'))
      : [];
    const ordinal = boxes.indexOf(target);
    event.preventDefault();
    if (ordinal >= 0) togglePlainTask(index, ordinal);
    return;
  }
  if (index === plainActiveBlock.value) return;
  activatePlainBlock(index, estimatePlainBlockCaretFromClick(index, event));
}

/** Flip the `ordinal`-th task checkbox marker in a block's source, in place. */
function togglePlainTask(index: number, ordinal: number) {
  const block = plainBlocks.value[index];
  if (!block) return;
  let n = -1;
  const re = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/gm;
  const newText = block.text.replace(re, (m, pre, mark, post) => {
    n += 1;
    if (n !== ordinal) return m;
    return `${pre}${mark === ' ' ? 'x' : ' '}${post}`;
  });
  if (newText === block.text) return;
  recordPlainHistory();
  const tail = block.hasTrailingNewline ? '\n' : '';
  const next =
    plainText.value.slice(0, block.start) + newText + tail + plainText.value.slice(block.end);
  plainText.value = next;
  tabs.setContent(props.tab.id, next);
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
  maybeOpenPlainAutocomplete(el);
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

/**
 * Apply an edit expressed against the FULL document source (not a single block)
 * and restore the caret at an absolute offset. Used by block-boundary
 * Backspace / Delete, where the deletion crosses a block separator and so can't
 * be modelled as a single-block `updatePlainBlock`. Mirrors updatePlainBlock's
 * re-split + caret-restore tail so the active <textarea> follows the caret.
 */
function applyPlainFullEdit(next: string, absoluteCaret: number) {
  if (!plainComposing) recordPlainHistory();
  plainText.value = next;
  tabs.setContent(props.tab.id, next);
  const nextBlocks = splitPlainMarkdownBlocks(next);
  let found = nextBlocks.findIndex(
    (candidate) => absoluteCaret >= candidate.start && absoluteCaret < candidate.end,
  );
  if (found < 0) found = nextBlocks.length - 1;
  plainActiveBlock.value = found;
  nextTick(() => {
    const activeBlock = plainBlocks.value[plainActiveBlock.value];
    const el = plainBlockEditors.value[plainActiveBlock.value];
    if (!el) return;
    if (document.activeElement !== el) el.focus();
    autoSizePlainBlock(el);
    if (activeBlock) {
      const pos = Math.max(0, Math.min(absoluteCaret - activeBlock.start, el.value.length));
      el.setSelectionRange(pos, pos);
    }
    emitPlainCursorAndSelection();
  });
}

function updatePlainBlock(index: number, text: string, caret?: number) {
  const block = plainBlocks.value[index];
  if (!block) return;
  // Snapshot the pre-edit document for undo (coalesced) before we mutate it.
  if (!plainComposing) recordPlainHistory();
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
    imagePasteExtension(imagePasteOpts()),
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
    focusPlainEditor();
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

/**
 * #137 — open the find/replace UI. The panel already exists on both editor
 * paths (CodeMirror's search panel + the plain-textarea find bar) behind
 * Ctrl+F, but had no toolbar / command-palette entry, so users thought it was
 * gone. PaneContent forwards `solomd:editor-find` here for the focused pane.
 */
function openFind(): void {
  if (usePlainWindowsEditor) {
    openPlainFind();
    return;
  }
  if (view) {
    view.focus();
    openSearchPanel(view);
  }
}

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
    if (usePlainWindowsEditor) {
      // The Editor component is reused across tabs (no :key), so switching to /
      // creating a document must re-sync content, reset per-document state, and
      // re-focus — otherwise the new doc shows stale text and can't be typed in.
      plainActiveBlock.value = 0;
      plainUndoStack.length = 0;
      plainRedoStack = [];
      plainHistoryTs = 0;
      closePlainFind();
      syncPlainEditorFromStore(props.tab.content);
      maybeRestoreSession();
      void processPlainLiveRenderedBlocks();
      focusPlainEditor();
      return;
    }
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
  await cmInsertImageFromPath(view, srcPath, imagePasteOpts());
}

/** Insert a markdown image link for a user-supplied URL (网络图片) at the
 *  cursor — no upload, no local copy. Used by the "Image from URL…" dialog. */
function insertImageUrl(url: string, alt = ''): void {
  const clean = (url || '').trim();
  if (!clean) return;
  if (usePlainWindowsEditor) {
    plainInsertText(`![${alt}](${clean})`);
    return;
  }
  if (!view) return;
  insertMarkdown(`![${alt}](${clean})`);
}

/**
 * Upload every *local* image referenced in the current document to the
 * configured image host and rewrite each link to the hosted URL. Skips links
 * that are already remote (http/https/data). Reports progress + a final count
 * via toasts. No-op (with a hint) when no uploader is configured.
 */
async function uploadLocalImages(): Promise<void> {
  if (!view) return;
  const up0 = resolveUploader(settings as unknown as ImageUploadSettings, 'x.png');
  if (settings.imageUploader === 'none' || !up0) {
    toasts.info(t('toast.noUploaderConfigured'));
    return;
  }
  const doc = view.state.doc.toString();
  // Match markdown image links with a local (non-remote) src.
  const re = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const targets: { src: string }[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc))) {
    const src = m[1];
    if (/^(https?:|data:)/i.test(src)) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    targets.push({ src });
  }
  if (targets.length === 0) {
    toasts.info(t('toast.noLocalImages'));
    return;
  }
  let done = 0;
  let uploaded = 0;
  for (const tgt of targets) {
    done++;
    toasts.info(t('toast.uploadingProgress', { done, total: targets.length }));
    try {
      const abs = await resolveLocalImageAbsPath(tgt.src);
      if (!abs) continue;
      const filename = abs.split(/[\\/]/).pop() || 'image.png';
      const resolved = resolveUploader(settings as unknown as ImageUploadSettings, filename);
      if (!resolved) break;
      const url = await uploadImage(resolved.cfg, abs);
      // Replace every occurrence of this exact src in the live doc.
      replaceAllImageSrc(tgt.src, url);
      uploaded++;
    } catch (err) {
      console.error('[Editor] uploadLocalImages failed for', tgt.src, err);
    }
  }
  if (uploaded > 0) toasts.success(t('toast.uploadedCount', { n: uploaded }));
  else toasts.error(t('toast.imageUploadFailedShort'));
}

/** Resolve a markdown image src (relative / imageRoot / absolute) to an
 *  absolute filesystem path for upload. */
async function resolveLocalImageAbsPath(src: string): Promise<string | null> {
  const { resolveImagePath } = await import('../lib/image-resolve');
  const imageRoot = parseFrontMatterImageRoot(props.tab.content) ?? null;
  const abs = resolveImagePath(decodeURIComponent(src), imageRoot, props.tab.filePath);
  return abs || null;
}

/** Replace every `](oldSrc)` occurrence in the live doc with the new URL. */
function replaceAllImageSrc(oldSrc: string, newUrl: string): void {
  if (!view) return;
  const doc = view.state.doc.toString();
  const changes: { from: number; to: number; insert: string }[] = [];
  const needle = `](${oldSrc})`;
  let idx = doc.indexOf(needle);
  while (idx >= 0) {
    const from = idx + 2; // after `](`
    const to = idx + 2 + oldSrc.length;
    changes.push({ from, to, insert: newUrl });
    idx = doc.indexOf(needle, idx + needle.length);
  }
  if (changes.length) view.dispatch({ changes });
}

/** Minimal front-matter `imageRoot` reader (mirror of the paste helper). */
function parseFrontMatterImageRoot(source: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!fm) return undefined;
  const im = /^(?:imageRoot|image_root|typora-root-url)\s*:\s*(.+?)\s*$/m.exec(fm[1]);
  return im ? im[1].replace(/^["']|["']$/g, '').trim() || undefined : undefined;
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

defineExpose({ gotoLine, insertImageFromPath, insertImageUrl, uploadLocalImages, getViewLine, scrollToLine, insertMarkdown, openFind });

const cls = computed(() => ({
  'cm-host': true,
  'cm-host--dark': settings.theme === 'dark',
  // #109 — constrain the editing column to a centered readable width.
  'cm-host--limit-width': settings.limitEditorWidth,
}));
</script>

<template>
  <div v-if="!usePlainWindowsEditor" :class="cls" ref="host"></div>
  <div v-else class="plain-host">
    <div v-if="plainLiveEnabled" ref="plainLiveHost" :class="[cls, 'plain-block-editor']" :style="plainEditorStyle">
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
          :class="{ 'plain-textarea--wrap': settings.wordWrap }"
          :spellcheck="props.spellCheck"
          :wrap="settings.wordWrap ? 'soft' : 'off'"
          @keydown="(event) => handlePlainBlockKeydown(index, event)"
          @paste="handlePlainPaste"
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
        :class="{ 'plain-textarea--wrap': settings.wordWrap }"
        :spellcheck="props.spellCheck"
        :wrap="settings.wordWrap ? 'soft' : 'off'"
        @keydown="handlePlainEditorKeydown"
        @paste="handlePlainPaste"
        @input="handlePlainInput"
        @keyup="emitPlainCursorAndSelection"
        @mouseup="emitPlainCursorAndSelection"
        @select="emitPlainCursorAndSelection"
        @focus="emitPlainCursorAndSelection"
      ></textarea>
    </div>

    <!-- In-document find / replace (Ctrl+F). The textarea path has no CodeMirror
         search panel, so this provides one. -->
    <div v-if="plainFindOpen" class="plain-find" @keydown.esc.prevent.stop="closePlainFind">
      <div class="plain-find__row">
        <input
          ref="plainFindInput"
          class="plain-find__input"
          :value="plainFindQuery"
          placeholder="Find"
          @input="(e) => { plainFindQuery = (e.target as HTMLInputElement).value; runPlainSearch(); }"
          @keydown.enter.prevent="gotoPlainMatch(1)"
        />
        <span class="plain-find__count">{{ plainMatches.length ? (plainMatchIndex + 1) + '/' + plainMatches.length : '0/0' }}</span>
        <button class="plain-find__btn" title="Previous (Shift+Enter)" @click="gotoPlainMatch(-1)">‹</button>
        <button class="plain-find__btn" title="Next (Enter)" @click="gotoPlainMatch(1)">›</button>
        <button
          class="plain-find__btn"
          :class="{ 'plain-find__btn--on': plainFindCaseSensitive }"
          title="Match case"
          @click="plainFindCaseSensitive = !plainFindCaseSensitive; runPlainSearch()"
        >Aa</button>
        <button class="plain-find__btn" title="Close (Esc)" @click="closePlainFind">✕</button>
      </div>
      <div class="plain-find__row">
        <input
          class="plain-find__input"
          :value="plainReplaceValue"
          placeholder="Replace"
          @input="(e) => plainReplaceValue = (e.target as HTMLInputElement).value"
          @keydown.enter.prevent="replacePlainCurrent"
        />
        <button class="plain-find__btn plain-find__btn--text" @click="replacePlainCurrent">Replace</button>
        <button class="plain-find__btn plain-find__btn--text" @click="replacePlainAll">All</button>
      </div>
    </div>

    <!-- Autocomplete popup (/ slash, [[ wikilink, # tag, @ citation). -->
    <ul
      v-if="acOpen && acItems.length"
      class="plain-ac"
      :style="{ left: acPos.left + 'px', top: acPos.top + 'px' }"
    >
      <li
        v-for="(item, i) in acItems"
        :key="i"
        class="plain-ac__item"
        :class="{ 'plain-ac__item--active': i === acIndex }"
        @mousedown.prevent="applyPlainAutocomplete(item)"
        @mouseenter="acIndex = i"
      >
        <span class="plain-ac__label">{{ item.label }}</span>
        <span v-if="item.hint" class="plain-ac__hint">{{ item.hint }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.cm-host {
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--bg);
}
/* #109 — readable editing column. Centre the CodeMirror content (and the
   Windows plain-block editor) instead of letting long lines run full-bleed.
   Width matches the preview pane's readable column (760px) so editor and
   preview line up. */
.cm-host--limit-width :deep(.cm-content) {
  max-width: 760px;
  margin-left: auto;
  margin-right: auto;
}
.cm-host--limit-width.plain-block-editor :deep(.plain-block),
.cm-host--limit-width.plain-block-editor :deep(.plain-block__textarea),
.cm-host--limit-width :deep(.plain-editor) {
  max-width: 760px;
  margin-left: auto;
  margin-right: auto;
}
:deep(.cm-editor) {
  height: 100%;
  outline: none;
}
:deep(.cm-editor.cm-focused) {
  outline: none;
}
.plain-host {
  position: relative;
  height: 100%;
  width: 100%;
}
.plain-find {
  position: absolute;
  top: 8px;
  right: 16px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--bg-elevated, var(--bg));
  border: 1px solid var(--border, rgba(127, 127, 127, 0.35));
  border-radius: 8px;
  padding: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
}
.plain-find__row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.plain-find__input {
  width: 200px;
  padding: 4px 8px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.35));
  border-radius: 5px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.plain-find__input:focus {
  border-color: var(--accent, #ff9f40);
}
.plain-find__count {
  font-size: 12px;
  color: var(--text-faint, #888);
  min-width: 40px;
  text-align: center;
}
.plain-find__btn {
  min-width: 26px;
  height: 26px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.plain-find__btn:hover {
  background: var(--bg-hover, rgba(127, 127, 127, 0.15));
}
.plain-find__btn--on {
  color: var(--accent, #ff9f40);
  border-color: var(--accent, #ff9f40);
}
.plain-find__btn--text {
  font-size: 12px;
}
.plain-ac {
  position: fixed;
  z-index: 30;
  margin: 0;
  padding: 4px;
  list-style: none;
  min-width: 180px;
  max-width: 360px;
  max-height: 280px;
  overflow-y: auto;
  background: var(--bg-elevated, var(--bg));
  border: 1px solid var(--border, rgba(127, 127, 127, 0.35));
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
}
.plain-ac__item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 10px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text);
}
.plain-ac__item--active {
  background: var(--accent, #ff9f40);
  color: var(--accent-fg, #fff);
}
.plain-ac__hint {
  font-size: 11px;
  opacity: 0.7;
  white-space: nowrap;
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
.plain-editor.plain-textarea--wrap {
  white-space: pre-wrap;
  overflow-wrap: break-word;
  overflow-x: hidden;
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
.plain-block__textarea.plain-textarea--wrap {
  white-space: pre-wrap;
  overflow-wrap: break-word;
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
