<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed, nextTick } from 'vue';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, search, openSearchPanel, getSearchQuery, setSearchQuery } from '@codemirror/search';
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
import { vim, Vim } from '@replit/codemirror-vim';
import { cmThemeFor } from '../lib/themes';
import { registerPlainSelectionGetter } from '../lib/plain-selection';
import { caretRowInfo, caretTopPx, lastVisualRowStart, firstVisualRowEnd, measureLineHeights } from '../lib/textarea-metrics';
import { transformCase, nextCaseInCycle, caseTargetRange, type CaseMode } from '../lib/text-case';
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
import { plantumlSvgUrl } from '../lib/plantuml';
import { stableClickSelection } from '../lib/cm-stable-click';
import { installSvgImageFallbacks, rewriteImageUrls } from '../lib/image-resolve';
import { SLASH_BLOCKS, filterBlocks, expandSnippet } from '../lib/slash-blocks';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';
import { isWindowsEditorRuntime, shouldUsePlainWindowsEditor } from '../lib/platform';

// Incremental find. CoreMirror's search panel only scrolls to a match when you
// press Enter / click Next — typing in the field just repaints the highlights
// in place. On a long document the nearest match stays off-screen, so it looks
// like find "found nothing" even though it did (reported: "Ctrl+F 弹出来的搜索框
// 不会定位到文本所在的位置"). Browsers, VS Code and Typora all scroll to the first
// match as you type; this restores that. We only scroll the match into view —
// the editor selection is left untouched so we never fight the caret or an
// in-progress IME composition, and pressing Enter afterwards still walks matches
// from the current position exactly as before.
function firstMatch(query: ReturnType<typeof getSearchQuery>, view: EditorView, from: number) {
  // Nearest match at/after the cursor; wrap to the top if there's none below.
  const forward = query.getCursor(view.state, from).next();
  if (!forward.done) return forward.value;
  const wrapped = query.getCursor(view.state, 0, from).next();
  return wrapped.done ? null : wrapped.value;
}

const incrementalFindScroll = EditorView.updateListener.of((update) => {
  if (!update.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)))) return;
  const query = getSearchQuery(update.state);
  if (!query.valid || !query.search) return;
  const view = update.view;
  const match = firstMatch(query, view, view.state.selection.main.from);
  if (!match) return;
  // Dispatching synchronously from an updateListener is unsupported; defer a
  // frame and re-check the query hasn't changed under us in the meantime.
  requestAnimationFrame(() => {
    if (!getSearchQuery(view.state).eq(query)) return;
    view.dispatch({ effects: EditorView.scrollIntoView(match.from, { y: 'center' }) });
  });
});

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
let cleanupTransformCase: (() => void) | null = null;
let cleanupPlainSelection: (() => void) | null = null;
let contentSyncTimer: ReturnType<typeof setTimeout> | null = null;

const themeCompartment = new Compartment();
const langCompartment = new Compartment();
const wrapCompartment = new Compartment();
const lineNumCompartment = new Compartment();
const cursorCompartment = new Compartment();
const fontSizeCompartment = new Compartment();
const richCompartment = new Compartment();
const spellCheckCompartment = new Compartment();
const focusCompartment = new Compartment();
const typewriterCompartment = new Compartment();
const vimCompartment = new Compartment();
const slashCompartment = new Compartment();

// #222 — Vim's `:w` / `:wq` / `:q` were dead: @replit/codemirror-vim ships no
// Ex-command handlers (there is no file system in the browser), so typing `:w`
// just cleared the command line without saving. Route them through the same
// `solomd:menu-action` bus the menu bar and Ctrl+S use, so save / save-and-close
// / close honour the app's real save + unsaved-tab flow. Registered once on the
// global Vim singleton (idempotent guard — defineEx would otherwise stack).
if (!(globalThis as { __solomdVimEx?: boolean }).__solomdVimEx) {
  (globalThis as { __solomdVimEx?: boolean }).__solomdVimEx = true;
  const menu = (id: string) =>
    window.dispatchEvent(new CustomEvent('solomd:menu-action', { detail: id }));
  // `:w` / `:write` — save the active tab.
  Vim.defineEx('write', 'w', () => menu('file.save'));
  // `:wq` / `:x` / `:xit` — save, then close only once the save actually lands.
  // saveActive() is async, so closing synchronously would hit a still-dirty tab
  // and pop the unsaved-changes dialog; wait for the one-shot `solomd:saved`.
  const saveThenClose = () => {
    let timer = 0;
    const onSaved = () => {
      clearTimeout(timer);
      window.removeEventListener('solomd:saved', onSaved);
      menu('file.closeTab');
    };
    window.addEventListener('solomd:saved', onSaved);
    // If the save is cancelled (e.g. the Save-As dialog on an untitled buffer)
    // the `solomd:saved` never fires; drop the listener so it can't later close
    // an unrelated tab on the next save. 10s comfortably covers a real write.
    timer = window.setTimeout(() => window.removeEventListener('solomd:saved', onSaved), 10000);
    menu('file.save');
  };
  Vim.defineEx('wq', 'wq', saveThenClose);
  Vim.defineEx('xit', 'x', saveThenClose);
  // `:q` / `:quit` — close the tab (unsaved changes trigger the confirm dialog).
  Vim.defineEx('quit', 'q', () => menu('file.closeTab'));
}
// `?forcePlain` query flag forces the Windows plain-textarea editor on any OS —
// a dev/test hook so the Windows-only path can be exercised on macOS/Linux. It
// can only be set programmatically (the Tauri shell has no URL bar), so it is
// inert for real users.
const isWindows = isWindowsEditorRuntime();
// Windows normally uses the plain-textarea editor: WebView2 + contentEditable drops the
// first IME character and doubles CJK punctuation (worst on Sogou), and even
// freezing CodeMirror's decorations during composition does not fix it — the
// bug is in WebView2's contentEditable IME handling itself. A plain <textarea>
// relies on the browser's native IME path and avoids both. (Verified: a
// CodeMirror spike on Windows still ate the first char + doubled punctuation.)
// Vim emulation, however, is a CodeMirror extension and cannot run in the
// textarea fallback. Opting into Vim therefore explicitly opts into CodeMirror
// on Windows; PaneContent keys the editor by this setting so the switch happens
// immediately instead of requiring an app restart (#194).
const usePlainWindowsEditor = shouldUsePlainWindowsEditor(isWindows, settings.vimMode);

