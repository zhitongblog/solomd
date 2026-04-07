import { defineStore } from 'pinia';
import type { Language, Tab } from '../types';

let nextId = 1;
const newId = () => `tab-${Date.now()}-${nextId++}`;

function inferLanguage(name: string): Language {
  const lower = name.toLowerCase();
  if (/\.(md|markdown|mdown|mkd)$/.test(lower)) return 'markdown';
  return 'plaintext';
}

export const useTabsStore = defineStore('tabs', {
  state: () => ({
    tabs: [] as Tab[],
    activeId: '' as string,
  }),
  getters: {
    activeTab(state): Tab | undefined {
      return state.tabs.find((t) => t.id === state.activeId);
    },
    isDirty(): (id: string) => boolean {
      return (id: string) => {
        const t = this.tabs.find((x) => x.id === id);
        return !!t && t.content !== t.savedContent;
      };
    },
  },
  actions: {
    newTab(opts?: { fileName?: string; language?: Language }) {
      const fileName = opts?.fileName ?? 'Untitled.md';
      const language = opts?.language ?? inferLanguage(fileName);
      const tab: Tab = {
        id: newId(),
        fileName,
        content: '',
        savedContent: '',
        encoding: 'UTF-8',
        language,
        hadBom: false,
      };
      this.tabs.push(tab);
      this.activeId = tab.id;
      return tab;
    },
    openFromDisk(payload: {
      filePath: string;
      content: string;
      encoding: string;
      language: Language;
      hadBom: boolean;
    }) {
      // If already open, just focus.
      const existing = this.tabs.find((t) => t.filePath === payload.filePath);
      if (existing) {
        this.activeId = existing.id;
        return existing;
      }
      const fileName = payload.filePath.split(/[\\/]/).pop() ?? 'Untitled';
      const tab: Tab = {
        id: newId(),
        filePath: payload.filePath,
        fileName,
        content: payload.content,
        savedContent: payload.content,
        encoding: payload.encoding,
        language: payload.language,
        hadBom: payload.hadBom,
      };
      this.tabs.push(tab);
      this.activeId = tab.id;
      return tab;
    },
    setContent(id: string, content: string) {
      const t = this.tabs.find((x) => x.id === id);
      if (t) t.content = content;
    },
    markSaved(id: string, filePath: string) {
      const t = this.tabs.find((x) => x.id === id);
      if (!t) return;
      t.filePath = filePath;
      t.fileName = filePath.split(/[\\/]/).pop() ?? t.fileName;
      t.savedContent = t.content;
      t.language = inferLanguage(t.fileName);
    },
    closeTab(id: string) {
      const idx = this.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      this.tabs.splice(idx, 1);
      if (this.activeId === id) {
        this.activeId = this.tabs[idx]?.id ?? this.tabs[idx - 1]?.id ?? '';
      }
      if (this.tabs.length === 0) this.newTab();
    },
    activate(id: string) {
      this.activeId = id;
    },
  },
});
