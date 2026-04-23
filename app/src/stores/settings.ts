import { defineStore } from 'pinia';
import type { Theme, ViewMode } from '../types';

const LS_KEY = 'solomd.settings.v1';

// CJK + generic fallback appended after the user's chosen face. This way
// Latin glyphs come from the user's pick while CJK still falls back to
// a real CJK font instead of whatever the generic `monospace` happens to be.
const CJK_FALLBACK =
  '"PingFang SC", "PingFang TC", "Hiragino Sans GB", "Microsoft YaHei", "Heiti SC", "Noto Sans CJK SC"';

export function buildEditorFontStack(face: string): string {
  const trimmed = face.trim();
  if (!trimmed) return `${CJK_FALLBACK}, sans-serif`;
  // If user pasted a full stack already (contains comma), use as-is but still
  // append CJK fallback for safety.
  if (trimmed.includes(',')) return `${trimmed}, ${CJK_FALLBACK}`;
  const needsQuote = /\s/.test(trimmed) && !/^["']/.test(trimmed);
  const quoted = needsQuote ? `"${trimmed}"` : trimmed;
  return `${quoted}, ${CJK_FALLBACK}, "JetBrains Mono", Menlo, Consolas, monospace`;
}

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
  // Editor super features
  spellCheck: boolean;
  focusMode: boolean;
  typewriterMode: boolean;
  vimMode: boolean;
  uiFontSize: number;
  language: 'en' | 'zh';
  autoCheckUpdate: boolean;
  // Preview layout
  previewFitWidth: boolean;
  // Custom CSS theme override (path to a .css file on disk)
  customCssPath: string;
  // Anonymous telemetry (Aptabase). Defaults true but user can opt out.
  telemetryEnabled: boolean;
  // First-run banner dismissal. Shown once, never again.
  telemetryNoticeAck: boolean;
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
    fontFamily: 'JetBrains Mono',
    wordWrap: true,
    showLineNumbers: true,
    showOutline: false,
    showFileTree: false,
    livePreview: true,
    spellCheck: true,
    focusMode: false,
    typewriterMode: false,
    vimMode: false,
    uiFontSize: 13,
    autoCheckUpdate: true,
    language: (() => {
      // Detect browser language on first run (zh-CN, zh-TW, etc. → 'zh')
      try {
        const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
        return /^zh/i.test(nav) ? 'zh' : 'en';
      } catch { return 'en'; }
    })() as 'en' | 'zh',
    previewFitWidth: false,
    customCssPath: '',
    telemetryEnabled: true,
    telemetryNoticeAck: false,
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
    toggleSpellCheck() {
      this.spellCheck = !this.spellCheck;
      this.persist();
    },
    toggleFocusMode() {
      this.focusMode = !this.focusMode;
      this.persist();
    },
    toggleTypewriterMode() {
      this.typewriterMode = !this.typewriterMode;
      this.persist();
    },
    toggleVimMode() {
      this.vimMode = !this.vimMode;
      this.persist();
    },
    toggleAutoCheckUpdate() {
      this.autoCheckUpdate = !this.autoCheckUpdate;
      this.persist();
    },
    toggleTelemetry() {
      this.telemetryEnabled = !this.telemetryEnabled;
      this.persist();
    },
    ackTelemetryNotice() {
      this.telemetryNoticeAck = true;
      this.persist();
    },
    setUiFontSize(n: number) {
      this.uiFontSize = Math.max(10, Math.min(20, n));
      this.persist();
    },
    setLanguage(lang: 'en' | 'zh') {
      this.language = lang;
      this.persist();
    },
    setCustomCssPath(p: string) {
      this.customCssPath = p;
      this.persist();
    },
    togglePreviewFitWidth() {
      this.previewFitWidth = !this.previewFitWidth;
      this.persist();
    },
  },
});
