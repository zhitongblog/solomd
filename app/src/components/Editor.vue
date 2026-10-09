<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed, nextTick } from 'vue';
import { EditorState, Compartment, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo as cmUndo, redo as cmRedo } from '@codemirror/commands';
import { searchKeymap, search, openSearchPanel, getSearchQuery, setSearchQuery } from '@codemirror/search';
import { createFindPanel, type FindPanelLabels } from '../lib/cm-find-panel';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { cjkFriendlyEmphasis } from '../lib/cm-cjk-emphasis';
import { initMermaid } from '../lib/mermaid-lazy';
import { parseInsertSnippet } from '../lib/insert-snippet';
// The grammar imports and the `codeLanguages` list they feed now live in
// `lib/code-languages.ts`: the ``` fence-language picker (#297) derives its
// catalogue from that same list, so there is only one copy to keep in sync.
import { codeLanguages } from '../lib/code-languages';
import { fenceLanguageComplete, fenceLanguageExtension } from '../lib/cm-fence-completion';
import { filterFenceLanguages, isInsideFenceBefore, matchFenceOpener } from '../lib/fence-languages';
import { vim, Vim } from '@replit/codemirror-vim';
import { cmThemeFor, mermaidThemeFor } from '../lib/themes';
import { registerPlainSelectionGetter } from '../lib/plain-selection';
import {
  headingFoldExtension,
  toggleHeadingFoldAtCursor,
  foldAllHeadings,
  unfoldAllFolds,
  foldHeadingsToLevel,
} from '../lib/cm-heading-fold';
import { findTableSpan } from '../lib/markdown-table';
import { findMathSpanAt, collectLabels } from '../lib/equations';
import { openFormulaEditor } from '../lib/formula-editor-bus';
import { openTableEditor } from '../lib/table-editor-bus';
import {
  scanHeadings,
  foldedCharRanges,
  remapFolds,
  type FoldAnchor,
  type HeadingSpan,
} from '../lib/heading-fold';
import {
  EDITOR_COMMANDS,
  MARKDOWN_ONLY_COMMANDS,
  deleteWord as deleteWordEdit,
  selectLine as selectLineRange,
  selectWord as selectWordRange,
  shiftHeading,
  type EditorCommand,
} from '../lib/editor-commands';
import { caretRowInfo, caretTopPx, caretPointPx, lastVisualRowStart, firstVisualRowEnd, measureLineHeights, offsetAtPoint, selectionBoxPx } from '../lib/textarea-metrics';
import { activeParagraphLines, lineAt } from '../lib/focus-paragraph';
import { transformCase, nextCaseInCycle, caseTargetRange, type CaseMode } from '../lib/text-case';
import { applyFormat, FORMAT_KINDS, listIndentEdit, type FormatKind } from '../lib/md-format';
import { useFormatHints } from '../composables/useFormatHints';
import { useTabsStore } from '../stores/tabs';
import { useSettingsStore, buildEditorFontStack } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import type { Tab } from '../types';
import { livePreviewExtension, richHighlightOnly } from '../lib/cm-live-preview';
import { liveEditExtension, setLiveEditCopyLabel } from '../lib/cm-live-render';
import { liveBlocksExtension, liveBlocksTheme, extractImageRoot } from '../lib/cm-live-blocks';
import { findTldrawFences, replaceBoardSnapshot } from '../lib/tldraw-board';
import { dragAwareExtension } from '../lib/cm-drag-aware';
import { imagePasteExtension, insertImageFromPath as cmInsertImageFromPath, imageTextFromPath, handleTextareaImagePaste, type ImagePasteOptions } from '../lib/cm-image-paste';
import { markdownImage, encodeImageDestination } from '../lib/md-image-url';
import { resolveUploader, uploadImage, type ImageUploadSettings } from '../lib/image-upload';
import { focusModeExtension, typewriterModeExtension } from '../lib/cm-focus-mode';
import { wikilinkExtension, wikilinkComplete } from '../lib/cm-wikilink';
import { tagAutocompleteExtension, tagComplete } from '../lib/cm-tag-autocomplete';
import { citationsExtension, citationCompleteSource } from '../lib/cm-citations';
import { autocompletion } from '@codemirror/autocomplete';
import { aiRewriteExtension } from '../lib/cm-ai-rewrite';
import { cmKeyOwnedByApp, combosFor, toCodeMirrorKey, eventToCombo, resolveBindings } from '../lib/keybindings';
import {
  docParagraphStarts,
  nextParagraphStart,
  paragraphRangeInBlock,
  prevParagraphStart,
  selectionEnds,
} from '../lib/plain-nav';
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
import { useRenderDepsVersion } from '../composables/useRenderDepsVersion';
import { attachCodeCopyButtons } from '../lib/code-copy';
import { plantumlSvgUrl } from '../lib/plantuml';
import { stableClickSelection } from '../lib/cm-stable-click';
import { installSvgImageFallbacks, rewriteImageUrls } from '../lib/image-resolve';
import { SLASH_BLOCKS, filterBlocks, expandSnippet } from '../lib/slash-blocks';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';
import { isWindowsEditorRuntime, shouldUsePlainWindowsEditor } from '../lib/platform';
import { isAndroid, isIOS, isMobile } from '../lib/platform';
import SelectionBubble, { type BubbleSelection } from './SelectionBubble.vue';
import { lineContext, nextHeadingKind, type Box } from '../lib/selection-bubble';
import EditorContextMenu, { type EditorMenuAction, type EditorMenuSpell } from './EditorContextMenu.vue';
import { lookupMisspelling, addToSpellDict } from '../lib/spell-suggest';
import { copyImageElement } from '../lib/image-clipboard';
import { readText as readClipboardTextPlugin, writeText as writeClipboardTextPlugin } from '@tauri-apps/plugin-clipboard-manager';
import { computeListContinuation } from '../lib/list-continuation';
import { mapPos, renumberAfterEdit, renumberChanges } from '../lib/list-renumber';
import { openRenderedLink } from '../lib/link-open';

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
// #344 — optional caret-line tint (the base theme paints .cm-activeLine clear).
const activeLineCompartment = new Compartment();
const fontSizeCompartment = new Compartment();
// #180 — the AI-rewrite chord is user-bindable; keep it reconfigurable.
const aiKeyCompartment = new Compartment();
// B4 — CodeMirror's own default/search keymap, minus every chord an app-level
// shortcut owns (see `cmKeyOwnedByApp`). Reconfigured when bindings change.
const baseKeymapCompartment = new Compartment();
function baseKeymap() {
  const overrides = { ...settings.keybindings };
  return keymap.of(
    [...defaultKeymap, ...searchKeymap].filter(
      // #296 — Mod-i is CodeMirror's selectParentSyntax; it would widen the
      // selection to the whole paragraph before Italic ran.
      (b) => b.key !== 'Mod-i' && !cmKeyOwnedByApp(b, overrides),
    ),
  );
}
const richCompartment = new Compartment();
const spellCheckCompartment = new Compartment();
const focusCompartment = new Compartment();
const typewriterCompartment = new Compartment();
const vimCompartment = new Compartment();
const slashCompartment = new Compartment();
const foldCompartment = new Compartment();

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