// Synchronous counterpart to the debounce below. `saveTab` broadcasts
// `solomd:flush-content-sync` right before reading `tab.content`, because a
// save landing inside the 350ms window would otherwise write a stale document
// — fatal for vim's `:wq` (#222), which closes the tab immediately after the
// save and silently drops the not-yet-synced tail of the edit. While an IME
// composition is in flight the timer is left armed instead (same reasoning as
// #186: never commit a half-composed doc).
function flushContentSync() {
  if (!contentSyncTimer || !view || view.composing) return;
  clearTimeout(contentSyncTimer);
  contentSyncTimer = null;
  tabs.setContent(props.tab.id, view.state.doc.toString());
}

function syncEditorContentSoon(text: string) {
  if (contentSyncTimer) clearTimeout(contentSyncTimer);
  contentSyncTimer = setTimeout(() => {
    contentSyncTimer = null;
    // #186 — read the doc at fire time, not schedule time. A snapshot taken
    // before an IME composition started is stale by the time this fires; the
    // external-content watcher would then "restore" it with a full-doc
    // replace, killing the composition and mapping the caret to offset 0
    // (the reported cursor-jumps-to-top). While composing, re-arm instead:
    // the candidate commit lands as a non-composing update and syncs then.
    if (view) {
      if (view.composing) {
        syncEditorContentSoon(text);
        return;
      }
      tabs.setContent(props.tab.id, view.state.doc.toString());
      return;
    }
    tabs.setContent(props.tab.id, text);
  }, 350);
}

const plainEditor = ref<HTMLTextAreaElement | null>(null);
const plainLiveHost = ref<HTMLDivElement | null>(null);
const plainBlockEditors = ref<Record<number, HTMLTextAreaElement | null>>({});
const plainText = ref(props.tab.content || '');
const plainActiveBlock = ref(0);
// Select-all in the block live editor (user feedback, 4.8.10): native Ctrl+A
// inside the active block's <textarea> can only reach that block, so "全选"
// was impossible in live edit. While this flag is on, plainBlocks collapses
// the document into a single active block (see the computed below).
const plainSelectAll = ref(false);
// Entry runs across a nextTick (mount the merged textarea, then select()).
// Events firing in between (the Ctrl+A keyup, the focus emit) see a collapsed
// selection and must not be mistaken for "user collapsed it — exit".
let plainSelectAllPending = false;
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

// #161 — line-number gutter for the plain-textarea path. CodeMirror's
// lineNumbers() never runs on Windows, so the 显示行号 setting silently did
// nothing there. Numbers get mirror-measured logical-line heights so they
// stay aligned under soft wrap, and the gutter follows the textarea's
// scrollTop via a translateY.
//
// #203 — the same measured heights also drive the split-view scroll sync
// (getViewLine / plainScrollToLine). The old `scrollTop ÷ line-height` math
// counted *visual* rows, so with soft wrap the two panes drifted apart more
// with every wrapped line — keep the metrics fresh whenever split mode needs
// them, not only when the gutter is visible.
const plainLineHeights = ref<number[]>([]);
const plainScrollTop = ref(0);
const plainMetricsEnabled = computed(
  () =>
    usePlainWindowsEditor &&
    !plainLiveEnabled.value &&
    (settings.showLineNumbers || settings.viewMode === 'split' || props.typewriterMode),
);
const plainGutterEnabled = computed(
  () => plainMetricsEnabled.value && settings.showLineNumbers,
);
const plainGutterWidth = computed(
  () => `${Math.max(String(plainLineHeights.value.length).length, 2)}ch`,
);
let plainGutterTimer: ReturnType<typeof setTimeout> | null = null;
let plainGutterRO: ResizeObserver | null = null;

function recomputePlainGutter() {
  if (!plainMetricsEnabled.value) return;
  const el = plainEditor.value;
  if (!el) return;
  try {
    plainLineHeights.value = measureLineHeights(el, plainText.value);
  } catch {
    plainLineHeights.value = [];
  }
}

function schedulePlainGutter() {
  if (!plainMetricsEnabled.value) return;
  if (plainGutterTimer) clearTimeout(plainGutterTimer);
  plainGutterTimer = setTimeout(() => {
    plainGutterTimer = null;
    recomputePlainGutter();
  }, 120);
}

function onPlainScroll(event: Event) {
  plainScrollTop.value = (event.target as HTMLTextAreaElement).scrollTop;
}

watch(
  [plainMetricsEnabled, plainEditor],
  async ([on]) => {
    plainGutterRO?.disconnect();
    plainGutterRO = null;
    if (!on) return;
    await nextTick();
    const el = plainEditor.value;
    if (!el) return;
    plainScrollTop.value = el.scrollTop;
    recomputePlainGutter();
    // Wrap width changes (window resize, sidebar toggle) re-flow soft wrap.
    plainGutterRO = new ResizeObserver(schedulePlainGutter);
    plainGutterRO.observe(el);
  },
  { immediate: true },
);
watch(plainText, schedulePlainGutter);
watch(
  () => [settings.wordWrap, settings.fontSize, settings.fontFamily],
  () => nextTick(schedulePlainGutter),
);
onBeforeUnmount(() => {
  plainGutterRO?.disconnect();
  if (plainGutterTimer) clearTimeout(plainGutterTimer);
});

