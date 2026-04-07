import { onMounted, onUnmounted } from 'vue';
import { useFiles } from './useFiles';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useCommands } from './useCommands';

interface Hooks {
  openPalette?: () => void;
  openSettings?: () => void;
  openHelp?: () => void;
  openGlobalSearch?: () => void;
}

export function useShortcuts(hooks: Hooks = {}) {
  const files = useFiles();
  const settings = useSettingsStore();
  const tabs = useTabsStore();
  const commands = useCommands();

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
    } else if (k === 'p') {
      e.preventDefault();
      runById('export.pdfPrint');
    } else if (k === 'k' && e.shiftKey) {
      e.preventDefault();
      hooks.openPalette?.();
    } else if (k === 'f' && e.shiftKey) {
      e.preventDefault();
      hooks.openGlobalSearch?.();
    } else if (k === 'b') {
      e.preventDefault();
      settings.toggleFileTree();
    }
  }

  onMounted(() => window.addEventListener('keydown', handler));
  onUnmounted(() => window.removeEventListener('keydown', handler));
}