// #373 — Vim must see keys before every other keymap. The markdown keymap
// (Enter → insertNewlineContinueMarkup) sits at Prec.high and defaultKeymap
// (Enter → insertNewlineAndIndent) ran ahead of vim() too, so Enter in Normal
// mode inserted a newline instead of moving to the next line's first
// non-blank. codemirror-vim's README requires it to come first; Prec.highest
// does that regardless of where the compartment sits. In Insert mode Vim
// declines keys it has no mapping for (Enter, Tab, Mod-*), so list
// continuation, indentation, autocomplete and app shortcuts still run.
function vimExtension() {
  return Prec.highest(vim());
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
// The user can also choose CodeMirror outright on Windows (Settings → Editor
// engine, #328/#344) — same remount path, without the Vim keymap.
const usePlainWindowsEditor = shouldUsePlainWindowsEditor(
  isWindows,
  settings.vimMode,
  settings.windowsEditorEngine,
);

// One-time "there is a key for that" tips. Fed from all three input paths
// below — the same rule as every other editing feature in this file.
const noteTypedFormat = useFormatHints();
function noteTypedInTextarea(el: HTMLTextAreaElement, event: Event) {
  const ie = event as InputEvent;
  if (props.tab.language !== 'markdown') return;
  if (ie.inputType !== 'insertText' || !ie.data || ie.data.length !== 1) return;
  const caret = el.selectionStart ?? 0;
  const lineStart = el.value.lastIndexOf('\n', caret - 1) + 1;
  noteTypedFormat(el.value.slice(lineStart, caret), ie.data);
}

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
const plainHostEl = ref<HTMLDivElement | null>(null);
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
const plainComposing = ref(false);
let plainMermaidIdSeq = 0;
const plainRenderCache = new Map<string, string>();
// Bumps when KaTeX / highlight.js finish loading (lib/render-deps.ts). Part
// of the cache key below, so blocks rendered with placeholder math / plain
// code re-render — the plainBlocks computed reads it through that key.
const renderDepsVersion = useRenderDepsVersion();

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
    // #316 — the focus shade and the drawn caret take their y from the same
    // measured line tops, so they keep the metrics warm too.
    (settings.showLineNumbers ||
      settings.viewMode === 'split' ||
      props.typewriterMode ||
      props.focusMode ||
      settings.solidCursor),
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
  // The shade and the drawn caret are positioned against the container, not
  // the scrolled text, so they have to follow the textarea's own scrolling.
  schedulePlainOverlays();
  // So does the find highlight (#330). Cheap: its rects are cached per match.
  if (plainFindBoxes.value.length || plainFindOpen.value) updatePlainFindBoxes();
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

// ---- Heading folding, plain-textarea path --------------------------------
// CodeMirror keeps folds in editor state; the Windows block editor has none,
// so folds live here as heading anchors (line + heading text). Anchors survive
// edits that shift line numbers — a bare line number would collapse whatever
// section happened to slide into that slot.
const plainFolds = ref<FoldAnchor[]>([]);

const plainHeadings = computed<HeadingSpan[]>(() =>
  plainLiveEnabled.value && settings.foldingEnabled ? scanHeadings(plainText.value || '') : [],
);
const plainFoldableByStart = computed(() => {
  const map = new Map<number, HeadingSpan>();
  for (const h of plainHeadings.value) if (h.foldable) map.set(h.start, h);
  return map;
});
const plainFoldedLines = computed(() => new Set(plainFolds.value.map((f) => f.line)));
const plainFoldRanges = computed(() =>
  plainFolds.value.length ? foldedCharRanges(plainText.value || '', plainFolds.value.map((f) => f.line)) : [],
);

/** Blocks inside a folded section are not rendered. The active block is always
 *  rendered: hiding the textarea the caret lives in would take the caret with
 *  it, and the next keystroke would go nowhere. */
function plainBlockHidden(block: PlainBlock, index: number): boolean {
  if (index === plainActiveBlock.value) return false;
  const ranges = plainFoldRanges.value;
  if (!ranges.length) return false;
  return ranges.some((r) => block.start > r.from && block.start < r.to);
}

function plainHeadingFor(block: PlainBlock): HeadingSpan | null {
  return plainFoldableByStart.value.get(block.start) ?? null;
}
function plainHeadingFolded(block: PlainBlock): boolean {
  const h = plainHeadingFor(block);
  return !!h && plainFoldedLines.value.has(h.line);
}
/** Lines a folded heading is hiding — shown on the chevron so the collapsed
 *  section advertises its size. */
function plainHiddenLineCount(block: PlainBlock): number {
  const h = plainHeadingFor(block);
  return h ? h.endLine - h.line : 0;
}
function setPlainFold(span: HeadingSpan, folded: boolean) {
  if (folded) {
    if (plainFoldedLines.value.has(span.line)) return;
    // Editing inside a section that is about to disappear would strand the
    // caret in a hidden block, so move it onto the heading first.
    const active = plainBlocks.value[plainActiveBlock.value];
    if (active && active.start > span.headingEnd && active.start <= span.end) {
      const headingIndex = plainBlocks.value.findIndex((b) => b.start === span.start);
      if (headingIndex >= 0) {
        activatePlainBlock(headingIndex, plainBlocks.value[headingIndex]?.text.length ?? 0);
      }
    }
    plainFolds.value = [...plainFolds.value, { line: span.line, title: span.title }];
  } else {
    plainFolds.value = plainFolds.value.filter((f) => f.line !== span.line);
  }
}
function togglePlainFold(block: PlainBlock) {
  const h = plainHeadingFor(block);
  if (h) setPlainFold(h, !plainFoldedLines.value.has(h.line));
}

// Edits move headings around; re-anchor rather than fold the wrong section.
watch(plainText, (text) => {
  if (!plainFolds.value.length) return;
  const next = remapFolds(text || '', plainFolds.value);
  const changed =
    next.length !== plainFolds.value.length ||
    next.some((f, i) => f.line !== plainFolds.value[i].line);
  if (changed) plainFolds.value = next;
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

function plainTocFingerprint(source: string): string {
  // FNV-1a keeps the cache key compact even for very large documents. The
  // source itself is still passed to renderMarkdown, but is not retained in up
  // to 300 historical Map keys while the user edits headings.
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash = Math.imul(hash ^ source.charCodeAt(i), 0x01000193);
  }
  return `${source.length}:${(hash >>> 0).toString(36)}`;
}

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
  const isTocBlock = /^[ \t]*\[toc\][ \t]*$/i.test(src);
  // A rendered live-edit block normally only sees its own source. TOC is the
  // exception: it needs the whole document's headings, and the cache key must
  // change when any of those headings changes.
  const tocSource = isTocBlock ? plainText.value || '' : undefined;
  const tocKey = tocSource === undefined ? '' : `\u0000toc:${plainTocFingerprint(tocSource)}`;
  const key = `${settings.markdownHardBreaks ? 'hb' : 'sb'}${settings.markdownAutoNumberHeadings ? 'nh' : ''}d${renderDepsVersion.value}\u0000${props.tab.filePath || ''}\u0000${root}\u0000${src}${tocKey}`;
  const cached = plainRenderCache.get(key);
  if (cached != null) return cached;
  const html = rewriteImageUrls(
    // Drop `disabled` on task checkboxes so they can be clicked to toggle in the
    // preview (handled by activatePlainBlockFromClick → togglePlainTask).
    renderMarkdown(src || '\n', { tocSource })
      .replace(
        /(<input class="task-list-item-checkbox" type="checkbox"[^>]*?)\s+disabled=""/g,
        '$1',
      )
      // #366 — markdown-it emits a hard break as `<br>\n`. Rendered `<p>` here
      // is `white-space: pre-wrap`, so that `\n` became a SECOND line break:
      // every line of a multi-line paragraph rendered double-spaced, then
      // snapped back to single spacing when clicked into (the textarea) — the
      // block's height halved/doubled on each click and the page jumped.
      .replace(/<br>\n/g, '<br>'),
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
  // Configure on demand rather than at setup: the theme is read here, so a
  // theme switch between renders is picked up, and a vault with no diagrams
  // never loads the renderer at all.
  const mermaid = mermaidBlocks.length
    ? await initMermaid({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: mermaidThemeFor(settings.theme),
      })
    : null;
  for (const block of Array.from(mermaidBlocks)) {
    if (!mermaid) break;
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
  if (tldrawBlocks.length === 0) {
    // No boards to swap in — the remaining code blocks are final, so hand
    // them their copy buttons and stop here.
    attachPlainCodeCopyButtons(hostEl);
    return;
  }
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

  attachPlainCodeCopyButtons(hostEl);
}

/**
 * v4.11.18 — give the Windows plain-block live editor the same one-click
 * copy button the preview pane has (#195). Runs after the mermaid /
 * PlantUML / tldraw passes have swapped their fences for rendered art, so
 * only real code blocks get a button. `renderMarkdown` has already stripped
 * the fence and any container indentation, so the button copies exactly the
 * code — never the leading spaces of a block nested in a list.
 */
function attachPlainCodeCopyButtons(hostEl: HTMLElement) {
  attachCodeCopyButtons(hostEl, {
    label: t('toolbar.copy'),
    onError: (err) => toasts.error(`Copy failed: ${err}`),
  });
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
    // #250 — a `$$` block is one block, like a code fence. Without this the
    // splitter walked into it line by line and any line indented 4+ spaces
    // (routine inside `aligned`) became its own indented-code block, so the
    // formula rendered as three pieces with a grey slab in the middle.
    // `$$E=mc^2$$` closes on its own line and is not an opener.
    if (/^\$\$/.test(trimmed) && !/^\$\$.*\$\$$/.test(trimmed)) return 'mathfence';
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

    if (kind === 'mathfence') {
      // Consume through the closing `$$`; an unclosed block runs to the end
      // of the document, matching the code-fence branch below.
      let j = i + 1;
      while (j < lines.length) {
        const t = lines[j].text.trim();
        j++;
        if (t.endsWith('$$')) break;
      }
      pushRange(line.start, lines[j - 1]?.end ?? line.end);
      i = j;
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
  if (!editor) return Math.max(16, (settings.fontSize || 16) * 1.8);
  const style = window.getComputedStyle(editor);
  const n = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(n) && n > 0) return n;
  const fs = Number.parseFloat(style.fontSize);
  return Number.isFinite(fs) && fs > 0 ? fs * 1.8 : 29;
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
  // Every selection-ish event in both plain paths funnels through here, so
  // it is also where the focus shade and the drawn caret get repainted.
  schedulePlainOverlays();
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

// ---- #316 — 专注模式 / 实心光标 on the plain <textarea> path ----
// Both ship as CodeMirror extensions (focusModeExtension, and drawSelection
// with cursorBlinkRate 0), so on Windows with Vim mode off — where there is
// no CodeMirror at all — the two switches silently did nothing. Same shape of
// gap as the line-number gutter (#161) and typewriter mode (#199) before them.
//
// Focus mode: the block editor already has one element per paragraph, so it
// dims by CSS class. The flat editor is a single <textarea> whose lines can't
// be styled individually, so two shade panels are laid over everything above
// and below the active paragraph instead — same rendered result as opacity
// 0.35 on the text, since they are painted in the editor's own background.
//
// Solid cursor: no CSS turns off the native caret's blink, so the textarea's
// caret is made transparent and a non-blinking 2px accent bar is drawn at
// measured coordinates — matching the CodeMirror cursor. The native caret is
// only hidden while a drawn one exists (and never mid-IME-composition), so a
// measurement that comes back empty leaves the user with a blinking caret
// rather than no caret at all.

const plainFocusMode = computed(() => usePlainWindowsEditor && props.focusMode);
const plainSolidCursor = computed(() => usePlainWindowsEditor && settings.solidCursor);

const plainCaretBox = ref<{ top: number; left: number; height: number } | null>(null);
const plainWindowFocused = ref(true);
const plainFocusBand = ref<{ top: number; bottom: number } | null>(null);
// Hide the native caret only while we are actually drawing one.
const plainSolidCaretOn = computed(() => !!plainCaretBox.value);
const plainShadeLeft = computed(() =>
  plainGutterEnabled.value ? `calc(${plainGutterWidth.value} + 21px)` : '0px',
);

function plainActiveTextarea(): HTMLTextAreaElement | null {
  return plainLiveEnabled.value
    ? plainBlockEditors.value[plainActiveBlock.value] ?? null
    : plainEditor.value;
}

/** Top of the given 1-based logical line, in flat-editor content px. */
function plainLineTopPx(line: number, lineHeight: number): number {
  const tops = plainLineTops.value;
  if (tops && line >= 1 && line <= tops.length) return tops[line - 1];
  return (line - 1) * lineHeight;
}

function computePlainFocusBand() {
  // The block editor dims by class; only the flat textarea needs geometry.
  if (!plainFocusMode.value || plainLiveEnabled.value) {
    plainFocusBand.value = null;
    return;
  }
  const el = plainEditor.value;
  if (!el) {
    plainFocusBand.value = null;
    return;
  }
  const text = el.value;
  const from = el.selectionStart ?? 0;
  const to = el.selectionEnd ?? from;
  const { first, last } = activeParagraphLines(text, from, to);
  const lh = plainLineHeightPx();
  const heights = plainLineHeights.value;
  const padTop = plainPaddingTopPx(el);
  const top = plainLineTopPx(first, lh);
  const lastTop = plainLineTopPx(last, lh);
  const lastHeight = heights.length === text.split('\n').length ? heights[last - 1] ?? lh : lh;
  plainFocusBand.value = {
    top: padTop + top - el.scrollTop,
    bottom: padTop + lastTop + lastHeight - el.scrollTop,
  };
}

function computePlainCaretBox() {
  if (!plainSolidCursor.value || plainComposing.value) {
    plainCaretBox.value = null;
    return;
  }
  const el = plainActiveTextarea();
  // No focus, another window in front, or a range selection — the native
  // caret would not be drawn either, so draw nothing.
  //
  // Window focus is tracked from the blur/focus events rather than read from
  // document.hasFocus(): a browser that reports focus wrongly (Unzoo answers
  // false for a frontmost window) would otherwise hide the caret forever,
  // which is the very failure this is fixing. Missing the event instead
  // leaves a caret drawn — visible, not absent.
  if (!el || document.activeElement !== el || !plainWindowFocused.value) {
    plainCaretBox.value = null;
    return;
  }
  const from = el.selectionStart ?? 0;
  if ((el.selectionEnd ?? from) !== from) {
    plainCaretBox.value = null;
    return;
  }
  const container = plainLiveEnabled.value ? plainLiveHost.value : el.parentElement;
  if (!container) {
    plainCaretBox.value = null;
    return;
  }
  const cs = window.getComputedStyle(el);
  const padTop = Number.parseFloat(cs.paddingTop) || 0;
  const padLeft = Number.parseFloat(cs.paddingLeft) || 0;
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  try {
    if (plainLiveEnabled.value) {
      // A block holds one paragraph, so mirroring all of it is cheap. The
      // host is the scroll container and the caret is absolutely positioned
      // inside its content, so it scrolls along without a scroll listener.
      const point = caretPointPx(el, el.value, from);
      plainCaretBox.value = {
        top: eRect.top - cRect.top + container.scrollTop + padTop + point.top,
        left: eRect.left - cRect.left + container.scrollLeft + padLeft + point.left,
        height: point.height,
      };
      return;
    }
    // Flat editor: mirror only the caret's own logical line — the whole
    // document would be laid out on every keystroke — and take the line's y
    // from the same measured tops the gutter and scroll sync use.
    const text = el.value;
    const lineStart = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
    const nl = text.indexOf('\n', lineStart);
    const lineText = text.slice(lineStart, nl < 0 ? text.length : nl);
    const point = caretPointPx(el, lineText, from - lineStart);
    const top =
      padTop + plainLineTopPx(lineAt(text, from), point.height) + point.top - el.scrollTop;
    // Scrolled out of the textarea's own viewport: nothing to draw.
    if (top + point.height < 0 || top > el.clientHeight) {
      plainCaretBox.value = null;
      return;
    }
    plainCaretBox.value = {
      top: eRect.top - cRect.top + top,
      left: eRect.left - cRect.left + padLeft + point.left - el.scrollLeft,
      height: point.height,
    };
  } catch {
    plainCaretBox.value = null;
  }
}

let cleanupPlainOverlays: (() => void) | null = null;
let plainOverlayRaf = 0;
/** Repaint the drawn caret and the focus shade, coalesced to one per frame. */
function schedulePlainOverlays() {
  if (!usePlainWindowsEditor) return;
  if (!plainFocusMode.value && !plainSolidCursor.value) {
    if (plainCaretBox.value) plainCaretBox.value = null;
    if (plainFocusBand.value) plainFocusBand.value = null;
    return;
  }
  if (plainOverlayRaf) return;
  plainOverlayRaf = requestAnimationFrame(() => {
    plainOverlayRaf = 0;
    computePlainFocusBand();
    computePlainCaretBox();
  });
}

watch([plainFocusMode, plainSolidCursor, plainLineHeights, plainLiveEnabled], () =>
  schedulePlainOverlays(),
);

function plainSetCaret(pos: number) {
  if (plainLiveEnabled.value) {
    const blocks = plainBlocks.value;
    // #343 — a block's `end` is the next block's `start` (it includes the
    // separating newline), so `pos <= end` matched the PREVIOUS block first for
    // any offset that begins a block. Every outline jump put the caret on the
    // line above the heading, and the outline highlighted the previous section.
    // Half-open ranges; only the document end (the trailing zero-width block,
    // or a last block with no newline) needs the closed comparison.
    let found = blocks.findIndex((block) => pos >= block.start && pos < block.end);
    if (found < 0) {
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (pos >= blocks[i].start && pos <= blocks[i].end) { found = i; break; }
      }
    }
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
  // The Insert-menu `$|$` caret markers were inserted literally here before.
  const parsed = parseInsertSnippet(snippet);
  if (plainLiveEnabled.value) {
    const index = plainActiveBlock.value;
    const el = plainBlockEditors.value[index];
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const nextBlock = `${el.value.slice(0, start)}${parsed.text}${el.value.slice(end)}`;
    // Blocks re-split after the edit, so only a caret survives here; it goes
    // after any placeholder label.
    updatePlainBlock(index, nextBlock, start + parsed.head);
    return;
  }
  const el = plainEditor.value;
  if (!el) return;
  recordPlainHistory();
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  const next = `${el.value.slice(0, start)}${parsed.text}${el.value.slice(end)}`;
  el.value = next;
  el.setSelectionRange(start + parsed.anchor, start + parsed.head);
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
  if (!el) {
    // #281 — the flat textarea may not exist *yet*. Watchers run before Vue
    // patches the DOM, so a tab switch that also flips `plainLiveEnabled`
    // (leaving live-edit markdown for a plain-text file) reaches here while
    // the `v-if` still holds the block-editor branch and this ref is null.
    // Bailing out left the gutter populated — it renders from `plainText`,
    // assigned just above — while the textarea that mounted a tick later was
    // empty: the "content blank but line numbers shown" report. Finish the
    // write once the branch has mounted, unless a newer document has since
    // claimed the editor.
    nextTick(() => {
      const late = plainEditor.value;
      if (!late || plainText.value !== text) return;
      if (late.value !== text) late.value = text;
      emitPlainCursorAndSelection();
      syncPlainLiveScroll();
    });
    return;
  }
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
  if (!plainComposing.value) {
    recordPlainHistory();
    // Ordered-list numbers follow a line added or removed (lib/list-renumber).
    const renum = props.tab.language === 'markdown' ? renumberAfterEdit(plainText.value, el.value) : null;
    if (renum) {
      const a = mapPos(el.selectionStart ?? 0, renum.changes);
      const b = mapPos(el.selectionEnd ?? 0, renum.changes);
      el.value = renum.value;
      el.setSelectionRange(a, b);
    }
  }
  plainText.value = el.value;
  tabs.setContent(props.tab.id, el.value);
  emitPlainCursorAndSelection();
  // Gitee IK6JCC — the / ⁠[[ # @ autocomplete used to be wired only to the
  // live-edit *block* editor, so on Windows (which is on this plain-textarea
  // path unless Vim mode is on) it silently did nothing in 仅编辑 / 分栏 mode.
  // Same trigger the block editor uses.
  maybeOpenPlainAutocomplete(el);
  if (!plainComposing.value) noteTypedInTextarea(el, event);
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
const plainReplaceInput = ref<HTMLInputElement | null>(null);
const plainMatches = ref<Array<{ start: number; end: number }>>([]);
const plainMatchIndex = ref(0);
// Where the caret was when the find bar opened: typing a query jumps to the
// first match from here on, the way Notepad and VS Code do, not from the top.
let plainFindAnchor = 0;
// #330 — the current match, drawn. Focus stays in the find box while you step
// through matches (so Enter means "next", not "replace the match with a line
// break"), and a <textarea> paints no selection while it is unfocused.
const plainFindBoxes = ref<Array<{ top: number; left: number; width: number; height: number }>>([]);
// Docks the find bar at the bottom while the current match sits under it.
const plainFindDodge = ref(false);
const plainFindBar = ref<HTMLElement | null>(null);

function plainCaretDocOffset(): number {
  if (plainLiveEnabled.value) {
    const el = plainBlockEditors.value[plainActiveBlock.value];
    const b = plainBlocks.value[plainActiveBlock.value];
    return b ? b.start + (el?.selectionStart ?? 0) : 0;
  }
  return plainEditor.value?.selectionStart ?? 0;
}

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

function openPlainFind(replace = false) {
  const wasOpen = plainFindOpen.value;
  plainFindOpen.value = true;
  if (!wasOpen) plainFindAnchor = plainCaretDocOffset();
  const selected = plainSelectionText();
  if (selected && !selected.includes('\n')) plainFindQuery.value = selected;
  nextTick(() => {
    // Replace (Ctrl+H) lands in the replace field when there is already
    // something to find; with an empty query it starts where the user must.
    const target = replace && plainFindQuery.value ? plainReplaceInput.value : plainFindInput.value;
    target?.focus();
    target?.select();
    revealPlainMatchFromAnchor();
  });
}

/**
 * Close the bar. From Esc / ✕ (`toMatch`) the editor takes focus with the
 * current match selected, so you land where you searched to — the one moment
 * the editor gets focus from the find bar. Closing because the tab changed
 * must not: the match belongs to the previous document.
 */
function closePlainFind(toMatch = false) {
  const m = plainMatches.value[plainMatchIndex.value];
  plainFindOpen.value = false;
  plainFindBoxes.value = [];
  plainFindDodge.value = false;
  if (toMatch && m && plainFindQuery.value) selectPlainRange(m.start, m.end, true);
}

/** Jump to the first match at or after where the caret was when the bar opened. */
function revealPlainMatchFromAnchor() {
  runPlainSearch();
  const ms = plainMatches.value;
  if (!ms.length) {
    plainFindBoxes.value = [];
    return;
  }
  const i = ms.findIndex((m) => m.start >= plainFindAnchor);
  plainMatchIndex.value = i < 0 ? 0 : i;
  const m = ms[plainMatchIndex.value];
  selectPlainRange(m.start, m.end);
}

/** Enter → next match, Shift+Enter → previous; focus stays in the box. */
function onPlainFindEnter(event: KeyboardEvent) {
  // The Enter that commits an IME candidate is the IME's, not ours.
  if (event.isComposing || event.keyCode === 229) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  gotoPlainMatch(event.shiftKey ? -1 : 1);
}

function onPlainFindInput(value: string, composing = false) {
  plainFindQuery.value = value;
  // Not mid-IME-composition: moving the editor's selection while a Chinese
  // IME is composing in this box cancels the composition, and the typed
  // characters vanish. Jump once the composition commits (compositionend).
  if (composing) return;
  revealPlainMatchFromAnchor();
}

/**
 * Select [start, end) in the plain editor and scroll it to the middle of the
 * view. The editor is only focused when `focusEditor` is set: stepping
 * through matches must leave focus in the find box, or the next Enter lands
 * in the document and replaces the match with a line break (#330).
 */
function selectPlainRange(start: number, end: number, focusEditor = false) {
  if (plainLiveEnabled.value) {
    const blocks = plainBlocks.value;
    const bi = blocks.findIndex((b) => start >= b.start && start < b.end);
    plainActiveBlock.value = bi < 0 ? Math.max(0, blocks.length - 1) : bi;
    nextTick(() => {
      const el = plainBlockEditors.value[plainActiveBlock.value];
      const b = plainBlocks.value[plainActiveBlock.value];
      if (!el || !b) return;
      // preventScroll: focus() otherwise scrolls the whole textarea into view
      // — for a tall block, its top — and the view visibly bounced from there
      // back to the match (#330).
      if (focusEditor) el.focus({ preventScroll: true });
      const s = Math.max(0, Math.min(start - b.start, el.value.length));
      const e = Math.max(s, Math.min(end - b.start, el.value.length));
      el.setSelectionRange(s, e);
      // Centre the *match*, not the block: a block can be a several-screen
      // code fence or paragraph, and centring that leaves the match off-screen.
      // Size it first — a just-mounted textarea is still two rows tall, and the
      // host would clamp the scroll to a document that short.
      autoSizePlainBlock(el);
      const host = plainLiveHost.value;
      if (host) {
        const y = el.getBoundingClientRect().top - host.getBoundingClientRect().top
          + plainPaddingTopPx(el) + caretTopPx(el, el.value, s);
        host.scrollTop = Math.max(0, host.scrollTop + y - host.clientHeight / 2);
      } else {
        el.scrollIntoView({ block: 'center' });
      }
      emitPlainCursorAndSelection();
      updatePlainFindBoxes();
      pinPlainBlockInView();
    });
    return;
  }
  const el = plainEditor.value;
  if (!el) return;
  if (focusEditor) el.focus({ preventScroll: true });
  el.setSelectionRange(start, end);
  // #255 — setSelectionRange() selects but never scrolls a <textarea>, so in a
  // long document the counter moved ("3/12") while the view stayed put.
  el.scrollTop = Math.max(0, plainPaddingTopPx(el) + caretTopPx(el, el.value, start) - el.clientHeight / 2);
  emitPlainCursorAndSelection();
  updatePlainFindBoxes();
}

// #330 — "it finds the right place, then bounces up a few lines". Blocks above
// the match keep changing height after the jump: the block that was being
// edited goes back to rendered HTML, and code highlighting, maths and diagrams
// render asynchronously. The browser's scroll anchoring absorbs some of that,
// but only for changes above its anchor node — near the top of the view — so
// a block that grows between there and the match still pushes the match out
// of the spot it was scrolled to. For a moment after a jump, follow the match:
// whatever it moved on screen, scroll by the same. Stops once the user
// scrolls, clicks or types.
let plainPinRaf = 0;
let plainPinStop: (() => void) | null = null;
function pinPlainBlockInView() {
  plainPinStop?.();
  const host = plainLiveHost.value;
  if (!host) return;
  // Re-read the active textarea each frame rather than holding one: the block
  // list re-renders around a jump, and a stale element reports a stale place.
  const current = () => plainBlockEditors.value[plainActiveBlock.value] ?? null;
  const topOf = () => {
    const el = current();
    return el ? el.getBoundingClientRect().top - host.getBoundingClientRect().top : null;
  };
  let last = topOf();
  const until = performance.now() + 1500;
  const stop = () => {
    cancelAnimationFrame(plainPinRaf);
    plainPinRaf = 0;
    host.removeEventListener('wheel', stop);
    host.removeEventListener('pointerdown', stop);
    host.removeEventListener('keydown', stop);
    if (plainPinStop === stop) plainPinStop = null;
  };
  plainPinStop = stop;
  host.addEventListener('wheel', stop, { passive: true });
  host.addEventListener('pointerdown', stop);
  host.addEventListener('keydown', stop);
  let lastEl = current();
  const tick = () => {
    const now = topOf();
    if (now == null || last == null || performance.now() > until) {
      stop();
      return;
    }
    const el = current();
    if (Math.abs(now - last) > 0.5) {
      host.scrollTop += now - last;
      last = topOf();
    }
    // A new element needs its highlight measured again.
    if (el !== lastEl) updatePlainFindBoxes();
    lastEl = el;
    plainPinRaf = requestAnimationFrame(tick);
  };
  plainPinRaf = requestAnimationFrame(tick);
}

// Flat editor: the match's rects in text-flow px, cached so that scrolling
// only re-positions them — measuring means laying the whole document out in
// the mirror, which is fine once per jump and not once per scroll frame.
let plainFindFlowCache: {
  text: string;
  start: number;
  end: number;
  width: number;
  rects: Array<{ top: number; left: number; width: number; height: number }>;
} | null = null;

function matchFlowRects(el: HTMLTextAreaElement, text: string, s: number, e: number) {
  const a = caretPointPx(el, text, s);
  const b = caretPointPx(el, text, e);
  if (Math.abs(a.top - b.top) < a.height / 2) {
    return [{ top: a.top, left: a.left, width: Math.max(2, b.left - a.left), height: a.height }];
  }
  // Soft-wrapped across rows: to the end of the first row, from the start of
  // the last. (A query has no line breaks, so it spans two rows at most in
  // practice.)
  const cs = window.getComputedStyle(el);
  const contentW = el.clientWidth
    - (Number.parseFloat(cs.paddingLeft) || 0) - (Number.parseFloat(cs.paddingRight) || 0);
  return [
    { top: a.top, left: a.left, width: Math.max(2, contentW - a.left), height: a.height },
    { top: b.top, left: 0, width: Math.max(2, b.left), height: b.height },
  ];
}

/** Re-draw the current-match highlight (and dodge the bar if it covers it). */
function updatePlainFindBoxes() {
  const m = plainFindOpen.value && plainFindQuery.value
    ? plainMatches.value[plainMatchIndex.value]
    : null;
  const el = plainActiveTextarea();
  if (!m || !el) {
    plainFindBoxes.value = [];
    return;
  }
  const cs = window.getComputedStyle(el);
  const padTop = Number.parseFloat(cs.paddingTop) || 0;
  const padLeft = Number.parseFloat(cs.paddingLeft) || 0;
  let boxes: Array<{ top: number; left: number; width: number; height: number }>;
  if (plainLiveEnabled.value) {
    const b = plainBlocks.value[plainActiveBlock.value];
    const block = el.parentElement;
    if (!b || !block || m.start < b.start || m.end > b.end) {
      plainFindBoxes.value = [];
      return;
    }
    // Relative to the block the boxes are rendered in (see the template).
    const bRect = block.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const ox = eRect.left - bRect.left + padLeft;
    const oy = eRect.top - bRect.top + padTop;
    boxes = matchFlowRects(el, el.value, m.start - b.start, m.end - b.start)
      .map((r) => ({ ...r, left: r.left + ox, top: r.top + oy }));
  } else {
    const text = el.value;
    const width = el.clientWidth;
    const c = plainFindFlowCache;
    const rects = c && c.text === text && c.start === m.start && c.end === m.end && c.width === width
      ? c.rects
      : matchFlowRects(el, text, m.start, m.end);
    plainFindFlowCache = { text, start: m.start, end: m.end, width, rects };
    const container = el.parentElement;
    if (!container) {
      plainFindBoxes.value = [];
      return;
    }
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const ox = eRect.left - cRect.left + padLeft - el.scrollLeft;
    const oy = eRect.top - cRect.top + padTop - el.scrollTop;
    boxes = rects
      .map((r) => ({ ...r, left: r.left + ox, top: r.top + oy }))
      // Scrolled out of the textarea's own viewport: nothing to draw.
      .filter((r) => r.top + r.height > eRect.top - cRect.top && r.top < eRect.bottom - cRect.top);
  }
  plainFindBoxes.value = boxes;
  nextTick(updatePlainFindDodge);
}

// #330 — "the find box covers what I searched for". Centring keeps a match
// clear of the bar except near the very top of the document, where there is
// no room to scroll it lower; there, the bar steps aside to the bottom.
function updatePlainFindDodge() {
  const bar = plainFindBar.value;
  const el = plainActiveTextarea();
  if (!bar || !el || !plainFindBoxes.value.length) {
    plainFindDodge.value = false;
    return;
  }
  // Both editors lay the boxes out in the textarea's parent (the block, or the
  // flat editor's frame); the bar is positioned in its own offset parent.
  // Compare in viewport coordinates.
  const container = el.parentElement;
  const frame = bar.offsetParent as HTMLElement | null;
  if (!container || !frame) return;
  const cRect = container.getBoundingClientRect();
  const fRect = frame.getBoundingClientRect();
  // Judge against where the bar sits when docked at the top (top: 8px,
  // right: 16px), whichever way it is docked now — or it would flip back and
  // forth between the two.
  const barRight = fRect.right - 16;
  const barLeft = barRight - bar.offsetWidth;
  const barTop = fRect.top + 8;
  const barBottom = barTop + bar.offsetHeight;
  plainFindDodge.value = plainFindBoxes.value.some((r) => {
    const top = cRect.top + r.top;
    const left = cRect.left + r.left;
    return top < barBottom && top + r.height > barTop && left + r.width > barLeft && left < barRight;
  });
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
    } else {
      plainFindBoxes.value = [];
    }
  });
}

// Edits made while the bar is open (typing in the document, undo, a replace)
// move every match after them; recount so the counter and the highlight stay
// on real text instead of on stale offsets.
watch(plainText, () => {
  if (!plainFindOpen.value || !plainFindQuery.value) return;
  runPlainSearch();
  plainFindFlowCache = null;
  nextTick(updatePlainFindBoxes);
});

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
// # tags, @ citations, ``` fence languages). Triggers as you type; ↑/↓
// navigate, Enter/Tab insert, Esc dismisses. Reuses the same data the
// CodeMirror editor uses. ----
type AcKind = 'slash' | 'wikilink' | 'tag' | 'citation' | 'fence';
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
  // ``` fence languages (#297) — the same catalogue the CodeMirror source
  // uses, so both editors offer the same rows in the same order.
  if (kind === 'fence') {
    return filterFenceLanguages(query, 10).map((lang) => ({
      label: lang.name,
      hint: lang.hint,
      insert: lang.name,
      cursorOffset: lang.name.length,
    }));
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
  if (plainComposing.value) return;
  const caret = el.selectionStart ?? 0;
  const before = el.value.slice(0, caret);
  let kind: AcKind | null = null;
  let query = '';
  let m: RegExpMatchArray | null;
  if ((m = before.match(/(?:^|\n)[ \t]*\/([^\s/]*)$/))) { kind = 'slash'; query = m[1]; acTriggerStart = caret - m[1].length - 1; }
  else if ((m = before.match(/\[\[([^\]\n]*)$/))) { kind = 'wikilink'; query = m[1]; acTriggerStart = caret - m[1].length - 2; }
  else if ((m = before.match(/(?:^|[\s(])#([^\s#]*)$/))) { kind = 'tag'; query = m[1]; acTriggerStart = caret - m[1].length - 1; }
  else if ((m = before.match(/(?:^|[\s(])@([^\s@]*)$/))) { kind = 'citation'; query = m[1]; acTriggerStart = caret - m[1].length - 1; }
  else {
    // ``` fence opener (#297). Same helper the CodeMirror source uses, so the
    // two editors cannot disagree about what counts as an opener — and the
    // same "already inside a fence" test, so typing the *closing* fence never
    // pops a list whose Enter would insert a language into it.
    const opener = settings.fenceLanguageSuggestions ? matchFenceOpener(before) : null;
    if (opener && !isInsideFenceBefore(before.slice(0, before.lastIndexOf('\n') + 1))) {
      kind = 'fence';
      query = opener.query;
      acTriggerStart = opener.queryStart;
    }
  }
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
  // F-7 — list items nest at their parent's content column, as in CodeMirror.
  const list = props.tab.language === 'markdown' ? listIndentEdit(v, s, e, outdent) : null;
  if (list) {
    return { value: v.slice(0, list.from) + list.insert + v.slice(list.to), selStart: list.selFrom, selEnd: list.selTo };
  }
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
 * Markdown list / quote continuation on Enter (#341) — same rule for both
 * plain editors, see lib/list-continuation.ts. Returns null to let the
 * textarea insert a plain newline.
 */
function computeSmartEnter(el: HTMLTextAreaElement): { value: string; caret: number } | null {
  return computeListContinuation(el.value, el.selectionStart ?? 0, el.selectionEnd ?? 0);
}

/** A bare Enter that is not part of an IME composition. */
function isPlainEnter(event: KeyboardEvent): boolean {
  return (
    event.key === 'Enter' &&
    !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey &&
    !event.isComposing && event.keyCode !== 229
  );
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
  if (plainComposing.value) return;
  if (handleAutocompleteKeydown(event)) return;
  if (handlePlainKeydownShared(event)) return;
  if (handlePlainCrossBlockNav(event)) return;
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
  // as a single whole-document <textarea> would. Ctrl+Backspace / Ctrl+Delete
  // (word delete) take the same step at the boundary, where the block has no
  // word left to delete; inside the block, and for a selection, the browser
  // keeps its own word-delete / selection-delete.
  if (
    (event.key === 'Backspace' || event.key === 'Delete') &&
    !event.metaKey && !event.altKey
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
  if (isPlainEnter(event)) {
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
  if (plainComposing.value) return;
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
    return;
  }
  // #341 — the flat textarea (edit-only / split) never had list continuation;
  // only the live-edit blocks did.
  if (isPlainEnter(event)) {
    const el = event.target as HTMLTextAreaElement;
    const smart = computeSmartEnter(el);
    if (!smart) return;
    event.preventDefault();
    recordPlainHistory();
    el.value = smart.value;
    el.setSelectionRange(smart.caret, smart.caret);
    plainText.value = smart.value;
    tabs.setContent(props.tab.id, smart.value);
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

/**
 * mapRenderedPrefixToSource for a whole live-edit block. A fenced code block's
 * opening fence line (```` ```lang ````) is not rendered at all, so the
 * rendered text is matched against the code body only — otherwise letters of
 * the info string (`c` in ```` ```c ````) could pair with the code's first
 * characters and skew the offset.
 */
function mapBlockPrefixToSource(source: string, renderedPrefix: string): number {
  const fence = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n/.exec(source);
  if (!fence) return mapRenderedPrefixToSource(source, renderedPrefix);
  const bodyStart = fence[0].length;
  return bodyStart + mapRenderedPrefixToSource(source.slice(bodyStart), renderedPrefix);
}

/** Visible text from the start of `render` up to (node, offset), or null. */
function renderedPrefixAtNode(render: HTMLElement, node: Node, offset: number): string | null {
  if (!render.contains(node)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(render);
  try {
    pre.setEnd(node, offset);
  } catch {
    return null;
  }
  return pre.toString();
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
  return node ? renderedPrefixAtNode(render, node, offset) : null;
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
    return mapBlockPrefixToSource(block.text, renderedPrefix);
  }

  // Fallback: estimate the clicked line from the vertical position and place
  // the caret at that line's start.
  const lines = block.text.split('\n');
  if (lines.length <= 1) return 0;
  const rect = render.getBoundingClientRect();
  const style = window.getComputedStyle(render);
  const lineHeight = Number.parseFloat(style.lineHeight) || (Number.parseFloat(style.fontSize) || 16) * 1.8;
  const lineIndex = Math.max(0, Math.min(lines.length - 1, Math.floor((event.clientY - rect.top) / lineHeight)));
  let caret = 0;
  for (let i = 0; i < lineIndex; i++) caret += lines[i].length + 1;
  return caret;
}

function activatePlainBlockFromClick(index: number, event: MouseEvent) {
  // The click ending a cross-block drag selection (see onPlainDragEnd).
  if (plainSwallowClick) {
    plainSwallowClick = false;
    event.preventDefault();
    return;
  }
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
  // A rendered link is text being edited: a click places the caret in it, as
  // in Typora; Ctrl+click (⌘ on macOS) opens it the way the preview does. The
  // webview must never follow it itself — that replaced the whole UI with the
  // page, with no way back but right-click → Back.
  const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
  if (anchor) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      openRenderedLink(anchor, event, props.tab.filePath);
      return;
    }
  }
  if (index === plainActiveBlock.value) return;
  // #300 — a drag that selected rendered text ends in a click too. Turning
  // the block into a textarea at that point throws the selection away and
  // moves the page under someone who was only reading (or about to copy).
  // #374 — except inside a rendered code block, where a multi-line selection
  // (a triple-click selects the whole block) moves into the editable view.
  if (enterPlainRangeFromRenderedCode(index)) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().length > 0) return;
  activatePlainBlock(index, estimatePlainBlockCaretFromClick(index, event), true);
}

/**
 * #374 — a multi-line page selection inside a rendered code block of block
 * `index`, mapped back to the source; null when there is none.
 *
 * The Windows live editor kept a drag *inside one block* as a native
 * selection over the rendered HTML (#300: someone reading or copying must
 * not have the block turn into a textarea under them). Across blocks the
 * same kind of selection crashed WebView2 in the Windows text input
 * framework (textinputframework.dll, 0xc0000005) and took the app down;
 * 0a2e2cac moved those drags into the merged single-textarea view. A fenced
 * code block is ONE block, so ten lines selected in its highlighted render
 * (dozens of hljs spans, line-number wrappers, the copy button) stayed on the
 * old path — the one left that matches the reported freeze. Code is the render whose
 * text is the source verbatim, so the range maps back exactly.
 */
function plainRenderedCodeSelection(index: number): { anchor: number; head: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return null;
  const block = plainBlocks.value[index];
  const el = plainLiveHost.value?.querySelectorAll<HTMLElement>(':scope > .plain-block')[index];
  const render = el?.querySelector<HTMLElement>('.plain-block__render');
  if (!block || !render) return null;
  const range = sel.getRangeAt(0);
  if (!render.contains(range.startContainer) || !render.contains(range.endContainer)) return null;
  const inCode = (n: Node) => !!(n instanceof Element ? n : n.parentElement)?.closest('pre');
  if (!inCode(range.startContainer) && !inCode(range.endContainer)) return null;
  // One line is a word or a phrase — leave a reading selection that small
  // alone, as everywhere else in rendered text.
  if (!range.toString().includes('\n')) return null;
  const at = (node: Node, offset: number) => {
    const prefix = renderedPrefixAtNode(render, node, offset);
    return prefix == null ? null : block.start + mapBlockPrefixToSource(block.text, prefix);
  };
  const anchor = at(sel.anchorNode, sel.anchorOffset);
  const head = at(sel.focusNode, sel.focusOffset);
  if (anchor == null || head == null || anchor === head) return null;
  return { anchor, head };
}

/** Move a rendered-code selection (see above) into the merged textarea view. */
function enterPlainRangeFromRenderedCode(index: number): boolean {
  const range = plainRenderedCodeSelection(index);
  if (!range) return false;
  enterPlainRangeSelection(range.anchor, range.head);
  return true;
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

/**
 * `holdScroll` is for activation by mouse: the block under the pointer must
 * stay under the pointer. Two things used to move it (#300) — the previously
 * active block re-rendering to a different height somewhere above, and
 * focus() scrolling the new textarea into view before it had been sized.
 * Keyboard navigation leaves it off, because there following the caret is the
 * point.
 */
function activatePlainBlock(index: number, caret?: number, holdScroll = false) {
  const target = Math.max(0, Math.min(index, plainBlocks.value.length - 1));
  const host = plainLiveHost.value;
  const blockEl = holdScroll && host
    ? host.querySelectorAll<HTMLElement>(':scope > .plain-block')[target] ?? null
    : null;
  const topBefore = blockEl ? blockEl.getBoundingClientRect().top : 0;
  plainActiveBlock.value = target;
  nextTick(() => {
    const el = plainBlockEditors.value[plainActiveBlock.value];
    if (!el) return;
    el.focus({ preventScroll: holdScroll });
    if (caret != null) {
      const pos = Math.max(0, Math.min(caret, el.value.length));
      el.setSelectionRange(pos, pos);
    }
    autoSizePlainBlock(el);
    if (blockEl && host && blockEl.isConnected) {
      host.scrollTop += blockEl.getBoundingClientRect().top - topBefore;
    }
    emitPlainCursorAndSelection();
  });
}

/**
 * #326 — a click on the editor's blank space (below the last block, or in the
 * gaps between blocks) landed on the host itself, which has no handler: on a
 * new, empty note the whole page ignored clicks and looked frozen. Put the
 * caret at the end of the nearest block — the last one when clicking below
 * the text, which is where every other editor puts it.
 */
/** The visible block nearest to viewport y (folded blocks are skipped). */
function plainBlockIndexAtY(y: number): number {
  const host = plainLiveHost.value;
  if (!host) return -1;
  const els = host.querySelectorAll<HTMLElement>(':scope > .plain-block');
  let best = -1;
  let bestDist = Infinity;
  els.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    if (r.height === 0) return;
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

/**
 * The document offset under a viewport point, whatever is there: rendered
 * text (mapped back to the source), the active block's textarea, or the gap
 * beside a block (its start or end).
 */
function plainDocOffsetAtPoint(x: number, y: number): { abs: number; block: number } | null {
  const host = plainLiveHost.value;
  const index = plainBlockIndexAtY(y);
  const block = plainBlocks.value[index];
  const el = host?.querySelectorAll<HTMLElement>(':scope > .plain-block')[index];
  if (!block || !el) return null;
  const r = el.getBoundingClientRect();
  if (y < r.top) return { abs: block.start, block: index };
  if (y > r.bottom) return { abs: block.start + block.text.length, block: index };
  const ta = index === plainActiveBlock.value ? plainBlockEditors.value[index] : null;
  if (ta) return { abs: block.start + offsetAtPoint(ta, ta.value, x, y), block: index };
  const render = el.querySelector<HTMLElement>('.plain-block__render');
  const prefix = render ? renderedPrefixAtPoint(render, x, y) : null;
  const local = prefix != null
    ? mapBlockPrefixToSource(block.text, prefix)
    : x < r.left + r.width / 2 ? 0 : block.text.length;
  return { abs: block.start + local, block: index };
}

// Selecting across blocks with the mouse. Each block is either rendered HTML
// or (the active one) its own textarea, so a native drag can't make an
// editable selection across them: it stopped at the active textarea, worked
// in one direction only, and what it did select could not be bolded or
// deleted. A drag that crosses blocks (or starts beside one) therefore ends in
// the merged single-textarea view that select-all uses, with exactly the
// dragged range selected — where Ctrl+B, Delete and typing all work.
let plainDrag: { abs: number; block: number; x: number; y: number; moved: boolean; gap: number | null } | null = null;
let plainSwallowClick = false;

function onPlainLiveHostMouseDown(event: MouseEvent) {
  const host = plainLiveHost.value;
  if (!host || event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, input, .plain-find')) return;
  const clicks = plainClickCount(event);
  if (maybeSelectPlainParagraph(event, clicks)) return;
  if (maybeExtendPlainSelectionByClick(event)) return;
  if (event.shiftKey || plainSelectAll.value) return;
  const start = plainDocOffsetAtPoint(event.clientX, event.clientY);
  const onGap = target === host;
  if (start) {
    plainDrag = { ...start, x: event.clientX, y: event.clientY, moved: false, gap: onGap ? start.block : null };
    window.addEventListener('mousemove', onPlainDragMove);
    window.addEventListener('mouseup', onPlainDragEnd);
  }
  if (!onGap) return;
  // Keep the host from taking focus and the browser from starting a text
  // selection on it. A plain click in the gap activates the nearest block on
  // mouseup; a drag from here selects instead.
  event.preventDefault();
  if (!start) {
    const best = plainBlockIndexAtY(event.clientY);
    if (best >= 0) activatePlainBlock(best, Number.MAX_SAFE_INTEGER, true);
  }
}

function onPlainDragMove(event: MouseEvent) {
  if (!plainDrag || plainDrag.moved) return;
  if (Math.abs(event.clientX - plainDrag.x) + Math.abs(event.clientY - plainDrag.y) > 4) plainDrag.moved = true;
}

function onPlainDragEnd(event: MouseEvent) {
  window.removeEventListener('mousemove', onPlainDragMove);
  window.removeEventListener('mouseup', onPlainDragEnd);
  const drag = plainDrag;
  plainDrag = null;
  if (!drag) return;
  if (!drag.moved) {
    if (drag.gap != null) activatePlainBlock(drag.gap, Number.MAX_SAFE_INTEGER, true);
    return;
  }
  const end = plainDocOffsetAtPoint(event.clientX, event.clientY);
  if (!end || end.abs === drag.abs) return;
  // Inside one block the native selection is right (and #300 keeps a reading
  // selection in rendered text as it is) — but not over several lines of a
  // rendered code block (#374, see plainRenderedCodeSelection).
  if (end.block === drag.block && drag.gap == null) {
    const code = drag.block !== plainActiveBlock.value ? plainRenderedCodeSelection(drag.block) : null;
    if (!code) return;
    plainSwallowClick = true;
    setTimeout(() => { plainSwallowClick = false; }, 0);
    enterPlainRangeSelection(code.anchor, code.head);
    return;
  }
  // The click that follows this mouseup must not activate a block and undo it.
  plainSwallowClick = true;
  setTimeout(() => { plainSwallowClick = false; }, 0);
  enterPlainRangeSelection(drag.abs, end.abs);
}

function setPlainBlockEditor(index: number, el: HTMLTextAreaElement | null) {
  plainBlockEditors.value[index] = el;
  if (!el) return;
  const block = plainBlocks.value[index];
  if (block && el.value !== block.text) el.value = block.text;
  nextTick(() => autoSizePlainBlock(el));
}

function autoSizePlainBlock(el: HTMLTextAreaElement) {
  // Collapsing to `auto` to measure shortens the whole document for an
  // instant, and the host clamps its scrollTop to that shorter document and
  // does not give it back. Deep inside a tall block (a long code fence) that
  // threw the view a screenful or more upwards (#255, #300).
  const host = plainLiveHost.value;
  const keep = host ? host.scrollTop : 0;
  el.style.height = 'auto';
  el.style.height = `${Math.max(plainLineHeightPx(), el.scrollHeight)}px`;
  if (host && host.scrollTop !== keep) host.scrollTop = keep;
}

function handlePlainBlockInput(index: number, event: Event) {
  const el = event.target as HTMLTextAreaElement;
  autoSizePlainBlock(el);
  schedulePlainOverlays();
  if (plainComposing.value) return;
  // Before updatePlainBlock: a re-split can swap this textarea for another.
  noteTypedInTextarea(el, event);
  updatePlainBlock(index, el.value, el.selectionStart ?? el.value.length);
  maybeOpenPlainAutocomplete(el);
}

function handlePlainBlockCompositionStart() {
  plainComposing.value = true;
  // Give the native caret back for the duration of the composition: the
  // composed text is drawn by the textarea itself and a measured caret
  // cannot follow it.
  schedulePlainOverlays();
}

function handlePlainBlockCompositionEnd(index: number, event: CompositionEvent) {
  plainComposing.value = false;
  schedulePlainOverlays();
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
  if (!plainComposing.value) recordPlainHistory();
  const renum = !plainComposing.value && props.tab.language === 'markdown'
    ? renumberAfterEdit(plainText.value, next)
    : null;
  if (renum) {
    next = renum.value;
    absoluteCaret = mapPos(absoluteCaret, renum.changes);
  }
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
 * The merged single-textarea view of select-all, with `anchor`→`head`
 * selected instead of everything (a mouse drag across blocks). Exits the same
 * way: once the selection collapses.
 */
function enterPlainRangeSelection(anchor: number, head: number) {
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  plainSelectAllPending = true;
  plainSelectAll.value = true;
  plainActiveBlock.value = 0;
  try {
    window.getSelection()?.removeAllRanges();
  } catch {
    /* no page selection API */
  }
  nextTick(() => {
    const el = plainBlockEditors.value[0];
    if (!el) {
      plainSelectAllPending = false;
      plainSelectAll.value = false;
      return;
    }
    el.focus({ preventScroll: true });
    autoSizePlainBlock(el);
    el.setSelectionRange(from, to, head < anchor ? 'backward' : 'forward');
    plainSelectAllPending = false;
    emitPlainCursorAndSelection();
  });
}

// ── Cross-block keyboard navigation (Windows live editor) ────────────────
// Each block is its own <textarea>, so the browser's Ctrl+Home/End and
// Ctrl+↑/↓ (and their Shift forms) stopped at the edge of the current block.
// They are done here against document offsets instead: a caret move lands in
// whichever block holds the target, and a selection that leaves the block
// moves into the merged single-textarea view that select-all and cross-block
// drags use (enterPlainRangeSelection), where every edit command works.

/** The document as blocks, whatever the view (the merged view is one block). */
function plainDocBlocks() {
  return splitPlainMarkdownBlocks(plainText.value || '');
}

/** A block start inside a folded section is not a place the caret can go. */
function plainOffsetFolded(abs: number): boolean {
  return plainFoldRanges.value.some((r) => abs > r.from && abs < r.to);
}

/** The visible document's first and last caret positions. */
function plainDocEdges(): { start: number; end: number } {
  const blocks = plainDocBlocks();
  let end = (plainText.value || '').length;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (plainOffsetFolded(b.start)) continue;
    end = b.start + b.text.length;
    break;
  }
  return { start: 0, end };
}

function plainParagraphStarts(): number[] {
  return docParagraphStarts(plainDocBlocks()).filter((s) => !plainOffsetFolded(s));
}

/** The active textarea's selection as document offsets. */
function plainAbsSelectionEnds(): { anchor: number; head: number } | null {
  const el = plainBlockEditors.value[plainActiveBlock.value];
  const block = plainBlocks.value[plainActiveBlock.value];
  if (!el || !block) return null;
  const { anchor, head } = selectionEnds(el.selectionStart ?? 0, el.selectionEnd ?? 0, el.selectionDirection);
  return { anchor: block.start + anchor, head: block.start + head };
}

/** Scroll the live host just enough to show document offset `abs`. */
function plainRevealAbs(abs: number) {
  const host = plainLiveHost.value;
  const el = plainBlockEditors.value[plainActiveBlock.value];
  const block = plainBlocks.value[plainActiveBlock.value];
  if (!host || !el || !block) return;
  autoSizePlainBlock(el);
  const local = Math.max(0, Math.min(abs - block.start, el.value.length));
  let caretY: number;
  try {
    caretY = caretTopPx(el, el.value, local);
  } catch {
    caretY = 0;
  }
  const y = el.getBoundingClientRect().top - host.getBoundingClientRect().top + plainPaddingTopPx(el) + caretY;
  const lh = plainLineHeightPx();
  const margin = Math.min(lh * 2, host.clientHeight / 4);
  if (y < margin) host.scrollTop = Math.max(0, host.scrollTop + y - margin);
  else if (y + lh > host.clientHeight - margin) host.scrollTop += y + lh - host.clientHeight + margin;
}

/** Collapse the caret at document offset `abs`, in whichever block holds it. */
function plainMoveCaretAbs(abs: number) {
  if (plainSelectAll.value) {
    const el = plainBlockEditors.value[plainActiveBlock.value];
    if (!el) return;
    el.setSelectionRange(abs, abs);
    maybeExitPlainSelectAll();
  } else {
    plainSetCaret(abs);
  }
  // After the activation's own nextTick has placed the caret.
  nextTick(() => {
    plainRevealAbs(abs);
    emitPlainCursorAndSelection();
  });
}

/** Select `anchor`→`head` (document offsets), across blocks if need be. */
function plainSelectAbs(anchor: number, head: number) {
  const el = plainBlockEditors.value[plainActiveBlock.value];
  const block = plainBlocks.value[plainActiveBlock.value];
  if (!el || !block) return;
  if (anchor === head) {
    plainMoveCaretAbs(head);
    return;
  }
  const lo = block.start;
  const hi = block.start + el.value.length;
  if (anchor >= lo && anchor <= hi && head >= lo && head <= hi) {
    el.setSelectionRange(Math.min(anchor, head) - lo, Math.max(anchor, head) - lo, head < anchor ? 'backward' : 'forward');
    plainRevealAbs(head);
    emitPlainCursorAndSelection();
    return;
  }
  enterPlainRangeSelection(anchor, head);
  nextTick(() => plainRevealAbs(head));
}

/**
 * Ctrl+Home/End, Ctrl+↑/↓ and their Shift forms across blocks. Declines (so
 * the global handler runs instead) when the user has bound the chord to an
 * action of their own (#180).
 */
function handlePlainCrossBlockNav(event: KeyboardEvent): boolean {
  if (!event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  const key = event.key;
  if (key !== 'Home' && key !== 'End' && key !== 'ArrowUp' && key !== 'ArrowDown') return false;
  const combo = eventToCombo(event);
  if (combo && resolveBindings(settings.keybindings).has(combo)) return false;
  const sel = plainAbsSelectionEnds();
  if (!sel) return false;
  event.preventDefault();
  const edges = plainDocEdges();
  const from = event.shiftKey
    ? sel.head
    : key === 'ArrowUp' || key === 'Home'
      ? Math.min(sel.anchor, sel.head)
      : Math.max(sel.anchor, sel.head);
  let target: number;
  if (key === 'Home') target = edges.start;
  else if (key === 'End') target = edges.end;
  else if (key === 'ArrowUp') target = prevParagraphStart(plainParagraphStarts(), from);
  else target = nextParagraphStart(plainParagraphStarts(), from, edges.end);
  if (event.shiftKey) plainSelectAbs(sel.anchor, target);
  else plainMoveCaretAbs(target);
  return true;
}

/**
 * Triple-click in the active textarea selects the paragraph (block, list item,
 * or one line of code) rather than whatever the browser calls a line — in a
 * soft-wrapped paragraph that was a single visual row. The first click turns a
 * rendered block into a textarea, which can reset the browser's click count,
 * so the count is kept here too.
 */
let plainClickTrail: Array<{ t: number; x: number; y: number }> = [];
function plainClickCount(event: MouseEvent): number {
  const now = event.timeStamp || performance.now();
  const last = plainClickTrail[plainClickTrail.length - 1];
  if (!last || now - last.t > 500 || Math.abs(event.clientX - last.x) + Math.abs(event.clientY - last.y) > 8) {
    plainClickTrail = [];
  }
  plainClickTrail.push({ t: now, x: event.clientX, y: event.clientY });
  return Math.max(plainClickTrail.length, event.detail || 0);
}

function maybeSelectPlainParagraph(event: MouseEvent, clicks: number): boolean {
  if (clicks !== 3 || event.shiftKey) return false;
  const el = plainBlockEditors.value[plainActiveBlock.value];
  if (!el || event.target !== el) return false;
  const block = plainBlocks.value[plainActiveBlock.value];
  if (!block) return false;
  const abs = block.start + offsetAtPoint(el, el.value, event.clientX, event.clientY);
  // The paragraph comes from the real block structure — in the merged view the
  // textarea holds the whole document.
  const owner = plainDocBlocks().find((b) => abs >= b.start && abs <= b.start + b.text.length);
  if (!owner) return false;
  const r = paragraphRangeInBlock(owner.text, abs - owner.start);
  event.preventDefault();
  el.focus({ preventScroll: true });
  el.setSelectionRange(owner.start + r.from - block.start, owner.start + r.to - block.start);
  emitPlainCursorAndSelection();
  return true;
}

/**
 * Shift+click in another block extends the selection from the caret to the
 * click point, through the merged view. Within the active block the textarea
 * does it natively.
 */
function maybeExtendPlainSelectionByClick(event: MouseEvent): boolean {
  if (!event.shiftKey || plainSelectAll.value) return false;
  const sel = plainAbsSelectionEnds();
  const point = plainDocOffsetAtPoint(event.clientX, event.clientY);
  if (!sel || !point || point.block === plainActiveBlock.value) return false;
  event.preventDefault();
  // The click that follows must not activate the clicked block.
  plainSwallowClick = true;
  const release = () => {
    window.removeEventListener('mouseup', release);
    setTimeout(() => { plainSwallowClick = false; }, 0);
  };
  window.addEventListener('mouseup', release);
  enterPlainRangeSelection(sel.anchor, point.abs);
  return true;
}

// ── Editor right-click menu (#210) ─────────────────────────────────────────
// The webview's own menu came up on Windows without Cut/Copy for a selection
// the user had just made, so mouse-only users could select but not act. On
// Windows we show a menu of our own, the same on every editor path (macOS and
// Linux keep the system menu, see onEditorContextMenu). On phones a long-press
// fires `contextmenu` too; the system selection menu is better there, so we
// leave it alone.
const editorCtx = ref<{
  x: number;
  y: number;
  hasSelection: boolean;
  hasImage: boolean;
  spell: EditorMenuSpell | null;
} | null>(null);
// #376 — the misspelled word the menu was opened on, for replacing it with a
// suggestion. `el` is the textarea on the Windows paths, null for CodeMirror.
let ctxSpell: { el: HTMLTextAreaElement | null; from: number; to: number; word: string } | null = null;
let ctxSeq = 0;
let ctxTextarea: HTMLTextAreaElement | null = null;
// #362 — the rendered image the menu was opened on (CodeMirror live-edit
// widgets and the Windows live blocks alike), for "Copy image".
let ctxImage: HTMLImageElement | null = null;
let ctxSavedRange: { el: HTMLTextAreaElement; start: number; end: number } | null = null;

/** Right mousedown: remember the textarea selection before anything can
 *  collapse it (on WebView2 a textarea selection is mirrored into the page
 *  selection, and page-selection cleanup used to wipe it on right-click). */
function onEditorMouseDownCapture(event: MouseEvent) {
  if (event.button !== 2) return;
  const el = event.target;
  if (el instanceof HTMLTextAreaElement) {
    ctxSavedRange = { el, start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
  } else {
    ctxSavedRange = null;
  }
}

async function onEditorContextMenu(event: MouseEvent) {
  const pointer = (event as PointerEvent).pointerType;
  if (pointer === 'touch' || pointer === 'pen' || isAndroid() || isIOS()) return;
  // Windows only. There the WebView2 menu lost the selection (#210). The
  // macOS and Linux menus handle selections fine, and they carry things ours
  // can't: spelling suggestions, Look Up, Services, writing tools.
  if (!isWindowsEditorRuntime()) return;
  event.preventDefault();
  let hasSelection = false;
  // #376 — where to look for a misspelled word: the line under the pointer,
  // the pointer's offset in it, and where that line starts in the editor.
  let spellProbe: { el: HTMLTextAreaElement | null; line: string; offset: number; base: number; selFrom: number; selTo: number } | null = null;
  const spellOn = props.spellCheck || settings.spellcheckEnabled;
  if (!usePlainWindowsEditor) {
    hasSelection = !!view && !view.state.selection.main.empty;
    ctxTextarea = null;
    if (spellOn && view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos != null) {
        const line = view.state.doc.lineAt(pos);
        const sel = view.state.selection.main;
        spellProbe = { el: null, line: line.text, offset: pos - line.from, base: line.from, selFrom: sel.from, selTo: sel.to };
      }
    }
  } else {
    const el = event.target instanceof HTMLTextAreaElement ? event.target : plainActiveTextarea();
    ctxTextarea = el;
    if (el && ctxSavedRange && ctxSavedRange.el === el
      && ctxSavedRange.start !== ctxSavedRange.end
      && el.selectionStart === el.selectionEnd) {
      // Something collapsed the selection between mousedown and here; the
      // user right-clicked a selection, so put it back.
      el.setSelectionRange(ctxSavedRange.start, ctxSavedRange.end);
    }
    hasSelection = !!el && el.selectionStart !== el.selectionEnd;
    // Only a textarea has editable text to correct; a rendered live block
    // under the pointer is not spell-checked by anyone.
    if (spellOn && el && event.target === el) {
      const text = el.value;
      const off = offsetAtPoint(el, text, event.clientX, event.clientY);
      const base = text.lastIndexOf('\n', off - 1) + 1;
      const nl = text.indexOf('\n', off);
      spellProbe = {
        el,
        line: text.slice(base, nl < 0 ? text.length : nl),
        offset: off - base,
        base,
        selFrom: el.selectionStart ?? 0,
        selTo: el.selectionEnd ?? 0,
      };
    }
  }
  ctxSavedRange = null;
  const target = event.target instanceof Element ? event.target : null;
  const img = target?.closest('img');
  ctxImage = img instanceof HTMLImageElement && img.src ? img : null;
  const seq = ++ctxSeq;
  ctxSpell = null;
  let spell: EditorMenuSpell | null = null;
  if (spellProbe) {
    const hit = await lookupMisspelling(spellProbe.line, spellProbe.offset, settings.spellcheckLang);
    if (seq !== ctxSeq) return; // a newer right-click took over
    if (hit) {
      const from = spellProbe.base + hit.from;
      const to = spellProbe.base + hit.to;
      // A right-click on a selection acts on the selection; suggestions only
      // when nothing is selected or the selection is that very word (Chromium
      // selects the misspelling under the pointer on its own).
      const selIsWord = spellProbe.selFrom === from && spellProbe.selTo === to;
      if (!hasSelection || selIsWord) {
        ctxSpell = { el: spellProbe.el, from, to, word: hit.word };
        spell = {
          word: hit.word,
          suggestions: hit.suggestions,
          // Adding a word only clears an underline our own checker drew: the
          // CodeMirror Hunspell one. The webview's native underline would stay.
          canAdd: settings.spellcheckEnabled && !usePlainWindowsEditor,
        };
      }
    }
  }
  editorCtx.value = { x: event.clientX, y: event.clientY, hasSelection, hasImage: !!ctxImage, spell };
}

/** Replace the right-clicked misspelling with `word` (#376) — one undoable
 *  edit, through the same channels as typing on each editor path. */
function onEditorMenuReplace(word: string) {
  editorCtx.value = null;
  const target = ctxSpell;
  ctxSpell = null;
  ctxTextarea = null;
  ctxImage = null;
  if (!target) return;
  if (!target.el) {
    const v = view;
    if (!v || v.state.sliceDoc(target.from, target.to) !== target.word) return;
    v.dispatch({
      changes: { from: target.from, to: target.to, insert: word },
      selection: { anchor: target.from + word.length },
      userEvent: 'input.spellcheck',
      scrollIntoView: true,
    });
    v.focus();
    return;
  }
  const el = target.el;
  if (!el.isConnected || el.value.slice(target.from, target.to) !== target.word) return;
  el.focus();
  el.setSelectionRange(target.from, target.to);
  // execCommand keeps it on the textarea's undo stack and fires the input
  // event the block / flat handlers sync the document from (as paste does).
  document.execCommand('insertText', false, word);
}

async function onEditorMenuAddWord(word: string) {
  editorCtx.value = null;
  ctxSpell = null;
  try {
    await addToSpellDict(word);
  } catch (err) {
    console.warn('[spellcheck] add to dictionary failed', err);
  }
  view?.focus();
}

async function copyContextImage(img: HTMLImageElement) {
  try {
    await copyImageElement(img);
    toasts.success(t('overlay.imageCopied'));
  } catch (err) {
    console.error('[copy image]', err);
    toasts.error(t('overlay.copyImageFailed', { error: String((err as Error)?.message ?? err) }));
  }
}

async function writeClipboard(text: string) {
  try {
    await writeClipboardTextPlugin(text);
  } catch {
    await navigator.clipboard?.writeText(text);
  }
}
async function readClipboard(): Promise<string> {
  try {
    return (await readClipboardTextPlugin()) ?? '';
  } catch {
    try {
      return (await navigator.clipboard?.readText()) ?? '';
    } catch {
      return '';
    }
  }
}

async function onEditorMenuAction(id: EditorMenuAction) {
  editorCtx.value = null;
  ctxSpell = null;
  if (id === 'copyImage') {
    const img = ctxImage;
    ctxImage = null;
    if (img) await copyContextImage(img);
    return;
  }
  ctxImage = null;
  if (!usePlainWindowsEditor) {
    const v = view;
    if (!v) return;
    const sel = v.state.selection.main;
    if (id === 'selectAll') {
      v.dispatch({ selection: { anchor: 0, head: v.state.doc.length }, userEvent: 'select' });
    } else if (id === 'copy' || id === 'cut') {
      if (sel.empty) return;
      await writeClipboard(v.state.sliceDoc(sel.from, sel.to));
      if (id === 'cut') {
        v.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' }, userEvent: 'delete.cut' });
      }
    } else if (id === 'paste') {
      const text = await readClipboard();
      if (text) v.dispatch({ ...v.state.replaceSelection(text), userEvent: 'input.paste', scrollIntoView: true });
    }
    v.focus();
    return;
  }
  const el = ctxTextarea ?? plainActiveTextarea();
  ctxTextarea = null;
  if (id === 'selectAll') {
    if (plainLiveEnabled.value) {
      enterPlainSelectAll();
    } else if (el) {
      el.focus();
      el.select();
      clearStrayDocumentSelection(el);
      emitPlainCursorAndSelection();
    }
    return;
  }
  if (!el) return;
  el.focus();
  if (id === 'copy' || id === 'cut') {
    const text = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
    if (!text) return;
    await writeClipboard(text);
    if (id === 'cut') {
      el.focus();
      // execCommand keeps the edit on the textarea's own undo stack and fires
      // the input event our block/flat handlers listen to.
      document.execCommand('delete');
    }
  } else if (id === 'paste') {
    const text = await readClipboard();
    if (!text) return;
    el.focus();
    document.execCommand('insertText', false, text);
  }
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
  if (!plainComposing.value) recordPlainHistory();
  let nextCaret = block.start + (caret ?? text.length);
  // Re-attach the block separator that splitPlainMarkdownBlocks stripped from
  // the editable text, so neighbouring blocks don't merge on every edit.
  const tail = block.hasTrailingNewline ? '\n' : '';
  let next = `${plainText.value.slice(0, block.start)}${text}${tail}${plainText.value.slice(block.end)}`;
  // Ordered-list numbers follow a line added or removed. When this rewrites
  // the active block, its text no longer matches the textarea, so the fast
  // path below is skipped and the caret is restored from `nextCaret`.
  const renum = !plainComposing.value && props.tab.language === 'markdown'
    ? renumberAfterEdit(plainText.value, next)
    : null;
  if (renum) {
    next = renum.value;
    nextCaret = mapPos(nextCaret, renum.changes);
  }
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

/** The user's chord for AI rewrite, in CodeMirror's spelling. */
function currentAiRewriteKey(): string {
  const combos = combosFor('editor.aiRewrite', settings.keybindings);
  // Unbound: a key no chord produces, so the extension stays inert rather
  // than falling back to ⌘J behind the user's back.
  return combos.length ? toCodeMirrorKey(combos[0]) : 'F24';
}

function markdownExt() {
  // Use `markdownLanguage` as the base so GFM features (including task
  // list parsing with TaskMarker nodes) are enabled.
  // `cjkFriendlyEmphasis` keeps live edit in step with the preview on
  // `**限制：**硬链接`-shaped CJK bold (#262); without it the two panes
  // disagree about the same document.
  return [
    markdown({
      base: markdownLanguage,
      codeLanguages,
      addKeymap: true,
      extensions: [cjkFriendlyEmphasis],
    }),
    listRenumberFilter,
  ];
}

/**
 * F-7 — Tab / Shift+Tab on a Markdown list item nests it at its parent's
 * content column and renumbers (lib/md-format `listIndentEdit`); anything
 * else falls through to indentWithTab.
 */
function listIndentCommand(v: EditorView, outdent: boolean): boolean {
  if (props.tab.language !== 'markdown' || v.state.readOnly) return false;
  if (v.state.selection.ranges.length > 1) return false;
  const sel = v.state.selection.main;
  const edit = listIndentEdit(v.state.doc.toString(), sel.from, sel.to, outdent);
  if (!edit) return false;
  v.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: sel.empty ? { anchor: edit.selFrom } : { anchor: edit.selFrom, head: edit.selTo },
    scrollIntoView: true,
    userEvent: 'input.indent',
  });
  return true;
}

/**
 * Ordered-list numbers follow a line added or removed by the user — the
 * textarea editors apply the same rule at their commit points
 * (lib/list-renumber). Appended to the same transaction, so one undo step
 * takes back the edit and the renumbering together.
 */
const listRenumberFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !(tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move'))) {
    return tr;
  }
  let structural = false;
  let from = Infinity;
  let to = -1;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (inserted.lines > 1 || tr.startState.doc.sliceString(fromA, toA).includes('\n')) structural = true;
    from = Math.min(from, fromB);
    to = Math.max(to, toB);
  });
  if (!structural) return tr;
  const changes = renumberChanges(tr.newDoc.toString(), from, to);
  return changes.length ? [tr, { changes, sequential: true }] : tr;
});

function spellCheckExt(on: boolean) {
  return EditorView.contentAttributes.of({ spellcheck: on ? 'true' : 'false' });
}

/** Heading folding — off entirely when the setting is off, so a user who finds
 *  the gutter arrows noisy gets the old editor back rather than a hidden
 *  feature they can still trip over with a shortcut. */
function foldExtensionFor(on: boolean) {
  if (!on) return [];
  return headingFoldExtension({
    placeholderLabel: (lines) => t('fold.placeholder', { lines }),
  });
}

// The live-edit code-block copy button lives in a CM widget, which has no
// access to the i18n store — hand it a getter so its label tracks the UI
// language like every other string.
setLiveEditCopyLabel(() => t('toolbar.copy'));

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
        // #354 — diagrams follow the app's light/dark family, like preview.
        getMermaidTheme: () => mermaidThemeFor(settings.theme),
        getPlantuml: () => ({
          enabled: settings.plantumlEnabled,
          server: settings.plantumlServer,
        }),
        // #353 — "Always show Markdown markers": keep every block's source.
        keepSource: () => settings.alwaysShowMarkers,
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
    ], { showMarkers: settings.alwaysShowMarkers });
  }
  return settings.livePreview
    ? livePreviewExtension({ showMarkers: settings.alwaysShowMarkers })
    : richHighlightOnly();
}

// #344 — caret-line tint. Selector is one step more specific than the base
// theme's transparent `.cm-activeLine` so it wins regardless of order.
function activeLineExtension(on: boolean) {
  if (!on) return [];
  return EditorView.theme({
    '.cm-content .cm-line.cm-activeLine': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 9%, transparent)',
    },
  });
}

const fontSizeTheme = (px: number, family: string) =>
  EditorView.theme({
    '&': { fontSize: `${px}px`, height: '100%' },
    // 5.0 §5 — body 16/1.8 (the size is the user's; 1.8 is CJK-comfortable),
    // 56px above the first line, room to scroll the last line up to the eye.
    '.cm-scroller': { fontFamily: buildEditorFontStack(family), lineHeight: '1.8' },
    '.cm-content': { padding: '56px 32px 30vh', caretColor: 'var(--accent)' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      border: 'none',
      color: 'var(--text-faint)',
    },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--accent)' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    // Inactive window → neutral grey: styles/writing.css (:root.window-inactive).
    '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft) !important' },
    // v4.3.0 issue #67: distinct current-match highlight for the Cmd+F search
    // panel. CM6 marks the active result with `.cm-searchMatch-selected` —
    // by default it's the same translucent color as the other matches so the
    // user can't tell which one they're on. Brighten it to the accent color
    // and tint the others down so the current one pops.
    // !important: CodeMirror's dark base theme (`&dark .cm-searchMatch`) is
    // more specific than this theme and repainted matches blue-outlined, and
    // the current one as accent-coloured text on a dark fill — unreadable.
    '.cm-searchMatch': {
      backgroundColor: 'color-mix(in srgb, var(--accent, #ff9f40) 24%, transparent) !important',
      outline: 'none !important',
      borderRadius: '2px',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'var(--accent, #ff9f40) !important',
      color: 'var(--accent-fg, #fff)',
      outline: '1px solid var(--accent, #ff9f40) !important',
    },
    // The match's own text colour (a heading, a link…) would sit on the
    // accent fill; inside the current match everything takes accent-fg.
    '.cm-searchMatch.cm-searchMatch-selected *': { color: 'var(--accent-fg, #fff) !important' },
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
          activeLineCompartment.of(activeLineExtension(settings.highlightCurrentLine)),
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
          // 5.0 — our own find bar (lib/cm-find-panel.ts), labels read when
          // it opens so a language switch shows at the next ⌘F.
          search({ top: true, createPanel: (v) => createFindPanel(v, findPanelLabels()) }),
          incrementalFindScroll,
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        ]),
    // App-owned chords are filtered out of CodeMirror's keymap (baseKeymap):
    // the app shortcut listens on window, after CodeMirror has already acted.
    baseKeymapCompartment.of(baseKeymap()),
    keymap.of([
      ...historyKeymap,
      { key: 'Tab', run: (v) => listIndentCommand(v, false) },
      { key: 'Shift-Tab', run: (v) => listIndentCommand(v, true) },
      indentWithTab,
    ]),
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
    themeCompartment.of(cmThemeFor(settings.theme, !!settings.customCssPath)),
    vimCompartment.of(settings.vimMode ? vimExtension() : []),
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
          // #297 — opens itself on the third backtick of a fence opener.
          fenceLanguageExtension(() => settings.fenceLanguageSuggestions),
          // Single autocompletion config combining all 4 markdown sources
          // (wikilinks `[[`, tags `#`, citations `@`, fence languages ```).
          // CM6 disallows multiple `autocompletion({ override })` extensions.
          autocompletion({
            override: [
              wikilinkComplete,
              tagComplete,
              citationCompleteSource(() => cachedCitations),
              fenceLanguageComplete,
            ],
            defaultKeymap: true,
            // Typing-triggered completion is the last remaining source of
            // IME-hostile churn here. Keep the sources available for explicit
            // invocation, but do not wake them up on every keystroke.
            // (`fenceLanguageExtension` above triggers only the fence source,
            // and only for the keystroke that opens a fence.)
            activateOnTyping: false,
          }),
          ...(IS_APP_STORE_BUILD ? [] : [aiKeyCompartment.of(aiRewriteExtension(currentAiRewriteKey()))]),
          spellcheckExtension({ enabled: () => settings.spellcheckEnabled }),
          spellcheckTheme,
          slashCompartment.of(slashExt()),
        ]
      : []),
    ...(windowsImeSafeMode || markdownSafeMode ? [] : [taskListExtension()]),
    foldCompartment.of(foldExtensionFor(settings.foldingEnabled)),
    sessionRestoreExtension(props.tab.id),
    // #167 — clicks during async widget renders (post tab-switch) must not
    // turn into phantom multi-line selections when the layout shifts.
    stableClickSelection(),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        const text = u.state.doc.toString();
        if (!u.view.composing) syncEditorContentSoon(text);
      }
      if (u.docChanged && !u.view.composing && props.tab.language === 'markdown') {
        for (const tr of u.transactions) {
          if (!tr.isUserEvent('input.type')) continue;
          tr.changes.iterChanges((_fa, _ta, _fb, toB, inserted) => {
            if (inserted.length !== 1) return;
            const line = u.state.doc.lineAt(toB);
            noteTypedFormat(line.text.slice(0, toB - line.from), inserted.toString());
          });
        }
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
  window.addEventListener('solomd:format-markdown', onFormatMarkdown as EventListener);
  window.addEventListener('solomd:editor-command', onEditorCommand as EventListener);
  window.addEventListener('solomd:editor-history', onEditorHistory as EventListener);
  cleanupTransformCase = () => {
    window.removeEventListener('solomd:editor-history', onEditorHistory as EventListener);
    window.removeEventListener('solomd:transform-case', onTransformCase as EventListener);
    window.removeEventListener('solomd:format-markdown', onFormatMarkdown as EventListener);
    window.removeEventListener('solomd:editor-command', onEditorCommand as EventListener);
  };

  if (usePlainWindowsEditor) {
    // #316 — the drawn caret has to disappear exactly when the native one
    // would. A click into the file tree or the preview fires focusin, and a
    // window that goes to the background fires no blur on the textarea at
    // all, so both are listened for.
    const onFocusShift = () => schedulePlainOverlays();
    const onWindowBlur = () => {
      plainWindowFocused.value = false;
      schedulePlainOverlays();
    };
    const onWindowFocus = () => {
      plainWindowFocused.value = true;
      schedulePlainOverlays();
    };
    document.addEventListener('focusin', onFocusShift);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('focus', onWindowFocus);
    cleanupPlainOverlays = () => {
      document.removeEventListener('focusin', onFocusShift);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('focus', onWindowFocus);
    };
  }

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
  focusFreshCodeMirror();
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
 * #296 / #274 — bold, italic, headings, lists… from a shortcut or the palette.
 *
 * Same shape as `onTransformCase` above, for the same reason: lib/md-format.ts
 * decides the edit from a string and a selection, and the three editors only
 * differ in how they hand those over and write the result back.
 */
function onFormatMarkdown(e: Event) {
  let kind = ((e as CustomEvent).detail || {}).kind as FormatKind | 'headingCycle';
  if (props.tab.id !== tabs.activeId) return;
  if (props.tab.language !== 'markdown') return;
  // 5.0 touch keyboard bar: one heading button that steps
  // paragraph → H1 → H2 → H3 → paragraph, each step an ordinary fmt.hN.
  if (kind === 'headingCycle') {
    const sel = currentFormatSelection();
    if (!sel) return;
    kind = nextHeadingKind(sel.doc, sel.from);
  }
  if (!FORMAT_KINDS.includes(kind)) return;
  applyFormatKind(kind);
}

/** The text and selection the format commands work on, in either editor
 *  (the plain block editor's are the active block's). */
function currentFormatSelection(): { doc: string; from: number; to: number } | null {
  if (!usePlainWindowsEditor) {
    if (!view) return null;
    const sel = view.state.selection.main;
    return { doc: view.state.doc.toString(), from: sel.from, to: sel.to };
  }
  const el = plainLiveEnabled.value ? plainBlockEditors.value[plainActiveBlock.value] : plainEditor.value;
  if (!el) return null;
  return { doc: el.value, from: el.selectionStart ?? 0, to: el.selectionEnd ?? 0 };
}

/** Run one `fmt.*` command on this editor — the shortcut, the Insert menu,
 *  the 5.0 selection bubble and the touch keyboard bar all land here. */
function applyFormatKind(kind: FormatKind) {
  if (props.tab.language !== 'markdown') return;
  if (!usePlainWindowsEditor) {
    if (!view) return;
    const sel = view.state.selection.main;
    const edit = applyFormat(view.state.doc.toString(), sel.from, sel.to, kind);
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: { anchor: edit.selFrom, head: edit.selTo },
      scrollIntoView: true,
      userEvent: 'input.format',
    });
    view.focus();
    return;
  }

  const el = plainLiveEnabled.value
    ? plainBlockEditors.value[plainActiveBlock.value]
    : plainEditor.value;
  if (!el) return;
  const edit = applyFormat(el.value, el.selectionStart ?? 0, el.selectionEnd ?? 0, kind);
  const value = el.value.slice(0, edit.from) + edit.insert + el.value.slice(edit.to);
  recordPlainHistory();
  if (plainLiveEnabled.value) {
    updatePlainBlock(plainActiveBlock.value, value, edit.selTo);
    nextTick(() => {
      const e2 = plainBlockEditors.value[plainActiveBlock.value];
      if (!e2) return;
      e2.focus();
      // A fence or a blank line can split the block, and then these offsets
      // belong to a different textarea — leave the caret where the re-split
      // put it rather than selecting the wrong text.
      if (e2.value === value) e2.setSelectionRange(edit.selFrom, edit.selTo);
    });
    return;
  }
  const keepScroll = el.scrollTop;
  el.value = value;
  plainText.value = value;
  tabs.setContent(props.tab.id, value);
  nextTick(() => {
    el.focus();
    el.setSelectionRange(edit.selFrom, edit.selTo);
    el.scrollTop = keepScroll;
    emitPlainCursorAndSelection();
  });
}

