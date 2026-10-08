import { onMounted, onUnmounted } from 'vue';
import { useFiles } from './useFiles';
import { useExport } from './useExport';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useTilesStore } from '../stores/tiles';
import { useCommands } from './useCommands';
import { useInbox } from './useInbox';
import { usePomodoroStore, getLastPreset } from '../stores/pomodoro';
import { eventToCombo, normalizeCombo, resolveBindings } from '../lib/keybindings';
import { isWindowsDesktop } from '../lib/platform';
import { FORMAT_KINDS, type FormatKind } from '../lib/md-format';
import { MARKDOWN_ONLY_COMMANDS, type EditorCommand } from '../lib/editor-commands';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IS_APP_STORE_BUILD } from '../lib/app-build';

interface Hooks {
  openPalette?: () => void;
  openSettings?: () => void;
  openHelp?: () => void;
  openGlobalSearch?: () => void;
  /** v2.3: open the RAG / semantic-search panel. */
  openRagSearch?: () => void;
  /** v2.5: open the VSCode-style ⌘P quick file switcher. */
  openQuickSwitcher?: () => void;
  /** v2.5 F6: open the CJK proofread panel (⌘⇧J — J for "句"/sentence). */
  openCjkProofread?: () => void;
}

/** Bound in CodeMirror's keymap too; the global handler only covers the
 *  places CodeMirror isn't (the native editor, panels, the file tree). */
const CM_HANDLED = new Set(['editor.aiRewrite']);

