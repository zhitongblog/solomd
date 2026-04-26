import { onMounted, onUnmounted } from 'vue';
import { useFiles } from './useFiles';
import { useExport } from './useExport';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useTilesStore } from '../stores/tiles';
import { useCommands } from './useCommands';
import { useInbox } from './useInbox';

interface Hooks {
  openPalette?: () => void;
  openSettings?: () => void;
  openHelp?: () => void;
  openGlobalSearch?: () => void;
  /** v2.3: open the RAG / semantic-search panel. */
  openRagSearch?: () => void;
}

export function useShortcuts(hooks: Hooks = {}) {
  const files = useFiles();
  const exporter = useExport();
  const settings = useSettingsStore();
  const tabs = useTabsStore();
  const tiles = useTilesStore();
  const commands = useCommands();
  const inbox = useInbox();

  function runById(id: string) {
    const cmd = commands.find((c) => c.id === id);
    if (cmd) cmd.run();
  }

  function handler(e: KeyboardEvent) {
    // F1 (no modifier) opens markdown help
    if (e.key === 'F1') {
      e.preventDefault();
      hooks.openHelp?.();
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();

    // Ctrl+,  (settings)
    if (e.key === ',') {
      e.preventDefault();
      hooks.openSettings?.();
      return;
    }

    // Ctrl+/  (help)
    if (e.key === '/') {
      e.preventDefault();
      hooks.openHelp?.();
      return;
    }

    if (k === 'n' && e.shiftKey) {
      e.preventDefault();
      runById('window.new');
    } else if (k === 'n' && e.altKey) {
      e.preventDefault();
      files.newTextFile();
    } else if (k === 'n') {
      e.preventDefault();
      files.newFile();
    } else if (k === 'o' && e.shiftKey) {
      e.preventDefault();
      runById('view.toggleOutline');
    } else if (k === 'o') {
      e.preventDefault();
      files.openFile();
    } else if (k === 'c' && e.shiftKey) {
      e.preventDefault();
      exporter.copyAsHtml();
    } else if (k === 's' && e.shiftKey) {
      e.preventDefault();
      files.saveActiveAs();
    } else if (k === 's') {
      e.preventDefault();
      files.saveActive();
    } else if (k === 'w') {
      e.preventDefault();
      if (tabs.activeId) files.closeTabSafe(tabs.activeId);
    } else if (k === 'p' && e.shiftKey) {
      e.preventDefault();
      settings.cycleViewMode();
    } else if (k === 'p' && e.altKey) {
      e.preventDefault();
      runById('view.slideshow');
    } else if (k === 'p') {
      e.preventDefault();
      runById('export.pdfPrint');
    } else if (k === 'r' && e.shiftKey) {
      // v2.4: Cmd/Ctrl+Shift+R toggles reading mode. Pressing the same
      // combo while already in reading mode restores the previous mode.
      e.preventDefault();
      settings.toggleReadingMode();
    } else if (k === 'k' && e.shiftKey) {
      e.preventDefault();
      hooks.openPalette?.();
    } else if (k === 'f' && e.shiftKey) {
      e.preventDefault();
      // v2.3: ⌘⇧F prefers semantic search when the user has opted in;
      // otherwise we keep the legacy keyword search behaviour so muscle
      // memory carries over.
      if (settings.ragEnabled) {
        hooks.openRagSearch?.();
      } else {
        hooks.openGlobalSearch?.();
      }
    } else if (k === 'f' && !e.shiftKey) {
      if (settings.viewMode === 'preview' && tabs.activeTab?.language === 'markdown') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('solomd:preview-search', {
          detail: { paneId: tiles.focusedPaneId },
        }));
      }
    } else if (k === 'b') {
      e.preventDefault();
      settings.toggleFileTree();
    } else if (k === 'l' && e.altKey) {
      e.preventDefault();
      runById('format.markdown');
    } else if (k === 'd' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      runById('daily.openToday');
    } else if (k === 'e' && !e.shiftKey && !e.altKey) {
      // v2.4: ⌘E toggles `inbox: true|false` in the active doc's front matter.
      e.preventDefault();
      inbox.toggleActive();
    }

    // Tile layout shortcuts
    if (e.key === '\\') {
      e.preventDefault();
      if (e.shiftKey) {
        tiles.splitPane(tiles.focusedPaneId, 'vertical');
      } else {
        tiles.splitPane(tiles.focusedPaneId, 'horizontal');
      }
      return;
    }
    if (k === 'arrowright' && e.altKey) {
      e.preventDefault();
      tiles.focusNextPane();
      return;
    }
    if (k === 'arrowleft' && e.altKey) {
      e.preventDefault();
      tiles.focusPrevPane();
      return;
    }
  }

  onMounted(() => window.addEventListener('keydown', handler));
  onUnmounted(() => window.removeEventListener('keydown', handler));
}