// ── 5.0 selection bubble (SelectionBubble.vue) ─────────────────────────────
// The bubble is editor-agnostic; these two readers are its view of whichever
// editor this is. Both editors on Windows get it (IK6JCC rule).
const bubbleHost = computed<HTMLElement | null>(() => (usePlainWindowsEditor ? plainHostEl.value : host.value));
const bubbleEnabled = computed(
  () =>
    settings.selectionBubble &&
    !isMobile() &&
    props.tab.language === 'markdown' &&
    settings.viewMode !== 'preview' &&
    settings.viewMode !== 'reading',
);

/** The textarea that holds the caret on the plain path, if it has focus. */
function focusedPlainTextarea(): HTMLTextAreaElement | null {
  const el = plainLiveEnabled.value ? plainBlockEditors.value[plainActiveBlock.value] : plainEditor.value;
  return el && document.activeElement === el ? el : null;
}

function readBubbleSelection(): BubbleSelection | null {
  if (!usePlainWindowsEditor) {
    if (!view || view.composing) return null;
    if (!view.dom.contains(document.activeElement)) return null;
    const sel = view.state.selection.main;
    if (sel.empty) return null;
    const doc = view.state.doc;
    const a = doc.lineAt(sel.from).from;
    const b = doc.lineAt(sel.to).to;
    return { context: doc.sliceString(a, b), from: sel.from - a, to: sel.to - a, key: `${sel.from}:${sel.to}` };
  }
  const el = focusedPlainTextarea();
  if (!el) return null;
  const from = el.selectionStart ?? 0;
  const to = el.selectionEnd ?? 0;
  if (from === to) return null;
  const c = lineContext(el.value, from, to);
  const abs = plainAbsoluteSelection();
  return { context: c.text, from: c.from, to: c.to, key: abs ? `${abs.from}:${abs.to}` : `${from}:${to}` };
}