export function useShortcuts(hooks: Hooks = {}) {
  const files = useFiles();
  const exporter = useExport();
  const settings = useSettingsStore();
  const tabs = useTabsStore();
  const tiles = useTilesStore();
  const commands = useCommands();
  const inbox = useInbox();
  const pomodoro = usePomodoroStore();

  function runById(id: string) {
    const cmd = commands.find((c) => c.id === id);
    if (cmd) cmd.run();
  }

  /**
   * #296 — formatting only means something while typing in a Markdown
   * document. Anywhere else (the find bar, a settings field, a .txt tab) the
   * chord is declined so it keeps whatever it does natively — ⌘I in a text
   * field should not silently edit the note behind the dialog.
   */
  function formatMarkdown(kind: FormatKind): boolean | void {
    if (tabs.activeTab?.language !== 'markdown') return false;
    const el = document.activeElement as HTMLElement | null;
    // The find bars live *inside* the editor hosts, so match the editing
    // surface itself, not its container.
    const inEditor = !!el?.closest('.cm-content, textarea.plain-editor, textarea.plain-block__textarea');
    const inField = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    if (inField && !inEditor) return false;
    if (settings.viewMode === 'preview' || settings.viewMode === 'reading') return false;
    window.dispatchEvent(new CustomEvent('solomd:format-markdown', { detail: { kind } }));
  }

  /**
   * B4 — select / delete word, select line, jump to selection, heading
   * level. Same gate as formatting: declined in a field that is not the
   * editor (a find box, a settings input) and in the read-only views, so the
   * chord keeps whatever it does there. Editor.vue runs the command on
   * whichever of its three editors this pane is.
   */
  function editorCommand(cmd: EditorCommand): boolean | void {
    const tab = tabs.activeTab;
    if (!tab) return false;
    if (MARKDOWN_ONLY_COMMANDS.has(cmd) && tab.language !== 'markdown') return false;
    const el = document.activeElement as HTMLElement | null;
    const inEditor = !!el?.closest('.cm-content, textarea.plain-editor, textarea.plain-block__textarea');
    const inField = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    if (inField && !inEditor) return false;
    if (settings.viewMode === 'preview' || settings.viewMode === 'reading') return false;
    window.dispatchEvent(new CustomEvent('solomd:editor-command', { detail: { cmd } }));
  }

  /** #106 — cycle the focused pane to the previous/next tab in the bar.
   *  Routes through tiles.setActiveTab so the pane's activeTabId stays in
   *  lock-step with tabs.activeId (the same path a click takes). Wraps
   *  around the ends so the shortcut never dead-ends. */
  function activateTabByOffset(offset: 1 | -1) {
    const list = tabs.tabs;
    if (list.length < 2) return;
    const cur = list.findIndex((t) => t.id === tabs.activeId);
    const idx = cur < 0 ? 0 : (cur + offset + list.length) % list.length;
    tiles.setActiveTab(tiles.focusedPaneId, list[idx].id);
  }

  /**
   * #180 — what each bindable action does. The table in `lib/keybindings.ts`
   * owns which chord reaches which id; this owns what the id means, keeping
   * the conditional behaviours (search mode, inbox workflow, preview-only
   * find) exactly where they were before the shortcuts became rebindable.
   *
   * Returning `false` means "not handled" — the event keeps its default, so
   * ⌘F in a non-preview pane still reaches CodeMirror's own find.
   */
  const actions: Record<string, () => boolean | void> = {
    'file.new': () => void files.newFile(),
    'file.newText': () => void files.newTextFile(),
    'file.newInFolder': () => runById('file.newInFolder'),
    'file.open': () => void files.openFile(),
    'file.import': () => void files.importDocuments(),
    'file.save': () => void files.saveActive(),
    'file.saveAs': () => void files.saveActiveAs(),
    'file.closeTab': () => {
      if (tabs.activeId) files.closeTabSafe(tabs.activeId);
    },
    'file.openExternal': () => runById('file.openExternal'),
    'tab.reopenClosed': () => void files.reopenClosedTab(),
    'window.new': () => runById('window.new'),
    'file.exit': () => void getCurrentWindow().close(),

    'editor.caseCycle': () => runById('editor.caseCycle'),
    // 张工 4.14.8 report #5: AI rewrite was bound only inside CodeMirror's
    // keymap, so in the Windows native editor (and with focus anywhere else)
    // Ctrl+J fell through to WebView2, which opened its downloads page. Here
    // it runs the toolbar's AI rewrite, which reads the selection from either
    // editor. CodeMirror keeps handling it itself — see CM_HANDLED below.
    'editor.aiRewrite': () => {
      if (IS_APP_STORE_BUILD) return false;
      window.dispatchEvent(new CustomEvent('solomd:toolbar-ai-rewrite'));
    },
    'editor.selectWord': () => editorCommand('selectWord'),
    'editor.deleteWord': () => editorCommand('deleteWord'),
    'editor.selectLine': () => editorCommand('selectLine'),
    'editor.jumpToSelection': () => editorCommand('jumpToSelection'),
    'heading.promote': () => editorCommand('headingPromote'),
    'heading.demote': () => editorCommand('headingDemote'),
    'heading.paragraph': () => editorCommand('headingParagraph'),
    // #296 — one entry per kind, generated: the ids are `fmt.<kind>` on both
    // sides, so a kind added to FORMAT_KINDS cannot be bound but unhandled.
    ...Object.fromEntries(
      FORMAT_KINDS.map((kind) => [`fmt.${kind}`, () => formatMarkdown(kind)]),
    ),
    'format.markdown': () => runById('format.markdown'),
    'editor.tableEditor': () => runById('editor.tableEditor'),
    'editor.formulaEditor': () => runById('editor.formulaEditor'),
    'export.copyHtml': () => void exporter.copyAsHtml(),
    // Markdown is what most people actually want to paste elsewhere (issues,
    // chat, other editors), so it earns the second copy binding. Plain-text
    // and PNG stay palette-only — they're one-off exports.
    'export.copyMd': () => void exporter.copyAsMarkdown(),
    'export.pdfPrint': () => runById('export.pdfPrint'),

    'view.cycleView': () => settings.cycleViewMode(),
    'view.toggleLiveEdit': () => settings.toggleLiveEditSource(),
    // Pressing the same combo while already in reading mode restores the
    // previous mode.
    'view.toggleReading': () => settings.toggleReadingMode(),
    'view.toggleFileTree': () => settings.toggleFileTree(),
    // Mirrors the file-tree toggle on the right: hides / shows the Outline /
    // Backlinks / Tags / History / Agent strip wholesale.
    'view.toggleRightSidebar': () => settings.toggleRightSidebar(),
    'view.toggleOutline': () => runById('view.toggleOutline'),
    'view.toggleInspector': () => settings.toggleInspector(),
    'view.toggleToolbar': () => settings.toggleToolbarHidden(),
    'view.slideshow': () => runById('view.slideshow'),
    'view.toggleFocusMode': () => settings.toggleFocusMode(),
    'view.toggleTypewriter': () => settings.toggleTypewriterMode(),
    'view.zoomUiIn': () => settings.zoomIn(),
    'view.zoomUiOut': () => settings.zoomOut(),
    'view.zoomUiReset': () => settings.resetZoom(),
    'view.zoomEditorIn': () => settings.editorFontIn(),
    'view.zoomEditorOut': () => settings.editorFontOut(),
    'view.zoomEditorReset': () => settings.resetEditorFontSize(),
    'fold.toggle': () => runById('fold.toggle'),
    'fold.all': () => runById('fold.all'),
    'fold.none': () => runById('fold.none'),

    'palette.open': () => hooks.openPalette?.(),
    'quickSwitcher.open': () => hooks.openQuickSwitcher?.(),
    // Prefers semantic search when the user has opted in; otherwise keeps the
    // keyword search so muscle memory carries over.
    'search.global': () => {
      if (settings.ragEnabled) hooks.openRagSearch?.();
      else hooks.openGlobalSearch?.();
    },
    // Only the preview pane needs our own find; anywhere else the event must
    // fall through to CodeMirror's.
    'editor.find': () => {
      if (settings.viewMode !== 'preview' || tabs.activeTab?.language !== 'markdown') return false;
      window.dispatchEvent(
        new CustomEvent('solomd:preview-search', { detail: { paneId: tiles.focusedPaneId } }),
      );
    },
    // Opens the same find bar with the caret in the replace field. The
    // preview has no replace, so there it is the preview's find.
    'editor.replace': () => {
      if (settings.viewMode === 'preview' && tabs.activeTab?.language === 'markdown') {
        window.dispatchEvent(
          new CustomEvent('solomd:preview-search', { detail: { paneId: tiles.focusedPaneId } }),
        );
        return;
      }
      window.dispatchEvent(
        new CustomEvent('solomd:editor-find', { detail: { paneId: tiles.focusedPaneId, replace: true } }),
      );
    },
    'tab.prev': () => activateTabByOffset(-1),
    'tab.next': () => activateTabByOffset(1),
    'tile.splitRight': () => tiles.splitPane(tiles.focusedPaneId, 'horizontal'),
    'tile.splitDown': () => tiles.splitPane(tiles.focusedPaneId, 'vertical'),
    'tile.focusNext': () => tiles.focusNextPane(),
    'tile.focusPrev': () => tiles.focusPrevPane(),

    'settings.open': () => hooks.openSettings?.(),
    'help.markdown': () => hooks.openHelp?.(),
    'proofread.cjk': () => hooks.openCjkProofread?.(),
    'daily.openToday': () => runById('daily.openToday'),
    // v4.6 F6: inside the inbox context with auto-advance on, this marks the
    // note organized and jumps to the next one; elsewhere it degrades to the
    // plain front-matter toggle, and it's off entirely when opted out.
    'inbox.toggle': () => {
      if (settings.inboxWorkflowEnabled) void inbox.organizeAndAdvance();
      else inbox.toggleActive();
    },
    // A no-op while a session runs, so the shortcut can't restart one and
    // lose the writing window in progress.
    'pomodoro.startLast': () => {
      if (pomodoro.active) return;
      const last = getLastPreset();
      const min = Number.isFinite(last) && last > 0 ? last : settings.pomodoroDefaultMinutes;
      pomodoro.start(min, { notify: true });
    },
  };

  function handler(e: KeyboardEvent) {
    const raw = eventToCombo(e);
    if (!raw) return;
    // A key event without a `code` (synthetic input, some remote-desktop and
    // accessibility tools) spells punctuation as the character — "Mod+,"
    // for the table's "Mod+Comma". Normalizing maps it back.
    const combo = normalizeCombo(raw);
    // ⌃⌘= / ⌃⌘- / ⌃⌘0 is the preview zoom axis on macOS (App.vue). "Mod"
    // reads ⌃⌘ as one modifier, so without this it would also zoom the UI.
    if (e.metaKey && e.ctrlKey && /^Mod\+(Equal|Minus|0)$/.test(combo)) return;
    const bindings = resolveBindings(settings.keybindings);
    const actionId = bindings.get(combo);
    if (!actionId) return;
    // Actions CodeMirror's own keymap already ran (it calls preventDefault):
    // running them again here would open the same overlay twice.
    if (e.defaultPrevented && CM_HANDLED.has(actionId)) return;
    // Menu commands made bindable for the menus' sake (export, quick capture,
    // open folder…) need no handler of their own: they run as the palette does.
    const run = actions[actionId] ?? (commands.some((c) => c.id === actionId) ? () => runById(actionId) : undefined);
    if (!run) return;
    if (run() === false) return; // action declined — leave the event alone
    e.preventDefault();
  }

  // Ctrl+, did nothing while typing in either editor on Windows, and worked
  // from the file tree or preview — i.e. only where an input method is
  // attached to the focused field, which can consume the keydown of a chord
  // outright. Its keyup still arrives. So a Ctrl chord whose keydown never
  // reached the page runs on keyup instead. Keydowns are noted in the capture
  // phase, before anything can stop them, so a chord already handled on
  // keydown can never run twice. (macOS sends no keyup while ⌘ is held.)
  //
  // Windows only. On Linux a chord that is also a native menu accelerator is
  // taken by GTK on keydown — the menu runs the action and the page never sees
  // that keydown — so the keyup ran it a second time: Ctrl+B bolded on press
  // and un-bolded on release (4.14.6–4.14.10). Windows has no native menu.
  const keyupFallback = isWindowsDesktop();
  const downCodes = new Set<string>();
  function noteKeydown(e: KeyboardEvent) {
    if (e.code) downCodes.add(e.code);
  }
  function onKeyup(e: KeyboardEvent) {
    const seen = downCodes.delete(e.code);
    if (seen || !keyupFallback || !e.ctrlKey || e.metaKey || !e.code) return;
    handler(e);
  }
  function onBlur() {
    downCodes.clear();
  }

  /**
   * Run a bindable action by id — the menus (native and the Windows menubar)
   * call this so a menu item and its shortcut can never do different things.
   * Returns null for an id that is not a bindable action, false when the
   * action declined (e.g. formatting while a non-editor field has focus).
   */
  function runAction(id: string): boolean | null {
    const run = actions[id];
    if (!run) return null;
    return run() !== false;
  }

  onMounted(() => {
    window.addEventListener('keydown', noteKeydown, true);
    window.addEventListener('keydown', handler);
    window.addEventListener('keyup', onKeyup);
    window.addEventListener('blur', onBlur);
  });
  onUnmounted(() => {
    window.removeEventListener('keydown', noteKeydown, true);
    window.removeEventListener('keydown', handler);
    window.removeEventListener('keyup', onKeyup);
    window.removeEventListener('blur', onBlur);
  });

  return { runAction };
}
