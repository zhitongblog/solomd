/**
 * Every `- [ ]` in the workspace, as one list.
 *
 * The Rust index already walks the vault and keeps itself current through a
 * file watcher, so this is a projection over `workspaceIndex.entries` rather
 * than a second scan: opening the panel costs nothing, and a task edited in the
 * editor shows up here without anything being told to refresh.
 */
import { computed } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';
import { useTabsStore } from '../stores/tabs';
import { useToastsStore } from '../stores/toasts';
import { useFiles } from './useFiles';
import { parseTaskMeta, compareTasks, toggleTaskLine, type TaskMeta } from '../lib/tasks';
import type { FileReadResult } from '../types';

export interface WorkspaceTask {
  path: string;
  fileName: string;
  /** 1-based line in the file. */
  line: number;
  done: boolean;
  /** The task text as written, tokens included. */
  raw: string;
  meta: TaskMeta;
}

export function useTasks() {
  const idx = useWorkspaceIndexStore();
  const tabs = useTabsStore();
  const toasts = useToastsStore();
  const files = useFiles();

  const tasks = computed<WorkspaceTask[]>(() => {
    const out: WorkspaceTask[] = [];
    for (const entry of idx.entries) {
      for (const t of entry.tasks ?? []) {
        out.push({
          path: entry.path,
          fileName: entry.name,
          line: t.line,
          done: t.done,
          raw: t.text,
          meta: parseTaskMeta(t.text),
        });
      }
    }
    return out.sort(compareTasks);
  });

  /**
   * Tick / untick a task and persist it.
   *
   * When the file is open in a tab, the toggle has to go through the tab's
   * copy: writing the file directly would be overwritten the moment that tab
   * saves. The tab is then saved, because clicking a checkbox is an explicit
   * act — leaving it dirty would show the panel (which reads the index, i.e.
   * disk) disagreeing with what the user just clicked.
   */
  async function toggle(task: WorkspaceTask): Promise<void> {
    const openTab = tabs.tabs.find((t) => t.filePath === task.path);
    try {
      if (openTab) {
        const next = toggleTaskLine(openTab.content ?? '', task.line);
        if (next === null) {
          toasts.warning('That line is no longer a task — reopen the note.');
          return;
        }
        tabs.setContent(openTab.id, next);
        await files.saveTab(openTab, { silent: true });
        return;
      }
      const read = await invoke<FileReadResult>('read_file', { path: task.path });
      const next = toggleTaskLine(read.content, task.line);
      if (next === null) {
        // The index is behind the file. Refusing to write is the whole point:
        // rewriting whatever now sits on that line would corrupt the note.
        toasts.warning('That line is no longer a task — the note changed.');
        return;
      }
      await invoke('write_file', {
        path: task.path,
        content: next,
        encoding: read.encoding || 'UTF-8',
      });
      window.dispatchEvent(
        new CustomEvent('solomd:saved', { detail: { filePath: task.path } }),
      );
    } catch (e) {
      toasts.error(`Could not update the task: ${e}`);
    }
  }

  return { tasks, toggle };
}