function readBubbleRect(): Box | null {
  if (!usePlainWindowsEditor) {
    if (!view) return null;
    const sel = view.state.selection.main;
    const a = view.coordsAtPos(sel.from, 1);
    const b = view.coordsAtPos(sel.to, -1);
    if (!a || !b) return null;
    if (b.top - a.top < 4) {
      return { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
    }
    // Several lines: centre on the text column, from the first line's top to
    // the last line's bottom.
    const col = view.contentDOM.getBoundingClientRect();
    return { left: col.left, right: col.right, top: a.top, bottom: b.bottom };
  }
  const el = focusedPlainTextarea();
  if (!el) return null;
  const box = selectionBoxPx(el, el.value, el.selectionStart ?? 0, el.selectionEnd ?? 0);
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const ox = r.left + el.clientLeft + parseFloat(cs.paddingLeft || '0') - el.scrollLeft;
  const oy = r.top + el.clientTop + parseFloat(cs.paddingTop || '0') - el.scrollTop;
  return { left: box.left + ox, right: box.right + ox, top: box.top + oy, bottom: box.bottom + oy };
}

/** Undo / redo from the touch keyboard bar, on either editor. */
function onEditorHistory(e: Event) {
  if (props.tab.id !== tabs.activeId) return;
  const op = ((e as CustomEvent).detail || {}).op as 'undo' | 'redo';
  if (!usePlainWindowsEditor) {
    if (!view) return;
    if (op === 'redo') cmRedo(view);
    else cmUndo(view);
    return;
  }
  if (op === 'redo') plainRedo();
  else plainUndo();
}

/**
 * B4 — the Typora-style commands: select word / line, delete word, jump to
 * selection, heading level up / down / to paragraph.
 *
 * Same shape as `onFormatMarkdown`: lib/editor-commands.ts decides the range
 * or the edit from the text and the selection, and each of the three editors
 * only reads its selection and applies the result. The plain editors work in
 * whole-document offsets (`plainAbsoluteSelection` / `selectPlainRange`), so
 * the block and flat textareas share one branch.
 */
function onEditorCommand(e: Event) {
  const cmd = ((e as CustomEvent).detail || {}).cmd as EditorCommand;
  if (!EDITOR_COMMANDS.includes(cmd)) return;
  if (props.tab.id !== tabs.activeId) return;
  if (MARKDOWN_ONLY_COMMANDS.has(cmd) && props.tab.language !== 'markdown') return;

  const headingMode = (c: EditorCommand) =>
    c === 'headingPromote' ? 'promote' : c === 'headingDemote' ? 'demote' : 'paragraph';

  if (!usePlainWindowsEditor) {
    if (!view) return;
    const v = view;
    const doc = v.state.doc.toString();
    const sel = v.state.selection.main;
    if (cmd === 'jumpToSelection') {
      v.dispatch({ effects: EditorView.scrollIntoView(sel, { y: 'center' }) });
    } else if (cmd === 'selectWord' || cmd === 'selectLine') {
      const r = cmd === 'selectWord' ? selectWordRange(doc, sel.from, sel.to) : selectLineRange(doc, sel.from, sel.to);
      if (r) v.dispatch({ selection: { anchor: r.from, head: r.to }, scrollIntoView: true, userEvent: 'select' });
    } else {
      const edit = cmd === 'deleteWord'
        ? deleteWordEdit(doc, sel.from, sel.to)
        : shiftHeading(doc, sel.from, sel.to, headingMode(cmd));
      if (edit) {
        v.dispatch({
          changes: { from: edit.from, to: edit.to, insert: edit.insert },
          selection: { anchor: edit.selFrom, head: edit.selTo },
          scrollIntoView: true,
          userEvent: cmd === 'deleteWord' ? 'delete' : 'input.format',
        });
      }
    }
    v.focus();
    return;
  }

  const sel = plainAbsoluteSelection();
  if (!sel) return;
  // The flat textarea is the document; in live edit the blocks are slices of
  // plainText, which every block edit keeps current.
  const doc = plainLiveEnabled.value ? plainText.value || '' : plainEditor.value?.value ?? plainText.value ?? '';
  if (cmd === 'jumpToSelection') {
    selectPlainRange(sel.from, sel.to, true);
    return;
  }
  if (cmd === 'selectWord' || cmd === 'selectLine') {
    const r = cmd === 'selectWord' ? selectWordRange(doc, sel.from, sel.to) : selectLineRange(doc, sel.from, sel.to);
    if (r) selectPlainRange(r.from, r.to, true);
    return;
  }
  const edit = cmd === 'deleteWord'
    ? deleteWordEdit(doc, sel.from, sel.to)
    : shiftHeading(doc, sel.from, sel.to, headingMode(cmd));
  if (!edit) return;
  recordPlainHistory();
  applyPlainContent(doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to), edit.selTo);
  nextTick(() => selectPlainRange(edit.selFrom, edit.selTo, true));
}

