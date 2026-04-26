import { defineStore } from 'pinia';
import type { Theme, ViewMode } from '../types';
import { isIOS } from '../lib/platform';

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
  // v2.3: Local RAG / semantic search. Off by default — when on, the
  // workspace is scanned + embedded into <workspace>/.solomd/embeddings.sqlite.
  ragEnabled: boolean;
  // v2.4: when on, opening any tab on iPad / iPhone snaps view mode to
  // `reading` (no editor chrome — just the rendered prose). Defaults to
  // `true` on iOS, `false` everywhere else. Esc / Cmd+Shift+R still
  // toggles back into edit mode for power users.
  readingByDefaultOnMobile: boolean;
  // v2.4: last view mode the user was in before they entered reading mode.
  // Persisted so Esc / the close-button restores their previous workspace
  // even across reloads. Never set to 'reading' — sentinel only.
  lastNonReadingViewMode: ViewMode;
  // v2.5: writing stats — show the per-doc word/char goal pill in the
  // status bar. Off-by-default-ish: the pill stays inert unless the doc's
  // YAML front matter sets a `goal:` key, so this toggle is a hard kill
  // switch for the whole feature rather than a daily-use opt-in.
  showWritingStats: boolean;
  // v2.5: optional "Today: 1,200 words across 3 docs" bauble in the bottom
  // right of the status bar. Stretch goal — defaults off because most users
  // care about per-doc progress, not workspace-wide.
  showWorkspaceDailyTotal: boolean;
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
    ragEnabled: false,
    readingByDefaultOnMobile: (() => {
      try {
        return isIOS();
      } catch {
        return false;
      }
    })(),
    lastNonReadingViewMode: 'edit',
    showWritingStats: true,
    showWorkspaceDailyTotal: false,
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
      // Remember whatever non-reading mode we were in before — the
      // reading-mode close button / Esc handler restores it.
      if (mode !== 'reading' && this.viewMode !== 'reading') {
        this.lastNonReadingViewMode = mode;
      } else if (mode !== 'reading') {
        this.lastNonReadingViewMode = mode;
      }
      this.viewMode = mode;
      this.persist();
    },
    cycleViewMode() {
      // `liveEdit` (v2.3) joins the cycle — order chosen so the WYSIWYG
      // mode lives between split (markup-visible) and preview (rendered).
      // `reading` (v2.4) joins as the 5th cycle target — full-bleed serif
      // preview, last in the cycle so the common edit/split toggle keeps
      // its muscle memory at the top of the rotation.
      const order: ViewMode[] = ['edit', 'split', 'liveEdit', 'preview', 'reading'];
      const i = order.indexOf(this.viewMode);
      this.setViewMode(order[(i + 1) % order.length]);
    },
    /**
     * Toggle reading mode on/off. If the user is currently in reading mode
     * we restore whatever they were in before; otherwise we save the
     * current mode and snap to reading.
     */
    toggleReadingMode() {
      if (this.viewMode === 'reading') {
        this.exitReadingMode();
      } else {
        this.lastNonReadingViewMode = this.viewMode;
        this.viewMode = 'reading';
        this.persist();
      }
    },
    /** Restore the last non-reading view mode (used by Esc / close button). */
    exitReadingMode() {
      // Defensive: never exit *into* reading mode (would loop). Default
      // back to 'edit' if the saved sentinel is somehow 'reading'.
      const next = this.lastNonReadingViewMode === 'reading' ? 'edit' : this.lastNonReadingViewMode;
      this.viewMode = next;
      this.persist();
    },
    toggleReadingByDefaultOnMobile() {
      this.readingByDefaultOnMobile = !this.readingByDefaultOnMobile;
      this.persist();
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
      // Tie panel visibility to the AutoGit toggle — there's only one
      // user-facing concept ("version history is on / off") and the
      // panel showing matches that mental model.
      this.showHistoryPanel = this.autoGitEnabled;
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
    toggleRagEnabled() {
      this.ragEnabled = !this.ragEnabled;
      this.persist();
    },
    toggleWritingStats() {
      this.showWritingStats = !this.showWritingStats;
      this.persist();
    },
    toggleWorkspaceDailyTotal() {
      this.showWorkspaceDailyTotal = !this.showWorkspaceDailyTotal;
      this.persist();
    },
  },
});
