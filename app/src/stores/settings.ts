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
  // Restore previously-open tabs + pane layout at startup (default: true).
  restoreSession: boolean;
  // Opening a file from the toolbar/menu spawns a new Tauri window instead
  // of a new tab in the current window. Default off.
  openFileInNewWindow: boolean;
  // After opening a file, point the file tree sidebar at its parent folder
  // (and reveal the sidebar if hidden). Default off.
  revealInFileTreeOnOpen: boolean;
  // First-launch welcome tour: opened automatically once. Don't reopen.
  welcomeShown: boolean;
  // v2.0 F1: show the Backlinks panel (right of editor) for markdown docs.
  showBacklinks: boolean;
  // v2.0 F2: CodeMirror Hunspell spell-check (separate from browser-native `spellCheck` above).
  spellcheckEnabled: boolean;
  // v2.0 F3: daily notes
  dailyNotesFolder: string;
  dailyNotesFormat: string;
  dailyNotesTemplate: string;
  showTagsPanel: boolean;
  // v2.0 F4: BYOK AI rewrite. `aiProvider` is a stable id from
  // ai-providers.ts PROVIDERS — widened to string to avoid breaking when
  // new providers land.
  aiEnabled: boolean;
  aiProvider: string;
  aiModel: string;
  aiBaseUrl: string;
  // v2.0 F5: Pandoc + citations
  workspaceBibliography: string;
  workspaceCsl: string;
  // v2.2: AutoGit per-note version history
  autoGitEnabled: boolean;
  autoGitDebounceSeconds: number;
  showHistoryPanel: boolean;
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
    restoreSession: true,
    openFileInNewWindow: false,
    revealInFileTreeOnOpen: false,
    welcomeShown: false,
    showBacklinks: true,
    spellcheckEnabled: false,
    dailyNotesFolder: 'Daily',
    dailyNotesFormat: 'YYYY-MM-DD.md',
    dailyNotesTemplate: '',
    showTagsPanel: true,
    aiEnabled: false,
    aiProvider: 'openai',
    aiModel: '',
    aiBaseUrl: '',
    workspaceBibliography: '',
    workspaceCsl: '',
    autoGitEnabled: false,
    autoGitDebounceSeconds: 30,
    showHistoryPanel: false,
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
    toggleRestoreSession() {
      this.restoreSession = !this.restoreSession;
      this.persist();
    },
    toggleOpenFileInNewWindow() {
      this.openFileInNewWindow = !this.openFileInNewWindow;
      this.persist();
    },
    toggleRevealInFileTreeOnOpen() {
      this.revealInFileTreeOnOpen = !this.revealInFileTreeOnOpen;
      this.persist();
    },
    markWelcomeShown() {
      this.welcomeShown = true;
      this.persist();
    },
    toggleBacklinks() {
      this.showBacklinks = !this.showBacklinks;
      this.persist();
    },
    toggleSpellcheckEnabled() {
      this.spellcheckEnabled = !this.spellcheckEnabled;
      this.persist();
    },
    toggleTagsPanel() {
      this.showTagsPanel = !this.showTagsPanel;
      this.persist();
    },
    setDailyNotesFolder(p: string) {
      this.dailyNotesFolder = p;
      this.persist();
    },
    setDailyNotesFormat(f: string) {
      this.dailyNotesFormat = f;
      this.persist();
    },
    setDailyNotesTemplate(t: string) {
      this.dailyNotesTemplate = t;
      this.persist();
    },
    toggleAiEnabled() {
      this.aiEnabled = !this.aiEnabled;
      this.persist();
    },
    setAiProvider(p: string) {
      this.aiProvider = p;
      this.persist();
    },
    setAiModel(m: string) {
      this.aiModel = m;
      this.persist();
    },
    setAiBaseUrl(u: string) {
      this.aiBaseUrl = u;
      this.persist();
    },
    setWorkspaceBibliography(p: string) {
      this.workspaceBibliography = p;
      this.persist();
    },
    setWorkspaceCsl(p: string) {
      this.workspaceCsl = p;
      this.persist();
    },
    toggleAutoGit() {
      this.autoGitEnabled = !this.autoGitEnabled;
      // Surface the history panel together with AutoGit — the v2.2 launch
      // had two separate toggles and users who only flipped AutoGit on
      // saw nothing visible (commits piled up in .git/ but the panel
      // stayed hidden). Turning AutoGit *off* doesn't auto-hide the
      // panel; the user might still want to inspect existing history.
      if (this.autoGitEnabled) {
        this.showHistoryPanel = true;
      }
      this.persist();
    },
    toggleHistoryPanel() {
      this.showHistoryPanel = !this.showHistoryPanel;
      this.persist();
    },
    setAutoGitDebounceSeconds(n: number) {
      this.autoGitDebounceSeconds = Math.max(5, Math.min(600, Math.round(n) || 30));
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
