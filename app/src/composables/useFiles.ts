import { inject } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceStore } from '../stores/workspace';
import { useSettingsStore } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import type { FileReadResult, Tab } from '../types';

// Save dialogs only — opening uses no filter so any file is selectable.
// (rfd treats `'*'` literally as the extension `*`, not as wildcard, so we
// can't reliably express "all files" via filters on macOS.)
const SAVE_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
  { name: 'Plain Text', extensions: ['txt'] },
];

export function useFiles() {
  const tabs = useTabsStore();
  const workspace = useWorkspaceStore();
  const settings = useSettingsStore();
  const toasts = useToastsStore();

  async function newFile() {
    tabs.newTab();
  }

  async function newTextFile() {
    tabs.newTab({ fileName: 'Untitled.txt', language: 'plaintext' });
  }

  async function openFile() {
    // No filters: rfd's filter behavior on macOS greys out non-matching files
    // and `'*'` is not treated as a wildcard. Letting the user pick anything
    // is simpler and more reliable.
    const selected = await openDialog({ multiple: false });
    if (!selected || typeof selected !== 'string') return;
    await openPath(selected);
  }

  // Extensions that the built-in converter handles (Rust, no Python).
  const CONVERT_BUILTIN = new Set(['docx', 'csv', 'xlsx', 'xls', 'html', 'htm']);

  // Extensions that need markitdown CLI (Python).
  const CONVERT_CLI = new Set([
    'pdf', 'pptx', 'epub', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp',
    'mp3', 'wav', 'm4a', 'ogg', 'flac',
  ]);

  async function openPath(path: string) {
    const ext = (path.split('.').pop() || '').toLowerCase();

    // If it's a convertible format, convert to Markdown first.
    if (CONVERT_BUILTIN.has(ext) || CONVERT_CLI.has(ext)) {
      return openAndConvert(path, ext);
    }

    // Native open: text files, markdown, code, etc.
    try {
      const result = await invoke<FileReadResult>('read_file', { path });
      tabs.openFromDisk({
        filePath: path,
        content: result.content,
        encoding: result.encoding,
        language: result.language,
        hadBom: result.had_bom,
      });
      workspace.pushRecent(path);
      const fileName = path.split(/[\\/]/).pop() ?? path;
      toasts.success(`Opened ${fileName}`);
    } catch (e) {
      console.error('open failed', e);
      toasts.error(`Failed to open file: ${e}`);
    }
  }

  async function openAndConvert(path: string, ext: string) {
    const fileName = path.split(/[\\/]/).pop() ?? path;
    const tid = toasts.info(`Converting ${fileName} to Markdown…`, 0);
    try {
      const markdown = await invoke<string>('convert_file_to_markdown', { path });
      toasts.dismiss(tid);
      // Open as a new unsaved Markdown tab with the converted content.
      const baseName = fileName.replace(/\.[^.]+$/, '');
      tabs.newTab();
      const tab = tabs.activeTab;
      if (tab) {
        tab.content = markdown;
        tab.fileName = `${baseName}.md`;
        tab.language = 'markdown';
      }
      toasts.success(`Converted ${fileName} → Markdown`);
    } catch (e) {
      toasts.dismiss(tid);
      const msg = String(e);
      if (msg.includes('markitdown')) {
        // Show install hint for markitdown-dependent formats
        toasts.warning(
          `Converting .${ext} requires markitdown:\npip install 'markitdown[all]'`,
          8000,
        );
      } else {
        toasts.error(`Conversion failed: ${msg}`);
      }
    }
  }

  async function openFolder() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected || typeof selected !== 'string') return;
    workspace.setFolder(selected);
    if (!settings.showFileTree) settings.toggleFileTree();
  }

  async function saveTab(tab: Tab): Promise<boolean> {
    if (!tab.filePath) return saveTabAs(tab);
    try {
      await invoke('write_file', {
        path: tab.filePath,
        content: tab.content,
        encoding: tab.encoding || 'UTF-8',
      });
      tabs.markSaved(tab.id, tab.filePath);
      workspace.pushRecent(tab.filePath);
      toasts.success(`Saved ${tab.fileName}`);
      return true;
    } catch (e) {
      console.error('save failed', e);
      toasts.error(`Failed to save: ${e}`);
      return false;
    }
  }

  async function saveTabAs(tab: Tab): Promise<boolean> {
    const defaultName = tab.fileName || (tab.language === 'markdown' ? 'Untitled.md' : 'Untitled.txt');
    const path = await saveDialog({
      defaultPath: tab.filePath ?? defaultName,
      filters: SAVE_FILTERS,
    });
    if (!path) return false;
    try {
      await invoke('write_file', {
        path,
        content: tab.content,
        encoding: tab.encoding || 'UTF-8',
      });
      tabs.markSaved(tab.id, path);
      workspace.pushRecent(path);
      const fileName = path.split(/[\\/]/).pop() ?? path;
      toasts.success(`Saved as ${fileName}`);
      return true;
    } catch (e) {
      console.error('save-as failed', e);
      toasts.error(`Failed to save: ${e}`);
      return false;
    }
  }

  async function saveActive() {
    if (tabs.activeTab) await saveTab(tabs.activeTab);
  }

  async function saveActiveAs() {
    if (tabs.activeTab) await saveTabAs(tabs.activeTab);
  }

  type UnsavedDialog = (mode: 'tab' | 'window', fileName: string, count: number) => Promise<'save' | 'discard' | 'cancel'>;
  const injectedDialog = inject<UnsavedDialog>('showUnsavedDialog');

  /** Get the dialog from whichever source is available.
   *  Prefer inject (scoped) but fall back to window-global so shortcuts
   *  and menu-driven closes also get the prompt. */
  function getUnsavedDialog(): UnsavedDialog | undefined {
    if (injectedDialog) return injectedDialog;
    const w = window as any;
    return w.__solomd_showUnsavedDialog as UnsavedDialog | undefined;
  }

  async function closeTabSafe(id: string) {
    const tab = tabs.tabs.find((t) => t.id === id);
    if (!tab) return;
    const showUnsavedDialog = getUnsavedDialog();
    if (tab.content !== tab.savedContent && showUnsavedDialog) {
      const action = await showUnsavedDialog('tab', tab.fileName, 1);
      if (action === 'save') {
        const ok = await saveTab(tab);
        if (!ok) return;
      } else if (action === 'cancel') {
        return; // go back to editing
      }
      // 'discard' → fall through to close
    }
    tabs.closeTab(id);
  }

  return {
    newFile,
    newTextFile,
    openFile,
    openPath,
    openFolder,
    saveActive,
    saveActiveAs,
    closeTabSafe,
  };
}
