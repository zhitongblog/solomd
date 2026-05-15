import { inject } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { documentDir, join } from '@tauri-apps/api/path';
import { isIOS } from '../lib/platform';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceStore } from '../stores/workspace';
import { useSettingsStore } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import { useRecentEditsStore } from '../stores/recentEdits';
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
  const recentEdits = useRecentEditsStore();

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

  async function openPath(path: string, opts: { bypassNewWindow?: boolean } = {}) {
    // Spawn a new Tauri window with the path in the query string when the
    // user has opted in. Only applies when the current window already has
    // at least one tab (fresh-launch first file should stay in this window).
    if (
      settings.openFileInNewWindow &&
      !opts.bypassNewWindow &&
      tabs.tabs.length > 0
    ) {
      try {
        const label = `solomd-${Date.now()}`;
        const url = `/?path=${encodeURIComponent(path)}`;
        new WebviewWindow(label, { url, title: 'SoloMD', width: 1000, height: 700 });
        return;
      } catch (e) {
        // Fall back to in-tab open if window creation fails.
        console.warn('new-window open failed, falling back to tab', e);
      }
    }

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
      // Optionally reveal the file in the file-tree sidebar.
      if (settings.revealInFileTreeOnOpen) {
        const parent = path.replace(/[\\/][^\\/]+$/, '');
        if (parent && parent !== path) {
          workspace.setFolder(parent);
          if (!settings.showFileTree) settings.toggleFileTree();
        }
      }
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
    // Open the OS folder picker rooted at the previously chosen workspace
    // so the user lands in a familiar tree, not at $HOME or wherever the
    // OS defaults. Without `defaultPath` Tauri's picker re-opens at the
    // OS-level last-used directory, which is unrelated to SoloMD state
    // and surprised users with a "why isn't my last folder remembered"
    // bug. We persist `currentFolder` already; this just feeds it back.
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: workspace.currentFolder ?? undefined,
    });
    if (!selected || typeof selected !== 'string') return;
    workspace.setFolder(selected);
    if (!settings.showFileTree) settings.toggleFileTree();
  }

  // iOS save policy: ignore the in-place path (could be a security-scoped
  // URL from a "Open With" deep-link — unwritable from plain Rust fs) and
  // route everything through the app's own Documents directory. With
  // UIFileSharingEnabled set, that folder appears as "On My iPhone › SoloMD"
  // in the Files app, so users can iCloud-sync or move from there.
  async function iosResolvePath(tab: Tab): Promise<string> {
    const fname = tab.fileName || (tab.language === 'markdown' ? 'Untitled.md' : 'Untitled.txt');
    const dir = await documentDir();
    return await join(dir, fname);
  }

  async function saveTab(tab: Tab): Promise<boolean> {
    let path = tab.filePath;
    if (isIOS()) {
      // On iOS, never trust the existing path — it may have come from a
      // deep-link "Open With" and not be writable from Rust fs. Always
      // route to Documents.
      path = await iosResolvePath(tab);
    } else if (!path) {
      return saveTabAs(tab);
    }
    try {
      // Restore the file's original line endings on write — we
      // normalize CRLF→LF on open so CodeMirror behaves, but the user
      // expects a Windows-saved file to stay Windows-saved.
      const payload =
        tab.lineEnding === 'crlf' ? tab.content.replace(/\n/g, '\r\n') : tab.content;
      await invoke('write_file', {
        path,
        content: payload,
        encoding: tab.encoding || 'UTF-8',
      });
      tabs.markSaved(tab.id, path);
      workspace.pushRecent(path);
      // v2.5: feed the ⌘P quick-switcher's MFU ranking.
      recentEdits.recordEdit(path);
      // v2.2: notify the AutoGit composable so the debounced auto-commit
      // pipeline picks up this save. Listener is in `useAutoCommit.ts`.
      window.dispatchEvent(
        new CustomEvent('solomd:saved', { detail: { filePath: path } }),
      );
      if (isIOS()) {
        const fname = path.split(/[\\/]/).pop() ?? path;
        toasts.success(`Saved to On My iPhone › SoloMD › ${fname}`);
      } else {
        toasts.success(`Saved ${tab.fileName}`);
      }
      return true;
    } catch (e) {
      console.error('save failed', e);
      toasts.error(`Failed to save: ${e}`);
      return false;
    }
  }

  async function saveTabAs(tab: Tab): Promise<boolean> {
    const defaultName = tab.fileName || (tab.language === 'markdown' ? 'Untitled.md' : 'Untitled.txt');
    let path: string | null;
    if (isIOS()) {
      // iOS: no Save-As picker UI that round-trips to Rust safely. Write
      // straight to app Documents; user surfaces / moves via Files app.
      path = await iosResolvePath(tab);
    } else {
      path = await saveDialog({
        defaultPath: tab.filePath ?? defaultName,
        filters: SAVE_FILTERS,
      });
      if (!path) return false;
    }
    try {
      const payload =
        tab.lineEnding === 'crlf' ? tab.content.replace(/\n/g, '\r\n') : tab.content;
      await invoke('write_file', {
        path,
        content: payload,
        encoding: tab.encoding || 'UTF-8',
      });
      tabs.markSaved(tab.id, path);
      workspace.pushRecent(path);
      // v2.5: feed the ⌘P quick-switcher's MFU ranking.
      recentEdits.recordEdit(path);
      window.dispatchEvent(
        new CustomEvent('solomd:saved', { detail: { filePath: path } }),
      );
      const fileName = path.split(/[\\/]/).pop() ?? path;
      toasts.success(isIOS() ? `Saved to On My iPhone › SoloMD › ${fileName}` : `Saved as ${fileName}`);
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
  // Pass `null` default so Vue doesn't emit "injection not found" warnings
  // when useFiles() is called before App.vue's provide() runs (e.g. inside
  // App.vue's own setup). The real dialog is always available via the
  // window global fallback below.
  const injectedDialog = inject<UnsavedDialog | null>('showUnsavedDialog', null);

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
