import { defineStore } from 'pinia';
import type { Theme, ViewMode } from '../types';

const LS_KEY = 'solomd.settings.v1';

interface Settings {
  theme: Theme;
  viewMode: ViewMode;
  fontSize: number;
  fontFamily: string;
  wordWrap: boolean;
  showLineNumbers: boolean;
  showOutline: boolean;
  showFileTree: boolean;
  livePreview: boolean;
}

function defaults(): Settings {
  const prefersDark =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  return {
    theme: prefersDark ? 'dark' : 'light',
    viewMode: 'edit',
    fontSize: 14,
    fontFamily: '"JetBrains Mono", "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
    wordWrap: true,
    showLineNumbers: true,
    showOutline: false,
    showFileTree: false,
    livePreview: true,
  };
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...defaults(), ...JSON.parse(raw) };
  } catch {}
  return defaults();
}

export const useSettingsStore = defineStore('settings', {
  state: (): Settings => load(),
  actions: {
    persist() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(this.$state));
      } catch {}
    },
    setTheme(theme: Theme) {
      this.theme = theme;
      this.persist();
    },
    toggleTheme() {
      this.setTheme(this.theme === 'light' ? 'dark' : 'light');
    },
    setViewMode(mode: ViewMode) {
      this.viewMode = mode;
      this.persist();
    },
    cycleViewMode() {
      const order: ViewMode[] = ['edit', 'split', 'preview'];
      const i = order.indexOf(this.viewMode);
      this.setViewMode(order[(i + 1) % order.length]);
    },
    setFontSize(n: number) {
      this.fontSize = Math.max(10, Math.min(28, n));
      this.persist();
    },
    setFontFamily(f: string) {
      this.fontFamily = f;
      this.persist();
    },
    toggleWordWrap() {
      this.wordWrap = !this.wordWrap;
      this.persist();
    },
    toggleLineNumbers() {
      this.showLineNumbers = !this.showLineNumbers;
      this.persist();
    },
    toggleOutline() {
      this.showOutline = !this.showOutline;
      this.persist();
    },
    toggleFileTree() {
      this.showFileTree = !this.showFileTree;
      this.persist();
    },
    toggleLivePreview() {
      this.livePreview = !this.livePreview;
      this.persist();
    },
  },
});