/**
 * #137 — open the find/replace UI. The panel already exists on both editor
 * paths (CodeMirror's search panel + the plain-textarea find bar) behind
 * Ctrl+F, but had no toolbar / command-palette entry, so users thought it was
 * gone. PaneContent forwards `solomd:editor-find` here for the focused pane.
 */
function findPanelLabels(): FindPanelLabels {
  return {
    find: t('plainFind.findPlaceholder'),
    replace: t('plainFind.replacePlaceholder'),
    prev: t('plainFind.prev'),
    next: t('plainFind.next'),
    matchCase: t('plainFind.matchCase'),
    regexp: t('plainFind.regexp'),
    wholeWord: t('plainFind.wholeWord'),
    replaceOne: t('plainFind.replaceOne'),
    replaceAll: t('plainFind.replaceAll'),
    close: t('plainFind.close'),
  };
}

function openFind(replace = false): void {
  if (usePlainWindowsEditor) {
    openPlainFind(replace);
    return;
  }
  if (view) {
    view.focus();
    openSearchPanel(view);
    // CodeMirror's panel always carries the replace row; "Replace" (Ctrl+H)
    // only decides which field gets the caret. With nothing to find yet the
    // find field is the one that needs typing first.
    if (replace && getSearchQuery(view.state).search) {
      const field = view.dom.querySelector<HTMLInputElement>('.cm-search input[name=replace]');
      field?.focus();
      field?.select();
    }
  }
}

