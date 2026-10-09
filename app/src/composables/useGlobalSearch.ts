import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../stores/workspace';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';
import { fromSafPath, isSafPath, safList, safRead } from '../lib/saf-fs';
import { searchSafTree } from '../lib/saf-search';

export interface SearchHit {
  file: string;
  line: number;
  snippet: string;
}

export function useGlobalSearch() {
  const workspace = useWorkspaceStore();
  const toasts = useToastsStore();
  const { t } = useI18n();

  async function search(query: string, root?: string, maxResults = 200): Promise<SearchHit[]> {
    const folder = root ?? workspace.currentFolder;
    if (!folder) {
      toasts.warning('Open a folder first to enable global search');
      return [];
    }
    if (!query.trim()) return [];
    try {
      // Android SAF folder: no real path for the Rust walker to read.
      if (isSafPath(folder) && workspace.safTreeUri) {
        const tree = workspace.safTreeUri;
        return await searchSafTree(
          folder,
          query,
          maxResults,
          (dir) => safList(tree, fromSafPath(dir)),
          async (file) => (await safRead(tree, fromSafPath(file))).content,
        );
      }
      const hits = await invoke<SearchHit[]>('search_in_dir', {
        root: folder,
        query,
        maxResults,
      });
      return hits;
    } catch (e) {
      toasts.error(t('toast.searchFailed', { error: String(e) }));
      return [];
    }
  }

  return { search };
}