const plainBlocks = computed<PlainBlock[]>(() => {
  if (!plainLiveEnabled.value) return [];
  // Select-all mode (user feedback, 4.8.10): the whole document is presented
  // as ONE active block so the <textarea>'s native selection can span it.
  // Every selection consumer then works untouched — Ctrl+C/X, Delete,
  // type-over, IME composition-over-selection (a WebView2 minefield we must
  // not reimplement), and the toolbar/⌘J AI-rewrite absolute offsets.
  if (plainSelectAll.value) {
    const src = plainText.value || '';
    return [{ id: 'select-all', start: 0, end: src.length, text: src, hasTrailingNewline: false, html: '' }];
  }
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
  // #141 — the hard-breaks flag is part of the cache key so toggling the
  // setting invalidates previously rendered blocks. The per-call `breaks`
  // override is gone: the shared md singleton now follows the setting, so
  // the live editor, preview pane and exports all agree.
  const key = `${settings.markdownHardBreaks ? 'hb' : 'sb'}${settings.markdownAutoNumberHeadings ? 'nh' : ''}\u0000${props.tab.filePath || ''}\u0000${root}\u0000${src}`;
  const cached = plainRenderCache.get(key);
  if (cached != null) return cached;
  const html = rewriteImageUrls(
    // Drop `disabled` on task checkboxes so they can be clicked to toggle in the
    // preview (handled by activatePlainBlockFromClick → togglePlainTask).
    renderMarkdown(src || '\n').replace(
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

  // v4.10 #163 — PlantUML fences (opt-in), same <img> swap as the preview pane.
  if (settings.plantumlEnabled && settings.plantumlServer) {
    const pumlBlocks = hostEl.querySelectorAll(
      '.plain-block__render pre > code.language-plantuml, .plain-block__render pre > code.language-puml',
    );
    for (const block of Array.from(pumlBlocks)) {
      const pre = block.parentElement as HTMLElement | null;
      if (!pre || pre.dataset.rendered === '1') continue;
      pre.dataset.rendered = '1';
      const code = (block.textContent || '').trim();
      const wrap = document.createElement('div');
      wrap.className = 'plain-plantuml-block';
      const img = document.createElement('img');
      img.alt = 'PlantUML diagram';
      img.src = plantumlSvgUrl(settings.plantumlServer, code);
      img.addEventListener('error', () => {
        wrap.classList.add('plain-block__broken');
        wrap.textContent = `PlantUML render failed (${settings.plantumlServer})`;
      });
      wrap.appendChild(img);
      pre.replaceWith(wrap);
    }
  }

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

// #203 — visual-row-accurate line ↔ scrollTop mapping for the plain textarea.
// `plainLineHeights` is mirror-measured per logical line (soft wrap included),
// so its prefix sums are each line's true y offset. `null` while the measured
// heights are stale (they refresh on a 120ms debounce after edits) or metrics
// are off — callers then fall back to the uniform-line-height estimate, which
// is exact when wrap is off.
const plainLineTops = computed<number[] | null>(() => {
  const heights = plainLineHeights.value;
  if (!heights.length) return null;
  if (heights.length !== (plainText.value || '').split('\n').length) return null;
  const tops = new Array<number>(heights.length);
  let y = 0;
  for (let i = 0; i < heights.length; i++) {
    tops[i] = y;
    y += heights[i];
  }
  return tops;
});

function plainPaddingTopPx(el: HTMLTextAreaElement): number {
  const n = Number.parseFloat(window.getComputedStyle(el).paddingTop);
  return Number.isFinite(n) ? n : 0;
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
    // Select-all mode ends the moment the user collapses the selection
    // (click into the text, arrow key); this is the single choke point all
    // the textarea's selection-ish events (keyup/mouseup/select) run through.
    maybeExitPlainSelectAll();
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
  maybePlainTypewriterScroll(line);
}

// #199 — typewriter mode for the single-textarea (edit-only / split) plain
// path; the CodeMirror extension never runs on Windows. Centres the caret's
// logical line using the same measured line tops as the gutter/scroll-sync.
function maybePlainTypewriterScroll(line: number) {
  if (!props.typewriterMode || plainLiveEnabled.value) return;
  const el = plainEditor.value;
  if (!el) return;
  const tops = plainLineTops.value;
  const y =
    tops && line <= tops.length
      ? plainPaddingTopPx(el) + tops[line - 1]
      : (line - 1) * plainLineHeightPx();
  const target = Math.max(0, y - el.clientHeight / 2);
  if (Math.abs(el.scrollTop - target) > 4) el.scrollTop = target;
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
    plainSetCaret(plainLineStartOffset(Math.floor(line)));
    return;
  }
  const el = plainEditor.value;
  if (!el) return;
  const safeLine = Math.max(1, Math.floor(line));
  const frac = Math.max(0, Math.min(line - safeLine, 0.999));
  const tops = plainLineTops.value;
  if (tops && safeLine <= tops.length) {
    const i = safeLine - 1;
    const h = i + 1 < tops.length ? tops[i + 1] - tops[i] : plainLineHeightPx();
    // 8px top margin matches the CodeMirror path and the preview pane's own
    // 8px offset — the old 40px here left the panes ~32px apart at rest.
    el.scrollTop = Math.max(0, plainPaddingTopPx(el) + tops[i] + frac * h - 8);
  } else {
    el.scrollTop = Math.max(0, (safeLine - 1 + frac) * plainLineHeightPx() - 8);
  }
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

function syncPlainEditorFromStore(text: string, preserveCaret = false) {
  const el = plainEditor.value;
  plainText.value = text;
  if (!el) return;
  if (el.value !== text) {
    // Assigning `.value` on a <textarea> destroys the selection, so an
    // external content update (a cloud client touching the file, a sync pull,
    // a save round-trip) used to yank the caret away mid-sentence. Callers
    // that are reconciling an *external* change keep the caret where the user
    // left it; callers that are loading a different document (tab switch,
    // mount) pass false and position it themselves.
    const from = el.selectionStart;
    const to = el.selectionEnd;
    const hadFocus = document.activeElement === el;
    el.value = text;
    if (preserveCaret) {
      const a = Math.min(from ?? 0, text.length);
      const b = Math.min(to ?? a, text.length);
      el.setSelectionRange(a, b);
      // Re-assert focus: some engines drop it when `.value` is replaced, and
      // a blurred textarea sends the user's next keystrokes to the document,
      // where single letters hit global handlers instead of being typed.
      if (hadFocus && document.activeElement !== el) el.focus();
    }
  }
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
  // Gitee IK6JCC — the / ⁠[[ # @ autocomplete used to be wired only to the
  // live-edit *block* editor, so on Windows (which is on this plain-textarea
  // path unless Vim mode is on) it silently did nothing in 仅编辑 / 分栏 mode.
  // Same trigger the block editor uses.
  maybeOpenPlainAutocomplete(el);
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

function caretRectFromHighlight(caret: number): { left: number; bottom: number } | null {
  if (plainLiveEnabled.value) {
    // Anchor the autocomplete popup to the active block's textarea (bottom-left).
    // A textarea can't give per-caret pixel coords without a mirror element, and
    // blocks are short, so anchoring below the block is accurate enough.
    const el = plainBlockEditors.value[plainActiveBlock.value];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, bottom: r.top + Math.min(r.height, 24) };
  }
  // Flat plain editor: one textarea holds the whole document, so "below the
  // element" would be nowhere near the caret. Measure the caret's own row.
  const el = plainEditor.value;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = window.getComputedStyle(el);
  const padTop = Number.parseFloat(cs.paddingTop || '0') || 0;
  const padLeft = Number.parseFloat(cs.paddingLeft || '0') || 0;
  const top = caretTopPx(el, el.value, Math.max(0, Math.min(caret, el.value.length)));
  return {
    left: r.left + padLeft,
    bottom: r.top + padTop + top - el.scrollTop + plainLineHeightPx(),
  };
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
  if (!plainLiveEnabled.value) {
    // Flat plain editor — no blocks, so edit the whole-document textarea
    // directly and push the result through the same path as normal typing.
    const flat = plainEditor.value;
    if (!flat || acTriggerStart < 0) { closePlainAutocomplete(); return; }
    const caret = flat.selectionStart ?? flat.value.length;
    const value = flat.value.slice(0, acTriggerStart) + item.insert + flat.value.slice(caret);
    const newCaret = acTriggerStart + item.cursorOffset;
    closePlainAutocomplete();
    recordPlainHistory();
    flat.value = value;
    plainText.value = value;
    tabs.setContent(props.tab.id, value);
    nextTick(() => {
      flat.focus();
      const p = Math.max(0, Math.min(newCaret, flat.value.length));
      flat.setSelectionRange(p, p);
      emitPlainCursorAndSelection();
    });
    return;
  }
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
  // Ctrl/Cmd+A — whole-document select-all.
  //   • Live block editor: merge blocks into one textarea and select it
  //     (native select-all otherwise stops at the current block).
  //   • Single-textarea (edit-only / split): select the textarea's own
  //     content in JS and preventDefault. #189/#210 — on Windows WebView2 the
  //     native Ctrl+A / Edit→Select All escalates to a PAGE-level document
  //     selection (the whole editor chrome, not just the field). That document
  //     Range then can't be cleared by a click, so the editor reads as
  //     "frozen" until a reload/tab-switch rebuilds the DOM. Owning the key
  //     ourselves keeps the selection scoped to the field and never lets the
  //     page-level select-all fire. Verified in the real WebView2 engine that
  //     a textarea selection there also mirrors into `window.getSelection()`,
  //     so we clear that stray document Range too (harmless on Mac/Linux where
  //     it's already empty).
  if (mod && !event.altKey && (event.key === 'a' || event.key === 'A')) {
    event.preventDefault();
    if (plainLiveEnabled.value) {
      enterPlainSelectAll();
    } else {
      const el = plainEditor.value;
      if (el) {
        el.focus();
        el.select();
        clearStrayDocumentSelection(el);
        emitPlainCursorAndSelection();
      }
    }
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

/**
 * #189/#210 — clear a stray *document-level* Range that WebView2 mirrors from
 * a `<textarea>` selection. On Mac/Linux `window.getSelection()` is empty while
 * a textarea is selected, but WebView2 reflects the field selection as a real
 * document Range that can outlive it and block click-to-deselect. Removing it
 * (while keeping the textarea's own `selectionStart/End`) restores normal
 * behaviour. `keep` is the field that legitimately owns the selection, so we
 * only strip ranges that fall outside it. No-op where getSelection is empty.
 */
function clearStrayDocumentSelection(keep: HTMLElement): void {
  try {
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const anchor = sel.anchorNode;
    // A range anchored inside the field itself is the harmless mirror of the
    // textarea's own selection; anything else is a page-level selection that
    // shouldn't be there.
    if (anchor && keep.contains(anchor) && anchor !== keep) return;
    sel.removeAllRanges();
  } catch {
    /* getSelection unavailable — nothing to clear */
  }
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

// Mirror-based visual-row probes with logical-line fallbacks, so a DOM
// hiccup degrades to the pre-4.9.6 behaviour instead of eating the keypress.
function plainCaretEdgeRows(el: HTMLTextAreaElement, val: string, pos: number) {
  try {
    return caretRowInfo(el, val, pos);
  } catch {
    const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
    return { firstRow: lineStart === 0, lastRow: val.indexOf('\n', pos) < 0 };
  }
}

function plainLastRowStart(el: HTMLTextAreaElement, text: string): number {
  try {
    return lastVisualRowStart(el, text);
  } catch {
    return text.lastIndexOf('\n') + 1;
  }
}

function plainFirstRowEnd(el: HTMLTextAreaElement, text: string): number {
  try {
    return firstVisualRowEnd(el, text);
  } catch {
    const firstNl = text.indexOf('\n');
    return firstNl < 0 ? text.length : firstNl;
  }
}

function handlePlainBlockKeydown(index: number, event: KeyboardEvent) {
  if (plainComposing) return;
  if (handleAutocompleteKeydown(event)) return;
  if (handlePlainKeydownShared(event)) return;
  // Block-boundary arrow navigation (#155). Each block is its own <textarea>,
  // so the native caret dead-ends at the block edge — ↑/↓/←/→ can't cross into
  // the neighbouring block and the cursor appears stuck. Detect the edge and
  // hand focus to the adjacent block, preserving the column for ↑/↓. Plain
  // arrows on a collapsed caret only (Shift keeps native text selection).
  if (
    (event.key === 'ArrowUp' || event.key === 'ArrowDown' ||
      event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
    !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
  ) {
    const el = event.target as HTMLTextAreaElement;
    if ((el.selectionStart ?? 0) === (el.selectionEnd ?? 0)) {
      const blocks = plainBlocks.value;
      const pos = el.selectionStart ?? 0;
      const val = el.value;
      if (event.key === 'ArrowLeft' && pos === 0 && index > 0) {
        event.preventDefault();
        activatePlainBlock(index - 1, blocks[index - 1]?.text.length ?? 0);
        return;
      }
      if (event.key === 'ArrowRight' && pos === val.length && index < blocks.length - 1) {
        event.preventDefault();
        activatePlainBlock(index + 1, 0);
        return;
      }
      // ↑/↓ hand-off must key on *visual* rows, not logical lines (#155
      // follow-up): with soft wrap on, a long paragraph is ONE logical line,
      // so the old `lineStart === 0` test fired from any wrapped row and ↑
      // teleported over the whole paragraph into the previous block.
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const edge = plainCaretEdgeRows(el, val, pos);
        if (event.key === 'ArrowUp' && edge.firstRow && index > 0) {
          event.preventDefault();
          const prev = blocks[index - 1]?.text ?? '';
          // First visual row starts at 0, so the visual column is `pos`.
          // Land on the previous block's last visual row, same column.
          activatePlainBlock(index - 1, Math.min(plainLastRowStart(el, prev) + pos, prev.length));
          return;
        }
        if (event.key === 'ArrowDown' && edge.lastRow && index < blocks.length - 1) {
          event.preventDefault();
          const next = blocks[index + 1]?.text ?? '';
          const vcol = pos - plainLastRowStart(el, val);
          activatePlainBlock(index + 1, Math.min(vcol, plainFirstRowEnd(el, next)));
          return;
        }
      }
    }
  }
  // Esc dismisses a select-all (parks the caret at the selection end).
  if (plainSelectAll.value && event.key === 'Escape') {
    event.preventDefault();
    const el = event.target as HTMLTextAreaElement;
    const pos = el.selectionEnd ?? 0;
    el.setSelectionRange(pos, pos);
    maybeExitPlainSelectAll();
    return;
  }
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
  // Must come before the shared handler: ↑/↓/Enter/Tab/Esc belong to the
  // popup while it is open (Gitee IK6JCC).
  if (handleAutocompleteKeydown(event)) return;
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
  plainSelectAll.value = false; // full edits land in normal block view
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

/** Enter select-all mode: merge the doc into one block and native-select it. */
function enterPlainSelectAll() {
  if (plainSelectAll.value) {
    // Repeated Ctrl+A after the user collapsed part of the selection by
    // shift-arrowing etc. — just re-select within the merged textarea.
    plainBlockEditors.value[plainActiveBlock.value]?.select();
    return;
  }
  plainSelectAllPending = true;
  plainSelectAll.value = true;
  plainActiveBlock.value = 0;
  nextTick(() => {
    const el = plainBlockEditors.value[0];
    if (!el) {
      plainSelectAllPending = false;
      plainSelectAll.value = false;
      return;
    }
    // Order matters: focus() synchronously dispatches a focus event, which
    // funnels into maybeExitPlainSelectAll — the still-collapsed selection
    // must not read as "user dismissed it". Keep `pending` up until the
    // range is actually set.
    el.focus();
    el.select();
    plainSelectAllPending = false;
    autoSizePlainBlock(el);
    emitPlainCursorAndSelection();
  });
}

/**
 * Leave select-all mode once the selection collapses (click / arrow key / Esc):
 * re-split into blocks and land the caret in the block that now contains it.
 * Editing while everything is selected exits through updatePlainBlock /
 * applyPlainFullEdit instead (the native input event replaces the selection).
 */
function maybeExitPlainSelectAll() {
  if (!plainSelectAll.value || plainSelectAllPending) return;
  const el = plainBlockEditors.value[plainActiveBlock.value];
  if (!el) return;
  const caret = el.selectionStart ?? 0;
  if (caret !== (el.selectionEnd ?? 0)) return; // still a range — stay
  plainSelectAll.value = false;
  const blocks = splitPlainMarkdownBlocks(plainText.value || '');
  let found = blocks.findIndex((b) => caret >= b.start && caret < b.end);
  if (found < 0) found = blocks.length - 1;
  plainActiveBlock.value = found;
  nextTick(() => {
    const activeBlock = plainBlocks.value[plainActiveBlock.value];
    const el2 = plainBlockEditors.value[plainActiveBlock.value];
    if (!el2) return;
    if (document.activeElement !== el2) el2.focus();
    autoSizePlainBlock(el2);
    if (activeBlock) {
      const pos = Math.max(0, Math.min(caret - activeBlock.start, el2.value.length));
      el2.setSelectionRange(pos, pos);
    }
    emitPlainCursorAndSelection();
  });
}

function updatePlainBlock(index: number, text: string, caret?: number) {
  const block = plainBlocks.value[index];
  if (!block) return;
  // An edit while everything is selected (type-over, Ctrl+X, Delete via native
  // selection replacement) ends select-all mode; the re-split below then runs
  // against normal block boundaries. `block` above was captured from the
  // merged view, so offsets stay consistent for this edit.
  const wasSelectAll = plainSelectAll.value;
  plainSelectAll.value = false;
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
  // Never fast-path out of select-all mode: the merged block's :key
  // ('select-all') differs from the re-split block's, so the <textarea>
  // REMOUNTS even when index/start/text all match (e.g. select-all → delete
  // everything, or type-over a doc that re-splits to one block). Skipping the
  // nextTick would leave focus on <body> and swallow every subsequent
  // keystroke — caught by real-key testing in the Windows VM.
  if (!wasSelectAll && nextIndex === index && nextBlock?.start === block.start && nextBlock?.text === text) {
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
        getPlantuml: () => ({
          enabled: settings.plantumlEnabled,
          server: settings.plantumlServer,
        }),
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
          // #193 — solid (non-blinking) caret option. cursorBlinkRate: 0
          // disables the blink cycle entirely; 1200ms is CM6's default.
          cursorCompartment.of(
            drawSelection({ cursorBlinkRate: settings.solidCursor ? 0 : 1200 }),
          ),
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
          incrementalFindScroll,
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
    // #167 — clicks during async widget renders (post tab-switch) must not
    // turn into phantom multi-line selections when the layout shifts.
    stableClickSelection(),
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
  // Registered before the plain-editor early return below — this listener has
  // to exist on ALL three editor paths, and the CodeMirror-only setup that
  // follows is unreachable on Windows. (Putting it further down is what made
  // the first attempt silently no-op on the plain editors.)
  window.addEventListener('solomd:transform-case', onTransformCase as EventListener);
  cleanupTransformCase = () => {
    window.removeEventListener('solomd:transform-case', onTransformCase as EventListener);
  };

  if (usePlainWindowsEditor) {
    syncPlainEditorFromStore(props.tab.content);
    maybeRestoreSession();
    void processPlainLiveRenderedBlocks();
    focusPlainEditor();
    // #126 — let the toolbar AI-rewrite button read this editor's selection
    // (no CodeMirror view exists on this path for it to scan).
    cleanupPlainSelection = registerPlainSelectionGetter(() => {
      const sel = plainAbsoluteSelection();
      const text = plainSelectionText();
      return sel && text ? { selection: text, from: sel.from, to: sel.to } : null;
    });
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
  window.addEventListener('solomd:flush-content-sync', flushContentSync);
  cleanupRelayout = () => {
    window.removeEventListener('solomd:relayout', onRelayout);
    window.removeEventListener('solomd:flush-content-sync', flushContentSync);
  };
});

/**
 * Gitee IK8QG3 — upper / lower / Title case over the selection, or the word
 * under the caret when there is no selection.
 *
 * Deliberately routed through the same handler for all three editors this
 * component can be: CodeMirror, the plain block editor, and the plain flat
 * editor. Wiring only one of them is how the slash-command autocomplete came
 * to be dead on Windows for months (IK6JCC) — the shared decision of *what* to
 * change lives in lib/text-case.ts, and each branch below only supplies the
 * current text + selection and writes the result back.
 */
function onTransformCase(e: Event) {
  const detail = (e as CustomEvent).detail || {};
  const mode: CaseMode | 'cycle' = detail.mode || 'cycle';
  // Split view mounts one Editor per pane and they all hear this event, so
  // only the one showing the active tab may act.
  if (props.tab.id !== tabs.activeId) return;

  if (!usePlainWindowsEditor) {
    if (!view) return;
    const sel = view.state.selection.main;
    const doc = view.state.doc.toString();
    const target = caseTargetRange(doc, sel.from, sel.to);
    if (!target) return;
    const next = mode === 'cycle' ? nextCaseInCycle(target.text) : mode;
    const replaced = transformCase(target.text, next);
    if (replaced === target.text) return;
    view.dispatch({
      changes: { from: target.from, to: target.to, insert: replaced },
      selection: { anchor: target.from, head: target.from + replaced.length },
    });
    view.focus();
    return;
  }

  // Plain paths — the block editor edits one block's textarea, the flat one
  // edits the whole document, so resolve the element first and then share
  // the rest.
  const el = plainLiveEnabled.value
    ? plainBlockEditors.value[plainActiveBlock.value]
    : plainEditor.value;
  if (!el) return;
  const target = caseTargetRange(el.value, el.selectionStart ?? 0, el.selectionEnd ?? 0);
  if (!target) return;
  const next = mode === 'cycle' ? nextCaseInCycle(target.text) : mode;
  const replaced = transformCase(target.text, next);
  if (replaced === target.text) return;
  const value = el.value.slice(0, target.from) + replaced + el.value.slice(target.to);
  recordPlainHistory();
  if (plainLiveEnabled.value) {
    updatePlainBlock(plainActiveBlock.value, value, target.from + replaced.length);
    nextTick(() => {
      const e2 = plainBlockEditors.value[plainActiveBlock.value];
      if (e2) {
        e2.focus();
        e2.setSelectionRange(target.from, target.from + replaced.length);
      }
    });
    return;
  }
  el.value = value;
  plainText.value = value;
  tabs.setContent(props.tab.id, value);
  nextTick(() => {
    el.focus();
    el.setSelectionRange(target.from, target.from + replaced.length);
    emitPlainCursorAndSelection();
  });
}

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
  cleanupTransformCase?.();
  cleanupTransformCase = null;
  cleanupPlainSelection?.();
  cleanupPlainSelection = null;
  if (contentSyncTimer) {
    // A Vim-mode toggle remounts the Windows editor. Flush the current
    // CodeMirror document before cancelling the debounce so the last keystroke
    // cannot disappear during that hand-off.
    if (view && !view.composing) tabs.setContent(props.tab.id, view.state.doc.toString());
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
// #144 — per-tab caret + scroll memory (runtime-only, per editor pane; a tab
// shown in two split panes keeps an independent position in each). Without
// this, switching tabs dropped the position: the plain textarea's `el.value =`
// re-sync moves the caret to the END of the document, and the CodeMirror
// `setState` reset it to 0.
const tabCaretMemory = new Map<string, { caret: number; scrollTop: number }>();

// #169 (Windows) — one synchronous scrollTop assignment is not enough on the
// plain paths: focusPlainEditor() focuses on nextTick, and the browser then
// scrolls the caret back into view — line 1 when the user only scrolled and
// never clicked, which is exactly the reported "switch back → reset to top".
// The live block editor additionally re-renders its blocks asynchronously,
// growing scrollHeight after the restore. Pin the saved position through that
// settle window, backing off the moment the user scrolls themselves.
function restorePlainScroll(saved?: { caret: number; scrollTop: number }) {
  const scroller = (): HTMLElement | null =>
    plainLiveEnabled.value ? plainLiveHost.value : plainEditor.value;
  const el = scroller();
  if (!el) return;
  if (!plainLiveEnabled.value) {
    const ta = el as HTMLTextAreaElement;
    const pos = Math.min(saved?.caret ?? 0, ta.value.length);
    ta.setSelectionRange(pos, pos);
  }
  const st = saved?.scrollTop ?? 0;
  el.scrollTop = st;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  const intentEvents = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;
  for (const ev of intentEvents) el.addEventListener(ev, cancel, { passive: true });
  const reassert = () => {
    const cur = scroller();
    if (!cancelled && cur && Math.abs(cur.scrollTop - st) > 1) cur.scrollTop = st;
  };
  nextTick(() => requestAnimationFrame(reassert));
  setTimeout(reassert, 120);
  setTimeout(reassert, 400);
  setTimeout(() => {
    for (const ev of intentEvents) el.removeEventListener(ev, cancel);
  }, 800);
  setTimeout(reassert, 780);
}

watch(
  () => props.tab.id,
  (newId, oldId) => {
    // Snapshot the OUTGOING tab first — at this point the editor DOM/state
    // still holds the old document (re-sync happens below).
    if (oldId) {
      if (usePlainWindowsEditor) {
        if (plainLiveEnabled.value) {
          tabCaretMemory.set(oldId, {
            caret: 0,
            scrollTop: plainLiveHost.value?.scrollTop ?? 0,
          });
        } else if (plainEditor.value) {
          tabCaretMemory.set(oldId, {
            caret: plainEditor.value.selectionStart ?? 0,
            scrollTop: plainEditor.value.scrollTop,
          });
        }
      } else if (view) {
        tabCaretMemory.set(oldId, {
          caret: view.state.selection.main.head,
          scrollTop: view.scrollDOM.scrollTop,
        });
      }
    }
    const saved = newId ? tabCaretMemory.get(newId) : undefined;
    if (usePlainWindowsEditor) {
      // The Editor component is reused across tabs (no :key), so switching to /
      // creating a document must re-sync content, reset per-document state, and
      // re-focus — otherwise the new doc shows stale text and can't be typed in.
      plainSelectAll.value = false;
      plainSelectAllPending = false;
      plainActiveBlock.value = 0;
      plainUndoStack.length = 0;
      plainRedoStack = [];
      plainHistoryTs = 0;
      closePlainFind();
      syncPlainEditorFromStore(props.tab.content);
      maybeRestoreSession();
      void processPlainLiveRenderedBlocks();
      focusPlainEditor();
      // Restore the caret/scroll (default: document START, not end — the
      // `el.value =` assignment above parked it at the end). Block live-edit
      // restores the scroll container only; per-block focus is its own.
      restorePlainScroll(saved);
      return;
    }
    if (!view) return;
    view.setState(
      EditorState.create({
        doc: props.tab.content,
        extensions: buildExtensions(),
        selection: { anchor: Math.min(saved?.caret ?? 0, props.tab.content.length) },
      })
    );
    maybeRestoreSession();
    if (saved) {
      // #169 — one synchronous assignment is not enough: async widget renders
      // (tables / images / mermaid) and CM's post-setState measure pass can
      // yank the viewport back to the caret, which sits on line 1 when the
      // user scrolled without ever clicking. Re-assert after layout, but ONLY
      // when the viewport was reset toward the top — never fight a scroll the
      // user just made themselves.
      const st = saved.scrollTop;
      view.scrollDOM.scrollTop = st;
      const reassert = () => {
        if (view && st > 50 && view.scrollDOM.scrollTop < 10) {
          view.scrollDOM.scrollTop = st;
        }
      };
      requestAnimationFrame(reassert);
      setTimeout(reassert, 120);
      setTimeout(reassert, 400);
    }
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
      // The #186 defenses below were only ever applied to the CodeMirror
      // branch — this one returned before reaching them, so on Windows an
      // external content update still reset the caret and killed an in-flight
      // IME composition. Same two guards, expressed for the textarea.
      if (plainComposing) return;
      syncPlainEditorFromStore(next, true);
      return;
    }
    if (!view) return;
    if (view.state.doc.toString() !== next) {
      // #186 defense-in-depth: never interrupt an active IME composition —
      // dispatching here aborts it and strands the composed text — and keep
      // the caret at its old offset instead of letting the full-doc replace
      // map it to 0. (While the user is typing, the editor is the source of
      // truth; a skipped write is re-reconciled by the next content sync.)
      if (view.composing) return;
      const head = Math.min(view.state.selection.main.head, next.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        selection: { anchor: head },
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
  () => settings.solidCursor,
  (solid) => {
    view?.dispatch({
      effects: cursorCompartment.reconfigure(
        drawSelection({ cursorBlinkRate: solid ? 0 : 1200 }),
      ),
    });
  },
);

watch(
  () => settings.showLineNumbers,
  (s) => {
    view?.dispatch({ effects: lineNumCompartment.reconfigure(s ? lineNumbers() : []) });
  }
);

// v4.10 #163 — the live-blocks field only rebuilds on doc/selection changes,
// so nudge it when the PlantUML toggle/server flips (same event the async
// Mermaid render uses).
watch(
  [() => settings.plantumlEnabled, () => settings.plantumlServer],
  () => {
    try {
      window.dispatchEvent(new CustomEvent('solomd:cm-relayout'));
    } catch {}
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

// A stale select-all must not survive leaving live edit (the merged single
// block would greet the user on re-entry).
watch(plainLiveEnabled, () => {
  plainSelectAll.value = false;
  plainSelectAllPending = false;
});

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
    const tops = plainLineTops.value;
    if (tops) {
      // Largest line whose measured top is at/above the viewport top, plus
      // the fraction of that line already scrolled past — split-pane sync
      // interpolates on it so the panes stay level inside tall wrapped lines.
      const y = Math.max(0, top - plainPaddingTopPx(el));
      let lo = 0;
      let hi = tops.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (tops[mid] <= y) lo = mid;
        else hi = mid - 1;
      }
      const h = lo + 1 < tops.length ? tops[lo + 1] - tops[lo] : plainLineHeightPx();
      const frac = h > 0 ? Math.min(0.999, (y - tops[lo]) / h) : 0;
      return lo + 1 + Math.max(0, frac);
    }
    const line = Math.max(1, Math.floor(top / plainLineHeightPx()) + 1);
    return line;
  }
  if (!view) return null;
  const top = view.scrollDOM.scrollTop;
  const block = view.lineBlockAtHeight(top);
  const frac =
    block.height > 0 ? Math.max(0, Math.min(0.999, (top - block.top) / block.height)) : 0;
  return view.state.doc.lineAt(block.from).number + frac;
}

/**
 * Top of the given 1-indexed line in the editor's scrollTop coordinate space,
 * or null while metrics are unavailable. The split-pane sync interpolates
 * between two of these to keep the panes pixel-level, not just line-level.
 */
function lineTopY(line: number): number | null {
  if (usePlainWindowsEditor) {
    if (plainLiveEnabled.value) return null;
    const el = plainEditor.value;
    const tops = plainLineTops.value;
    if (!el || !tops) return null;
    const i = Math.max(0, Math.min(Math.floor(line) - 1, tops.length - 1));
    return plainPaddingTopPx(el) + tops[i];
  }
  if (!view) return null;
  const safe = Math.max(1, Math.min(Math.floor(line), view.state.doc.lines));
  return view.lineBlockAt(view.state.doc.line(safe).from).top;
}

/**
 * Scroll the given 1-indexed line to the top of the viewport (without moving
 * the cursor). Accepts fractional lines (12.5 = halfway down line 12) so the
 * split-pane sync can interpolate inside tall wrapped lines.
 */
function scrollToLine(line: number): void {
  if (usePlainWindowsEditor) {
    plainScrollToLine(line);
    return;
  }
  if (!view) return;
  const safe = Math.max(1, Math.min(Math.floor(line), view.state.doc.lines));
  const frac = Math.max(0, Math.min(line - safe, 0.999));
  const lineObj = view.state.doc.line(safe);
  if (frac > 0.001) {
    const block = view.lineBlockAt(lineObj.from);
    const y = view.documentTop + block.top + frac * block.height;
    const scroller = view.scrollDOM.getBoundingClientRect();
    view.scrollDOM.scrollTop += y - scroller.top - 8;
    return;
  }
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

defineExpose({ gotoLine, insertImageFromPath, insertImageUrl, uploadLocalImages, getViewLine, scrollToLine, lineTopY, insertMarkdown, openFind });

const cls = computed(() => ({
  'cm-host': true,
  'cm-host--dark': settings.theme === 'dark',
  // #109 — constrain the editing column to a centered readable width.
  'cm-host--limit-width': settings.limitEditorWidth,
  // #211 — soft-wrap fenced code in the LIVE-rendered blocks too. Only
  // Preview.vue carried `cb-wrap-on` before, so the code-block-wrap setting
  // silently did nothing in Live Edit (CodeMirror live blocks + the Windows
  // plain block editor both render through this host). Same class name +
  // CSS as the preview so behaviour matches across modes.
  'cb-wrap-on': settings.codeBlockWrap,
}));
</script>

<template>
  <div v-if="!usePlainWindowsEditor" :class="cls" ref="host"></div>
  <div v-else class="plain-host">
    <div
      v-if="plainLiveEnabled"
      ref="plainLiveHost"
      :class="[
        cls,
        'plain-block-editor',
        { 'plain-block-editor--cb-numbers': settings.codeBlockLineNumbers },
      ]"
      :style="plainEditorStyle"
    >
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
    <div v-else :class="[cls, 'plain-source']" :style="plainEditorStyle">
      <div
        v-if="plainGutterEnabled"
        class="plain-gutter"
        aria-hidden="true"
        :style="{ width: `calc(${plainGutterWidth} + 20px)` }"
      >
        <div class="plain-gutter__inner" :style="{ transform: `translateY(${-plainScrollTop}px)` }">
          <div
            v-for="(h, i) in plainLineHeights"
            :key="i"
            class="plain-gutter__num"
            :style="{ height: h + 'px' }"
          >{{ i + 1 }}</div>
        </div>
      </div>
      <textarea
        ref="plainEditor"
        class="plain-editor"
        :class="{ 'plain-textarea--wrap': settings.wordWrap }"
        :spellcheck="props.spellCheck"
        :wrap="settings.wordWrap ? 'soft' : 'off'"
        @keydown="handlePlainEditorKeydown"
        @paste="handlePlainPaste"
        @input="handlePlainInput"
        @scroll="onPlainScroll"
        @mousedown="clearStrayDocumentSelection($event.currentTarget as HTMLElement)"
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
.plain-source {
  display: flex;
}
.plain-source .plain-editor {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}
.plain-gutter {
  flex: none;
  overflow: hidden;
  box-sizing: border-box;
  /* Top padding must match .plain-editor's 12px or numbers drift off rows. */
  padding: 12px 8px 12px 0;
  border-right: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  background: var(--bg);
  color: var(--text-faint, #999);
  font-family: var(--plain-editor-font-family, var(--font-editor, var(--font-mono)));
  font-size: var(--plain-editor-font-size, 14px);
  line-height: 1.6;
  text-align: right;
  user-select: none;
}
.plain-gutter__num {
  box-sizing: border-box;
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
  /* #143 — rendered (non-focused) blocks must use the SAME user-configured
     editor font as the focused textarea block, or live-edit looks like two
     different documents (only the focused line honored 字体/字号). Fall back
     to the old values for safety. */
  font-family: var(--plain-editor-font-family, var(--font-ui));
  font-size: var(--plain-editor-font-size, 15px);
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
/* #211 — when the code-block-wrap setting is on, the LIVE-rendered code
 * blocks soft-wrap like the preview does, instead of the default horizontal
 * scroll. `cb-wrap-on` is set on this host via `cls` (Editor.vue) from
 * settings.codeBlockWrap — same class + rules as Preview.vue's
 * `.cb-wrap-on pre`, so wrapping is identical across modes. */
.cb-wrap-on .plain-block__render :deep(pre) {
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
  overflow-x: visible;
}
/* #164 — live-edit blocks honor the same `codeBlockLineNumbers` setting as
 * the preview pane (markdown.ts always emits the .cb-line wrappers; this is
 * the same pure-CSS activation Preview.vue uses, incl. the newline-collapse
 * that keeps line spacing single). */
.plain-block-editor--cb-numbers .plain-block__render :deep(pre.cb-numbered) {
  counter-reset: cb-line;
}
.plain-block-editor--cb-numbers .plain-block__render :deep(pre.cb-numbered code) {
  white-space: normal;
}
.plain-block-editor--cb-numbers .plain-block__render :deep(pre.cb-numbered code .cb-line) {
  counter-increment: cb-line;
  display: block;
  padding-left: 3.4em;
  position: relative;
  white-space: pre;
}
/* #211 — code-block-wrap wins over line numbers here too (mirrors Preview.vue):
 * long numbered lines soft-wrap instead of overflowing when both toggles on. */
.cb-wrap-on.plain-block-editor--cb-numbers .plain-block__render :deep(pre.cb-numbered code .cb-line) {
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
}
.plain-block-editor--cb-numbers .plain-block__render :deep(pre.cb-numbered code .cb-line::before) {
  content: counter(cb-line);
  position: absolute;
  left: 0;
  width: 2.6em;
  padding-right: 0.6em;
  text-align: right;
  color: var(--text-faint);
  border-right: 1px solid var(--border);
  user-select: none;
  -webkit-user-select: none;
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
.plain-block__render :deep(.plain-plantuml-block),
.plain-block__render :deep(.plain-whiteboard-block) {
  margin: 1em 0;
  max-width: 100%;
  overflow: auto;
}
.plain-block__render :deep(.plain-mermaid-block svg),
.plain-block__render :deep(.plain-plantuml-block img),
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