/**
 * Open the grid editor on the table the caret is in.
 *
 * Works off the document text and line offsets rather than either editor's
 * internals, so the same code serves CodeMirror and the Windows plain
 * textarea; only the write-back differs.
 */
function openTableAtCursor(): void {
  const source = usePlainWindowsEditor ? plainText.value || '' : view?.state.doc.toString() ?? '';
  if (!source) {
    toasts.info(t('tableEditor.notInTable'));
    return;
  }
  const lines = source.split('\n');
  const caret = usePlainWindowsEditor
    ? plainCaretOffset()
    : view
      ? view.state.selection.main.head
      : 0;

  // Offset → line index, plus each line's start offset for the reverse trip.
  const starts: number[] = [];
  let off = 0;
  for (const line of lines) {
    starts.push(off);
    off += line.length + 1;
  }
  let caretLine = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= caret) caretLine = i;
    else break;
  }

  const span = findTableSpan(lines, caretLine);
  if (!span) {
    toasts.info(t('tableEditor.notInTable'));
    return;
  }
  const from = starts[span.startLine];
  const to = starts[span.endLine] + lines[span.endLine].length;

  openTableEditor({
    source: source.slice(from, to),
    apply: (markdown: string) => replaceDocRange(from, to, markdown),
  });
}

/**
 * Open the formula editor on the math under the caret, or on an empty formula
 * when the caret is not in one — "insert a formula" and "fix this formula" are
 * the same action from the user's side.
 */
