import { watch, onMounted, onBeforeUnmount } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useTabsStore } from '../stores/tabs';
import { useSettingsStore } from '../stores/settings';
import type { FileReadResult } from '../types';

type FileChangedAction = 'reload' | 'overwrite' | 'cancel';
type ShowDialog = (fileName: string) => Promise<FileChangedAction>;

export function useFileWatcher(showDialog: ShowDialog) {
  const tabs = useTabsStore();
  const settings = useSettingsStore();
  const watchedPaths = new Set<string>();
  let unlisten: UnlistenFn | null = null;
  const pendingPaths = new Set<string>();

  async function syncWatchedPaths() {
    const currentPaths = new Set<string>();
    for (const tab of tabs.tabs) {
      if (tab.filePath) {
        currentPaths.add(tab.filePath);
      }
    }

    const toWatch = [...currentPaths].filter((p) => !watchedPaths.has(p));
    const toUnwatch = [...watchedPaths].filter((p) => !currentPaths.has(p));

    for (const path of toWatch) {
      try {
        await invoke('watch_file', { path });
        watchedPaths.add(path);
      } catch (e) {
        console.warn('watch_file failed:', e);
      }
    }

    for (const path of toUnwatch) {
      try {
        await invoke('unwatch_file', { path });
      } catch (e) {
        console.warn('unwatch_file failed:', e);
      }
      watchedPaths.delete(path);
    }
  }

  async function reloadTab(tabId: string, filePath: string) {
    const result = await invoke<FileReadResult>('read_file', { path: filePath });
    tabs.setContent(tabId, result.content);
    const tab = tabs.tabs.find((t) => t.id === tabId);
    if (tab) {
      tab.encoding = result.encoding;
      tab.hadBom = result.had_bom;
      tab.savedContent = result.content;
    }
  }

  async function handleFileChanged(filePath: string) {
    const matching = tabs.tabs.filter((t) => t.filePath === filePath);
    if (matching.length === 0) return;

    // If a dialog is already pending for this path, skip
    if (pendingPaths.has(filePath)) return;

    const isPreview = settings.viewMode === 'preview';

    for (const tab of matching) {
      const isDirty = tab.content !== tab.savedContent;

      if (!isDirty || isPreview) {
        try {
          await reloadTab(tab.id, filePath);
        } catch (e) {
          console.warn('reload failed:', e);
        }
        continue;
      }

      // Dirty tab in edit/split mode — show dialog
      pendingPaths.add(filePath);
      try {
        const action = await showDialog(tab.fileName);
        if (action === 'reload') {
          await reloadTab(tab.id, filePath);
        } else if (action === 'overwrite') {
          await invoke('write_file', {
            path: tab.filePath,
            content: tab.content,
            encoding: tab.encoding || 'UTF-8',
          });
          tabs.markSaved(tab.id, tab.filePath!);
        }
      } catch (e) {
        console.warn('file-changed dialog action failed:', e);
      } finally {
        pendingPaths.delete(filePath);
      }
    }
  }

  // Watch tabs for path changes
  const stopWatcher = watch(
    () => tabs.tabs.map((t) => t.filePath).join('|'),
    () => syncWatchedPaths(),
  );

  onMounted(async () => {
    await syncWatchedPaths();

    try {
      unlisten = await listen<string>('solomd://file-changed', (e) => {
        if (e.payload) handleFileChanged(e.payload);
      });
    } catch (e) {
      console.warn('file-changed listener failed:', e);
    }
  });

  onBeforeUnmount(async () => {
    stopWatcher();
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    for (const path of watchedPaths) {
      try {
        await invoke('unwatch_file', { path });
      } catch {}
    }
    watchedPaths.clear();
  });
}
