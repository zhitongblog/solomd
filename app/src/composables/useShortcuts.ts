import { onMounted, onUnmounted } from 'vue';
import { useFiles } from './useFiles';
import { useExport } from './useExport';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useTilesStore } from '../stores/tiles';
import { useCommands } from './useCommands';
import { useInbox } from './useInbox';
import { usePomodoroStore, getLastPreset } from '../stores/pomodoro';
import { eventToCombo, resolveBindings } from '../lib/keybindings';
import { getCurrentWindow } from '@tauri-apps/api/window';

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
    'file.open': () => void files.openFile(),
    'file.save': () => void files.saveActive(),
    'file.saveAs': () => void files.saveActiveAs(),
    'file.closeTab': () => {
      if (tabs.activeId) files.closeTabSafe(tabs.activeId);
    },
    'file.openExternal': () => runById('file.openExternal'),
    'window.new': () => runById('window.new'),
    'file.exit': () => void getCurrentWindow().close(),

    'editor.caseCycle': () => runById('editor.caseCycle'),
    'format.markdown': () => runById('format.markdown'),
    'export.copyHtml': () => void exporter.copyAsHtml(),
    // Markdown is what most people actually want to paste elsewhere (issues,
    // chat, other editors), so it earns the second copy binding. Plain-text
    // and PNG stay palette-only — they're one-off exports.
    'export.copyMd': () => void exporter.copyAsMarkdown(),
    'export.pdfPrint': () => runById('export.pdfPrint'),

    'view.cycleView': () => settings.cycleViewMode(),
    // Pressing the same combo while already in reading mode restores the
    // previous mode.
    'view.toggleReading': () => settings.toggleReadingMode(),
    'view.toggleFileTree': () => settings.toggleFileTree(),
    // Mirrors the file-tree toggle on the right: hides / shows the Outline /
    // Backlinks / Tags / History / Agent strip wholesale.
    'view.toggleRightSidebar': () => settings.toggleRightSidebar(),
    'view.toggleOutline': () => runById('view.toggleOutline'),
    'view.toggleInspector': () => settings.toggleInspector(),
    'view.slideshow': () => runById('view.slideshow'),
    'view.toggleMenuBar': () => settings.toggleMenuBar(),

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
    const combo = eventToCombo(e);
    if (!combo) return;
    const bindings = resolveBindings(settings.keybindings);
    const actionId = bindings.get(combo);
    if (!actionId) return;
    const run = actions[actionId];
    if (!run) return;
    if (run() === false) return; // action declined — leave the event alone
    e.preventDefault();
  }

  onMounted(() => window.addEventListener('keydown', handler));
  onUnmounted(() => window.removeEventListener('keydown', handler));
}