function openFormulaAtCursor(): void {
  const source = usePlainWindowsEditor ? plainText.value || '' : view?.state.doc.toString() ?? '';
  const caret = usePlainWindowsEditor
    ? plainCaretOffset()
    : view
      ? view.state.selection.main.head
      : 0;
  const span = findMathSpanAt(source, caret);
  const from = span ? span.from : caret;
  const to = span ? span.to : caret;

  openFormulaEditor({
    latex: span?.body ?? '',
    // A new formula defaults to inline; that is the common case, and the
    // dialog has a one-click switch for the other one.
    display: span?.display ?? false,
    labels: collectLabels(source),
    apply: (latex: string, display: boolean) =>
      replaceDocRange(from, to, formatMath(source, from, to, latex, display)),
  });
}

/**
 * Wrap a formula in the right delimiters for where it sits.
 *
 * A display formula gets its own lines only when nothing else shares them.
 * Turning `Inline $E=mc^2$ here.` into a three-line `$$` block would split the
 * sentence across the formula — the mid-sentence case has to stay on one line.
 */
function formatMath(
  source: string,
  from: number,
  to: number,
  latex: string,
  display: boolean,
): string {
  if (!display) return `$${latex}$`;
  const lineStart = source.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  const lineEndIdx = source.indexOf('\n', to);
  const lineEnd = lineEndIdx < 0 ? source.length : lineEndIdx;
  const alone =
    source.slice(lineStart, from).trim() === '' && source.slice(to, lineEnd).trim() === '';
  return alone ? `$$\n${latex}\n$$` : `$$${latex}$$`;
}

/** Caret offset in the plain editor, in whole-document coordinates. */
function plainCaretOffset(): number {
  if (plainLiveEnabled.value) {
    const block = plainBlocks.value[plainActiveBlock.value];
    const el = plainBlockEditors.value[plainActiveBlock.value];
    return (block?.start ?? 0) + (el?.selectionStart ?? 0);
  }
  return plainEditor.value?.selectionStart ?? 0;
}

/** Replace a document range in whichever editor this pane is running. */
function replaceDocRange(from: number, to: number, text: string): void {
  if (usePlainWindowsEditor) {
    const src = plainText.value || '';
    recordPlainHistory();
    applyPlainContent(src.slice(0, from) + text + src.slice(to), from + text.length);
    return;
  }
  if (!view) return;
  view.dispatch({ changes: { from, to, insert: text } });
}

/**
 * Heading folding, driven from the command palette / shortcuts.
 *
 * `level` only applies to `'level'`. The Windows source textarea is the one
 * path that cannot fold — a <textarea> has no way to hide a line — so it says
 * so instead of silently doing nothing.
 */
function applyFold(action: 'toggle' | 'all' | 'none' | 'level', level = 2): void {
  if (!settings.foldingEnabled) {
    toasts.info(t('fold.disabledHint'));
    return;
  }
  if (props.tab.language !== 'markdown' && action !== 'none') {
    // Non-markdown files still fold their own blocks through the gutter and
    // CodeMirror's keymap; only the heading-level commands need a document
    // with headings.
    if (usePlainWindowsEditor) return;
  }

  if (usePlainWindowsEditor) {
    if (!plainLiveEnabled.value) {
      toasts.info(t('fold.plainSourceHint'));
      return;
    }
    const text = plainText.value || '';
    const spans = scanHeadings(text).filter((h) => h.foldable);
    if (action === 'none') {
      plainFolds.value = [];
      return;
    }
    if (action === 'all') {
      plainFolds.value = spans.map((h) => ({ line: h.line, title: h.title }));
      return;
    }
    if (action === 'level') {
      plainFolds.value = spans
        .filter((h) => h.level >= level)
        .map((h) => ({ line: h.line, title: h.title }));
      return;
    }
    const caret = plainBlocks.value[plainActiveBlock.value]?.start ?? 0;
    const enclosing = spans.filter((h) => caret >= h.start && caret <= h.end).pop();
    if (!enclosing) return;
    setPlainFold(enclosing, !plainFoldedLines.value.has(enclosing.line));
    return;
  }

  if (!view) return;
  view.focus();
  if (action === 'toggle') toggleHeadingFoldAtCursor(view);
  else if (action === 'all') foldAllHeadings(view);
  else if (action === 'none') unfoldAllFolds(view);
  else foldHeadingsToLevel(view, level);
}

onBeforeUnmount(() => {
  cleanupRelayout?.();
  cleanupTransformCase?.();
  cleanupTransformCase = null;
  cleanupPlainSelection?.();
  cleanupPlainSelection = null;
  cleanupPlainOverlays?.();
  cleanupPlainOverlays = null;
  if (plainOverlayRaf) {
    cancelAnimationFrame(plainOverlayRaf);
    plainOverlayRaf = 0;
  }
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

/**
 * F-10 — a document file.new / file.newText just made: no file, nothing in
 * it, and not a tab this editor has shown before (switching away records it
 * in tabCaretMemory). Only these take focus on the CodeMirror path; opening
 * or switching to a document leaves focus where it is, as before.
 */
function isFreshUntitledTab(): boolean {
  const t = props.tab;
  return !t.filePath && t.content === '' && t.savedContent === '' && !tabCaretMemory.has(t.id);
}

function focusFreshCodeMirror() {
  if (!isFreshUntitledTab()) return;
  // After the palette / menu that ran the command has closed.
  nextTick(() => view?.focus());
}

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
    focusFreshCodeMirror();
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

// #180 — a rebind in Settings reaches the open editor immediately; without
// this the new chord would only work in editors opened afterwards.
watch(
  () => currentAiRewriteKey(),
  (key) => {
    if (IS_APP_STORE_BUILD) return;
    view?.dispatch({ effects: aiKeyCompartment.reconfigure(aiRewriteExtension(key)) });
  },
);

watch(
  () => JSON.stringify(settings.keybindings),
  () => {
    view?.dispatch({ effects: baseKeymapCompartment.reconfigure(baseKeymap()) });
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
      if (plainComposing.value) return;
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
  () => [settings.theme, !!settings.customCssPath] as const,
  ([t, custom]) => {
    view?.dispatch({ effects: themeCompartment.reconfigure(cmThemeFor(t, custom)) });
    // Live-edit Mermaid widgets carry their theme; rebuild the block field so
    // diagrams on screen re-render for the new light/dark family (#354).
    window.dispatchEvent(new CustomEvent('solomd:cm-relayout'));
  }
);

watch(
  () => settings.vimMode,
  (v) => {
    view?.dispatch({ effects: vimCompartment.reconfigure(v ? vimExtension() : []) });
  }
);

watch(
  () => settings.wordWrap,
  (w) => {
    view?.dispatch({ effects: wrapCompartment.reconfigure(w ? EditorView.lineWrapping : []) });
  }
);

watch(
  () => settings.highlightCurrentLine,
  (on) => {
    view?.dispatch({ effects: activeLineCompartment.reconfigure(activeLineExtension(on)) });
  },
);

// #353 — markers shown/hidden is baked into the live bundles; swap them.
watch(
  () => settings.alwaysShowMarkers,
  () => {
    view?.dispatch({ effects: richCompartment.reconfigure(richExtensionsFor(props.tab)) });
  },
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

watch(
  () => settings.foldingEnabled,
  (on) => {
    view?.dispatch({ effects: foldCompartment.reconfigure(foldExtensionFor(on)) });
    if (!on) plainFolds.value = [];
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
  // renderDepsVersion: the blocks re-render when KaTeX / highlight.js land,
  // which puts mermaid / PlantUML fences back to source — process them again.
  () => [plainLiveEnabled.value, plainText.value, plainActiveBlock.value, settings.theme, settings.language, renderDepsVersion.value],
  () => {
    // No mermaid.initialize here any more: the render pass configures it with
    // the current theme itself, and doing it here would load the renderer for
    // a document that has no diagrams.
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
    // Was `plainInsertText(srcPath)`: a dropped image file landed as a bare
    // path instead of an image link.
    const text = await imageTextFromPath(srcPath, imagePasteOpts());
    if (text) plainInsertText(text);
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
    plainInsertText(markdownImage(clean, alt));
    return;
  }
  if (!view) return;
  insertMarkdown(markdownImage(clean, alt));
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
  // resolveImagePath decodes the src exactly once itself; decoding here too
  // turned a file named `100%.png` (written as `100%25.png`) into garbage.
  const abs = resolveImagePath(src, imageRoot, props.tab.filePath);
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
    changes.push({ from, to, insert: encodeImageDestination(newUrl) });
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
  // Block heights are measured from the top of the document; scrollTop also
  // counts the content's top padding above it (56px in 5.0). Mixing the two
  // put the split panes that far apart.
  const top = view.scrollDOM.scrollTop - docTopInScroller(view);
  const block = view.lineBlockAtHeight(Math.max(0, top));
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
  return view.lineBlockAt(view.state.doc.line(safe).from).top + docTopInScroller(view);
}

/** Where the document starts in the scroller's scrollTop space — the
 *  content's top padding. */
function docTopInScroller(v: EditorView): number {
  return v.documentTop - v.scrollDOM.getBoundingClientRect().top + v.scrollDOM.scrollTop;
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
  const parsed = parseInsertSnippet(snippet);
  const sel = view.state.selection.main;
  // Add a leading newline if not already at the start of a line, for block-level snippets.
  const needsLeadingBreak = snippet.startsWith('\n') && sel.from > 0 &&
    view.state.doc.sliceString(sel.from - 1, sel.from) !== '\n';
  const insertText = needsLeadingBreak ? '\n' + parsed.text : parsed.text;
  const base = sel.from + (needsLeadingBreak ? 1 : 0);
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: insertText },
    selection: { anchor: base + parsed.anchor, head: base + parsed.head },
  });
  view.focus();
}

defineExpose({ gotoLine, insertImageFromPath, insertImageUrl, uploadLocalImages, getViewLine, scrollToLine, lineTopY, insertMarkdown, openFind, applyFold, openTableAtCursor, openFormulaAtCursor });

const cls = computed(() => ({
  'cm-host': true,
  'cm-host--dark': settings.theme === 'dark',
  // #109 — constrain the editing column to a centered readable width.
  // 5.0 §5 — the column follows "fit to window width" when that is on.
  'cm-host--limit-width': settings.limitEditorWidth && !settings.previewFitWidth,
  // #211 — soft-wrap fenced code in the LIVE-rendered blocks too. Only
  // Preview.vue carried `cb-wrap-on` before, so the code-block-wrap setting
  // silently did nothing in Live Edit (CodeMirror live blocks + the Windows
  // plain block editor both render through this host). Same class name +
  // CSS as the preview so behaviour matches across modes.
  'cb-wrap-on': settings.codeBlockWrap,
}));
</script>

<template>
  <div
    v-if="!usePlainWindowsEditor"
    :class="cls"
    ref="host"
    @contextmenu="onEditorContextMenu"
  ></div>
  <div
    v-else
    ref="plainHostEl"
    class="plain-host"
    @mousedown.capture="onEditorMouseDownCapture"
    @contextmenu="onEditorContextMenu"
  >
    <div
      v-if="plainLiveEnabled"
      ref="plainLiveHost"
      :class="[
        cls,
        'plain-block-editor',
        {
          'plain-block-editor--cb-numbers': settings.codeBlockLineNumbers,
          'plain-block-editor--focus': plainFocusMode,
        },
      ]"
      :style="plainEditorStyle"
      @mousedown="onPlainLiveHostMouseDown"
    >
      <div
        v-for="(block, index) in plainBlocks"
        v-show="!plainBlockHidden(block, index)"
        :key="block.id"
        class="plain-block"
        :class="{
          'plain-block--active': index === plainActiveBlock,
          'plain-block--heading': !!plainHeadingFor(block),
        }"
        @click="(event) => activatePlainBlockFromClick(index, event)"
      >
        <button
          v-if="plainHeadingFor(block)"
          class="plain-fold-toggle"
          :class="{ 'plain-fold-toggle--folded': plainHeadingFolded(block) }"
          :title="plainHeadingFolded(block) ? t('fold.expand') : t('fold.collapse')"
          :aria-expanded="!plainHeadingFolded(block)"
          @click.stop="togglePlainFold(block)"
        >{{ plainHeadingFolded(block) ? '›' : '⌄' }}</button>
        <span
          v-if="plainHeadingFolded(block)"
          class="plain-fold-count"
          @click.stop="togglePlainFold(block)"
        >{{ t('fold.placeholder', { lines: plainHiddenLineCount(block) }) }}</span>
        <textarea
          v-if="index === plainActiveBlock"
          :ref="(el) => setPlainBlockEditor(index, el as HTMLTextAreaElement | null)"
          class="plain-block__textarea"
          :class="{
            'plain-textarea--wrap': settings.wordWrap,
            'plain-textarea--solid-caret': plainSolidCaretOn,
          }"
          :spellcheck="props.spellCheck"
          :wrap="settings.wordWrap ? 'soft' : 'off'"
          @keydown="(event) => handlePlainBlockKeydown(index, event)"
          @paste="handlePlainPaste"
          @input="(event) => handlePlainBlockInput(index, event)"
          @compositionstart="handlePlainBlockCompositionStart"
          @compositionend="(event) => handlePlainBlockCompositionEnd(index, event)"
          @click.stop
          @blur="schedulePlainOverlays"
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
        <!-- #330 — the current find match, drawn: the textarea paints no
             selection while the find box has focus. Positioned inside its
             own block, so it moves with the text when anything above
             re-renders to a different height (the browser's scroll anchoring
             keeps the text still on screen, and a highlight placed in the
             scroll container's coordinates would be left behind). -->
        <template v-if="index === plainActiveBlock">
          <div
            v-for="(r, i) in plainFindBoxes"
            :key="'find-' + i"
            class="plain-find-hl"
            aria-hidden="true"
            :style="{ top: r.top + 'px', left: r.left + 'px', width: r.width + 'px', height: r.height + 'px' }"
          ></div>
        </template>
      </div>
      <div
        v-if="plainCaretBox"
        class="plain-caret"
        aria-hidden="true"
        :style="{
          top: plainCaretBox.top + 'px',
          left: plainCaretBox.left + 'px',
          height: plainCaretBox.height + 'px',
        }"
      ></div>
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
        :class="{
          'plain-textarea--wrap': settings.wordWrap,
          'plain-textarea--solid-caret': plainSolidCaretOn,
        }"
        :spellcheck="props.spellCheck"
        :wrap="settings.wordWrap ? 'soft' : 'off'"
        @keydown="handlePlainEditorKeydown"
        @paste="handlePlainPaste"
        @input="handlePlainInput"
        @scroll="onPlainScroll"
        @mousedown="$event.button === 0 && clearStrayDocumentSelection($event.currentTarget as HTMLElement)"
        @blur="schedulePlainOverlays"
        @keyup="emitPlainCursorAndSelection"
        @mouseup="emitPlainCursorAndSelection"
        @select="emitPlainCursorAndSelection"
        @focus="emitPlainCursorAndSelection"
      ></textarea>
      <!-- #316 — focus mode: a <textarea> can't dim individual lines, so the
           inactive part of the document is covered in the editor's own
           background instead. Purely decorative; never takes a click. -->
      <template v-if="plainFocusBand">
        <div
          class="plain-shade"
          aria-hidden="true"
          :style="{ top: 0, left: plainShadeLeft, height: Math.max(0, plainFocusBand.top) + 'px' }"
        ></div>
        <div
          class="plain-shade"
          aria-hidden="true"
          :style="{ top: Math.max(0, plainFocusBand.bottom) + 'px', left: plainShadeLeft, bottom: 0 }"
        ></div>
      </template>
      <div
        v-if="plainCaretBox"
        class="plain-caret"
        aria-hidden="true"
        :style="{
          top: plainCaretBox.top + 'px',
          left: plainCaretBox.left + 'px',
          height: plainCaretBox.height + 'px',
        }"
      ></div>
      <!-- #330 — the current find match, drawn: the textarea paints no
           selection while the find box has focus. -->
      <div
        v-for="(r, i) in plainFindBoxes"
        :key="'find-' + i"
        class="plain-find-hl"
        aria-hidden="true"
        :style="{ top: r.top + 'px', left: r.left + 'px', width: r.width + 'px', height: r.height + 'px' }"
      ></div>
    </div>

    <!-- In-document find / replace (Ctrl+F). The textarea path has no CodeMirror
         search panel, so this provides one. -->
    <div
      v-if="plainFindOpen"
      ref="plainFindBar"
      class="plain-find"
      :class="{ 'plain-find--dodge': plainFindDodge }"
      @keydown.esc.prevent.stop="closePlainFind(true)"
    >
      <div class="plain-find__row">
        <!-- Enter / Shift+Enter step through matches and keep focus here;
             Esc hands the editor the current match (#330). -->
        <input
          ref="plainFindInput"
          class="plain-find__input"
          :value="plainFindQuery"
          :placeholder="t('plainFind.findPlaceholder')"
          @input="(e) => onPlainFindInput((e.target as HTMLInputElement).value, (e as InputEvent).isComposing)"
          @compositionend="(e) => onPlainFindInput((e.target as HTMLInputElement).value)"
          @keydown.enter="onPlainFindEnter"
        />
        <span class="plain-find__count">{{ plainMatches.length ? (plainMatchIndex + 1) + '/' + plainMatches.length : '0/0' }}</span>
        <button class="plain-find__btn" :title="t('plainFind.prev')" @click="gotoPlainMatch(-1)">‹</button>
        <button class="plain-find__btn" :title="t('plainFind.next')" @click="gotoPlainMatch(1)">›</button>
        <button
          class="plain-find__btn"
          :class="{ 'plain-find__btn--on': plainFindCaseSensitive }"
          :title="t('plainFind.matchCase')"
          @click="plainFindCaseSensitive = !plainFindCaseSensitive; revealPlainMatchFromAnchor()"
        >Aa</button>
        <button class="plain-find__btn" :title="t('plainFind.close')" @click="closePlainFind(true)">✕</button>
      </div>
      <div class="plain-find__row">
        <input
          ref="plainReplaceInput"
          class="plain-find__input"
          :value="plainReplaceValue"
          :placeholder="t('plainFind.replacePlaceholder')"
          @input="(e) => plainReplaceValue = (e.target as HTMLInputElement).value"
          @keydown.enter="(e) => { if (!e.isComposing && e.keyCode !== 229) { e.preventDefault(); replacePlainCurrent(); } }"
        />
        <button class="plain-find__btn plain-find__btn--text" @click="replacePlainCurrent">{{ t('plainFind.replaceOne') }}</button>
        <button class="plain-find__btn plain-find__btn--text" @click="replacePlainAll">{{ t('plainFind.replaceAll') }}</button>
      </div>
    </div>

    <!-- Autocomplete popup (/ slash, [[ wikilink, # tag, @ citation,
         ``` fence language). -->
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
  <SelectionBubble
    :host="bubbleHost"
    :enabled="bubbleEnabled"
    :read="readBubbleSelection"
    :rect="readBubbleRect"
    @format="applyFormatKind"
  />
  <Teleport to="body">
    <EditorContextMenu
      v-if="editorCtx"
      :x="editorCtx.x"
      :y="editorCtx.y"
      :has-selection="editorCtx.hasSelection"
      :has-image="editorCtx.hasImage"
      :spell="editorCtx.spell"
      @action="onEditorMenuAction"
      @replace="onEditorMenuReplace"
      @add-word="onEditorMenuAddWord"
      @close="editorCtx = null"
    />
  </Teleport>
</template>

<style scoped>
.cm-host {
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--bg);
}
/* #109 / 5.0 §5 — readable editing column: `--measure` (680px) of text,
   centred. .cm-content is border-box with 32px side padding plus CodeMirror's
   own 6px+2px line padding, hence the arithmetic. The Windows plain editors
   get the same column so both engines set the text identically. */
.cm-host--limit-width :deep(.cm-content) {
  max-width: calc(var(--measure) + 72px);
  margin-left: auto;
  margin-right: auto;
}
.cm-host--limit-width.plain-block-editor :deep(.plain-block) {
  max-width: var(--measure);
  margin-left: auto;
  margin-right: auto;
}
/* The flat textarea is its own scroller: centre the text with padding rather
   than a max-width, so the scrollbar stays at the pane edge. (% padding
   resolves against the pane, which is the textarea's width.) */
.cm-host--limit-width :deep(.plain-editor) {
  padding-left: max(32px, calc((100% - var(--measure)) / 2));
  padding-right: max(32px, calc((100% - var(--measure)) / 2));
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
/* #330 — the current match would sit under the bar (only possible near the
   top of the document, where it cannot be scrolled lower): dock at the bottom. */
.plain-find--dodge {
  top: auto;
  bottom: 8px;
}
/* #330 — the current match. Translucent so the glyphs underneath stay legible;
   above the textarea, never takes a click. */
.plain-find-hl {
  position: absolute;
  z-index: 2;
  border-radius: 2px;
  background: var(--accent);
  opacity: 0.35;
  pointer-events: none;
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
  /* 5.0 §5 — same surface as CodeMirror: 56px top, 32px sides, 30vh tail. */
  padding: 56px 32px 30vh;
  background: var(--bg);
  color: var(--text);
  caret-color: var(--accent);
  font-family: var(--plain-editor-font-family, var(--font-editor, var(--font-ui)));
  font-size: var(--plain-editor-font-size, 16px);
  line-height: 1.8;
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
  /* Anchors the focus shade and the drawn caret (#316); clipping keeps a
     caret that has scrolled out of the textarea from painting over the UI. */
  position: relative;
  overflow: hidden;
}
/* #316 — focus mode's dimming for the flat textarea. Painted in the editor's
   own background at 0.65, which reads the same as the 0.35 text opacity the
   CodeMirror extension applies. */
.plain-shade {
  position: absolute;
  right: 0;
  z-index: 1;
  background: var(--bg);
  opacity: 0.65;
  pointer-events: none;
  transition: opacity 0.12s ease;
}
/* #316 — the non-blinking caret drawn for 实心光标, matching the 2px accent
   bar of CodeMirror's .cm-cursor. */
.plain-caret {
  position: absolute;
  width: 2px;
  z-index: 2;
  background: var(--accent);
  pointer-events: none;
}
/* Both textareas, and written as a compound selector so it still wins
   against `.plain-block__textarea { caret-color: var(--accent) }` further
   down the sheet — at equal specificity the later rule would take it, and
   the native caret would blink on next to the drawn one. */
.plain-editor.plain-textarea--solid-caret,
.plain-block__textarea.plain-textarea--solid-caret {
  caret-color: transparent;
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
  /* Top padding must match .plain-editor's 56px or numbers drift off rows. */
  padding: 56px 8px 12px 0;
  border-right: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  background: var(--bg);
  color: var(--text-faint, #999);
  font-family: var(--plain-editor-font-family, var(--font-editor, var(--font-ui)));
  font-size: var(--plain-editor-font-size, 16px);
  line-height: 1.8;
  text-align: right;
  user-select: none;
}
.plain-gutter__num {
  box-sizing: border-box;
}
.plain-block-editor {
  overflow: auto;
  /* Anchors the drawn caret (#316). */
  position: relative;
  padding: 56px 32px 30vh;
  box-sizing: border-box;
  font-family: var(--plain-editor-font-family, var(--font-editor, var(--font-ui)));
  font-size: var(--plain-editor-font-size, 16px);
  line-height: 1.8;
}
.plain-block {
  position: relative;
  min-height: 1.8em;
  padding: 1px 0;
}
.plain-block--active {
  background: var(--bg);
}
/* #316 — focus mode in the block live editor: one element per paragraph
   already exists, so the inactive ones just dim. Same 0.35 the CodeMirror
   extension uses for a dimmed line. */
.plain-block-editor--focus .plain-block {
  opacity: 0.35;
  transition: opacity 0.12s ease;
}
.plain-block-editor--focus .plain-block--active {
  opacity: 1;
}
/* Fold chevron for heading blocks. Sits in the left margin so it never
   reflows the heading text; only visible on hover (or while folded) so an
   unfolded document reads exactly as it did before folding existed. */
.plain-fold-toggle {
  position: absolute;
  left: -14px;
  top: 2px;
  width: 14px;
  height: 1.4em;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--fg-dim, #888);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease;
  font-size: 12px;
  line-height: 1;
}
.plain-block:hover .plain-fold-toggle,
.plain-fold-toggle--folded,
.plain-fold-toggle:focus-visible {
  opacity: 1;
}
.plain-fold-count {
  position: absolute;
  right: 8px;
  top: 2px;
  padding: 0 6px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.18);
  color: var(--fg-dim, #888);
  font-size: 0.8em;
  cursor: pointer;
  user-select: none;
}
.plain-block__textarea {
  display: block;
  width: 100%;
  min-height: 1.8em;
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
  /* #366 — same line pitch as the rendered block (.plain-block__render), so a
     paragraph keeps its height when clicked into. At the inherited 1.6 every
     line shrank by 1.4px on activation: a 24-line block jumped ~34px.
     5.0: both at the editor's 1.8. */
  line-height: 1.8;
  tab-size: 2;
  white-space: pre;
}
.plain-block__textarea.plain-textarea--wrap {
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
.plain-block__textarea::selection,
.plain-editor::selection {
  background: var(--accent-soft);
}
:root.window-inactive .plain-block__textarea::selection,
:root.window-inactive .plain-editor::selection {
  background: var(--select-inactive);
}
.plain-block__render {
  color: var(--text);
  overflow: visible;
  /* #143 — rendered (non-focused) blocks must use the SAME user-configured
     editor font as the focused textarea block, or live-edit looks like two
     different documents (only the focused line honored 字体/字号). Fall back
     to the old values for safety. */
  font-family: var(--plain-editor-font-family, var(--font-ui));
  font-size: var(--plain-editor-font-size, 16px);
  line-height: 1.8;
  padding: 0.05em 0;
}
.plain-block__render :deep(h1),
.plain-block__render :deep(h2),
.plain-block__render :deep(h3),
.plain-block__render :deep(h4),
.plain-block__render :deep(h5),
.plain-block__render :deep(h6) {
  font-weight: 600;
  line-height: 1.25;
  margin: 1.1em 0 0.45em;
}
/* 5.0 §2 type scale, in em of the body (30 / 20 / 17 at 16px) so a user's
   font size still scales the whole page. Same values as Preview.vue and the
   CodeMirror live view (lib/cm-live-render.ts). */
.plain-block__render :deep(h1) {
  font-size: 1.875em;
  font-weight: 650;
  letter-spacing: -0.015em;
}
.plain-block__render :deep(h2) {
  font-size: 1.25em;
  font-weight: 620;
}
.plain-block__render :deep(h3) {
  font-size: 1.0625em;
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
  color: var(--accent-text);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--accent-text) 35%, transparent);
  text-underline-offset: 3px;
}
.plain-block__render :deep(a:hover) {
  text-decoration-color: currentColor;
}
.plain-block__render :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.875em;
  color: var(--text);
  background: var(--fill-1);
  padding: 0.12em 0.35em;
  border-radius: var(--r-xs);
}
.plain-block__render :deep(pre) {
  font-family: var(--font-mono);
  font-size: 0.8125em;
  line-height: 1.6;
  background: var(--bg-elev);
  padding: 14px 16px;
  border-radius: var(--r-lg);
  overflow-x: auto;
}
.plain-block__render :deep(pre code) {
  display: block;
  font-size: inherit;
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
  margin-left: 0;
  margin-right: 0;
  padding: 12px 16px;
  background: var(--bg-elev);
  border-radius: var(--r-lg);
  color: var(--text-2);
}
.plain-block__render :deep(blockquote > :last-child) {
  margin-bottom: 0;
}
.plain-block__render :deep(ul),
.plain-block__render :deep(ol) {
  padding-left: 1.6em;
}
.plain-block__render :deep(li::marker) {
  color: var(--text-3);
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
  background: var(--bg-elev);
  font-weight: 600;
}
.plain-block__render :deep(hr) {
  border: none;
  border-top: 1px solid var(--hairline);
  margin: 1.6em 0;
}
.plain-block__render :deep(img) {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}
.plain-block__render :deep(.katex-display) {
  /* KaTeX draws tall delimiters, limits and \dfrac a few px past the formula
     box; overflow-x:auto forces overflow-y to clip, which cut their bottoms
     off. Padding gives them room inside the box (margin reduced to match). */
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0.5em 0;
  margin: 0.5em 0;
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
