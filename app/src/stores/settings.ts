import { defineStore } from 'pinia';
import type { Theme, ViewMode } from '../types';
import { isIOS, isMobile } from '../lib/platform';

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
  // #87(3) — if set, this view mode is forced on every launch, overriding
  // the persisted last-used `viewMode`. `null` (default) keeps the existing
  // behavior of resuming whatever mode the user left in.
  startupViewMode: ViewMode | null;
  fontSize: number;
  fontFamily: string;
  wordWrap: boolean;
  showLineNumbers: boolean;
  showOutline: boolean;
  outlineSide: 'left' | 'right';
  showFileTree: boolean;
  /** v4.3.x release marker: set on first launch after the default flipped
   *  from `false` → `true` (desktop). If absent on load, `load()` force-enables
   *  `showFileTree` once for desktop users so the flip actually reaches the
   *  existing install base; mobile is left alone (file tree on a phone would
   *  crowd the editor). After the migration the user is free to toggle it
   *  off via the toolbar / ⌘B / command palette and the choice persists. */
  fileTreeDefaultDesktopMigrated: boolean;
  /** Master toggle that hides the right side sidebar (Outline / Backlinks /
   *  Tags / History / Agent Panel) without forgetting which individual panes
   *  the user had on. Default false (= sidebar visible whenever any pane is
   *  enabled, i.e. legacy behavior). Set true via the toolbar close button,
   *  the ⌥⌘B shortcut, or the command palette to hide it; toggling again
   *  restores all previously-enabled panes in their previous state. */
  rightSidebarHidden: boolean;
  livePreview: boolean;
  // Editor super features
  spellCheck: boolean;
  focusMode: boolean;
  typewriterMode: boolean;
  vimMode: boolean;
  uiFontSize: number;
  language: 'en' | 'zh' | 'ja' | 'ko' | 'de' | 'fr' | 'es' | 'pt' | 'it' | 'pl' | 'nl' | 'tr' | 'sv' | 'uk';
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
  // Scope open tabs to the active workspace folder (default: true). Each
  // folder remembers its own tabs, so opening folder A never resurfaces
  // folder B's accumulated tabs, and multiple windows on different folders
  // don't clobber one shared tab blob. Unsaved + untitled tabs always follow
  // the user across workspaces so no in-progress work is lost.
  perWorkspaceTabs: boolean;
  // When a file watched by SoloMD is modified by another program (other
  // editor, git checkout, sync client), reload the buffer automatically
  // if the tab has no unsaved changes. Default on. Dirty tabs always
  // show the reload/overwrite/cancel dialog regardless of this setting —
  // we never silently throw away the user's in-progress edits.
  autoReloadExternalChanges: boolean;
  // When the app window loses focus (user switches to another app/window),
  // silently save every dirty tab that's already backed by a file. Untitled
  // tabs are skipped — they'd otherwise pop a Save-As dialog on blur. Default
  // off so the explicit-⌘S mental model stays the default.
  autoSaveOnBlur: boolean;
  // Opening a file from the toolbar/menu spawns a new Tauri window instead
  // of a new tab in the current window. Default off.
  openFileInNewWindow: boolean;
  // After opening a file, point the file tree sidebar at its parent folder
  // (and reveal the sidebar if hidden). Default off.
  revealInFileTreeOnOpen: boolean;
  // First-launch welcome tour: opened automatically once. Don't reopen.
  welcomeShown: boolean;
  // v4.0 first-run agent setup wizard. Shown once after the welcome tour to
  // route the user into BYOK or Ollama. Re-openable from Settings → AI.
  agentWizardSeen: boolean;
  // v2.0 F1: show the Backlinks panel (right of editor) for markdown docs.
  showBacklinks: boolean;
  // v2.0 F2: CodeMirror Hunspell spell-check (separate from browser-native `spellCheck` above).
  spellcheckEnabled: boolean;
  // v2.0 F3: daily notes
  dailyNotesFolder: string;
  dailyNotesFormat: string;
  dailyNotesTemplate: string;
  showTagsPanel: boolean;
  // v4.0 pillar 1: Inline Agent Panel — chat-with-vault sidebar.
  showAgentPanel: boolean;
  // v4.0 release migration marker: set on first launch after upgrading
  // to v4.0. If absent or false, `load()` force-enables `showAgentPanel`
  // once so users coming from v3.6.x or any v4-beta build (where the
  // default was false) actually see the marquee feature instead of an
  // unchanged sidebar. After the migration the user is free to toggle
  // it off via the command palette and the choice sticks.
  v4AgentPanelMigrated: boolean;
  // v4.0 pillar 1: when true, the agent can call write_note / append_to_note
  // from chat. Default off — the agent is read-only by default.
  agentAllowWrite: boolean;
  // v4.0 pillar 1: max number of LLM ↔ tool round-trips per chat turn.
  // Cap protects against a runaway tool loop. C3.2 default is 8.
  agentToolLoopCap: number;
  // Width (in px) of the right/left side sidebar that hosts Outline /
  // Backlinks / Tags / History / Agent Panel. The agent panel needs more
  // room than read-only browsing; user-resizable via the drag handle.
  sideSidebarWidth: number;
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
  /** Show the History pane in the right sidebar. v4.0.2: decoupled from
   *  autoGitEnabled so users can hide just the panel without disabling git
   *  sync entirely (issue #55 — Agent + History fighting for vertical space
   *  during conflict resolution). Defaults to true so existing AutoGit
   *  users see no behavior change. */
  showHistoryPanel: boolean;
  /** v4.0.2 — per-pane heights in the right sidebar (issue #6 / #52 / #55).
   *  Map of pane id → flex-basis pixels. Panes without an entry use
   *  proportional flex grow (legacy behavior). Once the user drags a
   *  splitter the touched panes get explicit pixel heights. */
  rightSidebarPaneHeights: Record<string, number>;
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
  // v2.5 F2: writing stats — show the per-doc word/char goal pill in the
  // status bar. Off-by-default-ish: the pill stays inert unless the doc's
  // YAML front matter sets a `goal:` key, so this toggle is a hard kill
  // switch for the whole feature rather than a daily-use opt-in.
  showWritingStats: boolean;
  // v2.5 F2: optional "Today: 1,200 words across 3 docs" bauble in the bottom
  // right of the status bar. Stretch goal — defaults off because most users
  // care about per-doc progress, not workspace-wide.
  showWorkspaceDailyTotal: boolean;
  // v2.5 F3: PDF / print export defaults. When a field is the empty string
  // / `null` we fall back to whatever the webview / jsPDF chose (i.e. the
  // pre-v2.5 behavior). YAML front matter `pdf:` block on a doc overrides
  // these per-document.
  pdfDefaults: PdfDefaults;
  // v2.5 F4: Pomodoro / focus session timer.
  pomodoroShowControls: boolean;
  pomodoroAutoEngageFocus: boolean;
  pomodoroDefaultMinutes: 25 | 50 | 90 | number;
  // v2.5 F7: Affine/Notion-style "/" slash command popup in the markdown
  // editor. Default ON — can be turned off for users who don't like
  // the keyboard interception.
  slashCommandsEnabled: boolean;
  // v3.6: PNG export — show "Created with SoloMD · solomd.app" footer
  // under the rendered note. Default ON (mild self-promotion is fine
  // for a free MIT app), but explicitly toggleable in Settings → Export
  // for users who don't want the watermark on screenshots they share.
  imageExportBranding: boolean;
  // v4.3.0: global UI zoom (scales the entire app — editor, preview, chrome,
  // sidebars, modals). Helpful on high-DPI screens where everything renders
  // too small even at the OS default scale. Range 0.75x – 2.5x. Wired via
  // `document.documentElement.style.zoom`, which Chromium / WebKit / wry all
  // support. Bound to ⌘=, ⌘-, ⌘0 shortcuts. Issue #72.
  globalZoom: number;
  // v4.3.0: show line numbers next to each line of code in the rendered
  // preview (and Pandoc/PDF/PNG exports — they all share the preview HTML).
  // Default off so existing exports don't surprise anyone. Issue #65.
  codeBlockLineNumbers: boolean;
  // v4.3.0: user-customisable order of the right-sidebar panes. Each entry
  // is a pane id (search / outline / backlinks / tags / history / agent).
  // Default matches the pre-v4.3.0 hardcoded order. Panes not in the list
  // (newly added in a future release) get appended to the end so the user's
  // saved layout isn't blown away by a SoloMD update. Issue #57b.
  rsPaneOrder: string[];
  // v4.3.0: preview-pane font size (px). Decoupled from editor `fontSize`
  // so users can tune editor density and preview readability separately
  // (PR #74 — yzcj105). Bound to ⌃⌘+/⌃⌘-/⌃⌘0; the editor axis (existing
  // `fontSize`) is bound to ⌘⇧+/⌘⇧-/⌘⇧0. Range 10–32.
  previewFontSize: number;
  /** v4.3.5 — where to write images pasted/dropped into the editor.
   *  - `shared` (default): one `_assets/` folder per directory. All notes in
   *    that dir share it. Matches pre-v4.3.5 behavior; safe for legacy vaults.
   *  - `per-file`: each note gets its own `<basename>.assets/` folder next to
   *    the .md. Moving / renaming the note moves the folder with it
   *    (handled in `fs_rename` on the Rust side, which also rewrites
   *    `<oldStem>.assets/...` link refs inside the file body when the stem
   *    changes). Better when notes get reshuffled often; clutters the file
   *    tree if every note has images. Issue: user feedback 2026-05-26.
   */
  attachmentMode: 'shared' | 'per-file' | 'custom';
  // #7 (顾河) — Typora-style custom path template for `custom` attachment mode.
  // Supports `${filename}` (the note's name without extension). Relative
  // templates (`./images/${filename}/`, `assets/`) resolve against the note's
  // folder; an absolute path is used as-is. Default mirrors Typora's default.
  attachmentCustomPath: string;
  // #88 — folder name for `shared` attachment mode (default `_assets`). Used
  // only when attachmentMode is 'shared'; per-file mode always uses
  // `<stem>.assets/`. Empty string falls back to `_assets`.
  assetsDirName: string;
  // v4.6 F6 — Inbox workflow. Master opt-out for the whole inbox surface
  // (file-tree row, status-bar pill, dedicated InboxView, ⌘E auto-advance).
  // Default on — mirrors Tolaria's per-vault InboxConfig.explicitOrganization,
  // but stored locally (not in files). When off, ⌘E falls back to the plain
  // `inbox: true|false` toggle and the InboxView / inbox filter are hidden.
  inboxWorkflowEnabled: boolean;
  // v4.6 F6 — when on, marking a note organized (⌘E) inside the inbox context
  // (InboxView open or inbox filter active) auto-advances to the next inbox
  // note. Default on. Matches Tolaria's auto_advance_inbox_after_organize.
  autoAdvanceInboxAfterOrganize: boolean;
  // v4.3.0 PR #75 (beihai23) — transient (not persisted) snapshot of the
  // right-sidebar pane visibility taken when the sidebar is hidden, so
  // toggling it back on can restore the exact previous layout instead of
  // leaving the user with a blank sidebar.
  _rsPanesBeforeHide: {
    showBacklinks: boolean;
    showTagsPanel: boolean;
    showHistoryPanel: boolean;
    showAgentPanel: boolean;
  } | null;
}

/** v2.5 PDF / print export defaults. */
export interface PdfDefaults {
  /** Page size preset (`A4` / `A5` / `Letter` / `Legal`) or `Custom`. */
  pageSize: 'A4' | 'A5' | 'Letter' | 'Legal' | 'Custom';
  /** Custom page width in mm — only consulted when `pageSize === 'Custom'`. */
  customWidthMm: number;
  /** Custom page height in mm — only consulted when `pageSize === 'Custom'`. */
  customHeightMm: number;
  /** Margin preset (`Narrow` 10mm / `Normal` 15mm / `Wide` 25mm / `Custom`). */
  margin: 'Narrow' | 'Normal' | 'Wide' | 'Custom';
  /** Custom margins in mm — only consulted when `margin === 'Custom'`. */
  customMarginTopMm: number;
  customMarginRightMm: number;
  customMarginBottomMm: number;
  customMarginLeftMm: number;
  /** Font family for body text. Empty string = let the PDF stylesheet decide. */
  fontFamily: string;
  /** Font size in pt (9-16). */
  fontSize: number;
  /** When true, append a page-number footer. */
  footer: boolean;
  /** Code-block syntax highlighting in PDF: match preview / always light / always dark. */
  codeTheme: 'preview' | 'light' | 'dark';
}

export function defaultPdfDefaults(): PdfDefaults {
  return {
    pageSize: 'A4',
    customWidthMm: 210,
    customHeightMm: 297,
    margin: 'Normal',
    customMarginTopMm: 15,
    customMarginRightMm: 15,
    customMarginBottomMm: 15,
    customMarginLeftMm: 15,
    fontFamily: '',
    fontSize: 11,
    footer: true,
    codeTheme: 'preview',
  };
}

function defaults(): Settings {
  const prefersDark =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  return {
    theme: prefersDark ? 'dark' : 'light',
    viewMode: 'edit',
    startupViewMode: null,
    fontSize: 14,
    fontFamily: 'JetBrains Mono',
    wordWrap: true,
    showLineNumbers: true,
    showOutline: false,
    outlineSide: 'right',
    showFileTree: !isMobile(),
    // Fresh installs already see the new default — mark migration done so
    // load()'s one-time force-on path is a no-op for them.
    fileTreeDefaultDesktopMigrated: true,
    rightSidebarHidden: false,
    livePreview: true,
    spellCheck: true,
    focusMode: false,
    typewriterMode: false,
    vimMode: false,
    uiFontSize: 13,
    autoCheckUpdate: true,
    language: (() => {
      // Detect browser language on first run. Maps navigator BCP-47 tag
      // to one of the 14 shipped UI locales; everything else → 'en'.
      try {
        const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
        if (/^zh/i.test(nav)) return 'zh';
        if (/^ja/i.test(nav)) return 'ja';
        if (/^ko/i.test(nav)) return 'ko';
        if (/^de/i.test(nav)) return 'de';
        if (/^fr/i.test(nav)) return 'fr';
        if (/^es/i.test(nav)) return 'es';
        if (/^pt/i.test(nav)) return 'pt';
        if (/^it/i.test(nav)) return 'it';
        if (/^pl/i.test(nav)) return 'pl';
        if (/^nl/i.test(nav)) return 'nl';
        if (/^tr/i.test(nav)) return 'tr';
        if (/^sv/i.test(nav)) return 'sv';
        if (/^uk/i.test(nav)) return 'uk';
        return 'en';
      } catch { return 'en'; }
    })() as 'en' | 'zh' | 'ja' | 'ko' | 'de' | 'fr' | 'es' | 'pt' | 'it' | 'pl' | 'nl' | 'tr' | 'sv' | 'uk',
    previewFitWidth: false,
    customCssPath: '',
    telemetryEnabled: true,
    telemetryNoticeAck: false,
    restoreSession: true,
    perWorkspaceTabs: true,
    autoReloadExternalChanges: true,
    autoSaveOnBlur: false,
    openFileInNewWindow: false,
    revealInFileTreeOnOpen: false,
    welcomeShown: false,
    agentWizardSeen: false,
    showBacklinks: true,
    spellcheckEnabled: false,
    dailyNotesFolder: 'Daily',
    dailyNotesFormat: 'YYYY-MM-DD.md',
    dailyNotesTemplate: '',
    showTagsPanel: true,
    showAgentPanel: true,
    // True for fresh installs (defaults are already v4.0). Existing
    // localStorage blobs from v3.6.x / v4-beta won't have this key, so
    // `load()`'s migration kicks in and force-enables the Agent Panel
    // once before setting the marker on disk.
    v4AgentPanelMigrated: true,
    agentAllowWrite: false,
    agentToolLoopCap: 8,
    sideSidebarWidth: 260,
    aiEnabled: false,
    aiProvider: 'openai',
    aiModel: '',
    aiBaseUrl: '',
    workspaceBibliography: '',
    workspaceCsl: '',
    autoGitEnabled: false,
    autoGitDebounceSeconds: 30,
    showHistoryPanel: true,
    rightSidebarPaneHeights: {},
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
    pdfDefaults: defaultPdfDefaults(),
    pomodoroShowControls: true,
    pomodoroAutoEngageFocus: true,
    pomodoroDefaultMinutes: 25,
    slashCommandsEnabled: true,
    imageExportBranding: true,
    globalZoom: 1,
    codeBlockLineNumbers: false,
    rsPaneOrder: ['search', 'outline', 'backlinks', 'tags', 'history', 'agent'],
    previewFontSize: 15,
    attachmentMode: 'shared',
    assetsDirName: '_assets',
    attachmentCustomPath: './images/${filename}/',
    inboxWorkflowEnabled: true,
    autoAdvanceInboxAfterOrganize: true,
    _rsPanesBeforeHide: null,
  };
}

/**
 * Merge a (possibly partial / legacy) saved `pdfDefaults` blob with the
 * current schema defaults. Treats unknown / out-of-range numeric values
 * as "use the default" so a 5MB margin can never sneak in via tampered
 * localStorage.
 */
function mergePdfDefaults(saved: unknown): PdfDefaults {
  const base = defaultPdfDefaults();
  if (!saved || typeof saved !== 'object') return base;
  const s = saved as Partial<PdfDefaults>;
  const clamp = (n: unknown, min: number, max: number, fallback: number) => {
    const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
    return Math.max(min, Math.min(max, v));
  };
  const okPageSize = ['A4', 'A5', 'Letter', 'Legal', 'Custom'] as const;
  const okMargin = ['Narrow', 'Normal', 'Wide', 'Custom'] as const;
  const okCodeTheme = ['preview', 'light', 'dark'] as const;
  return {
    pageSize: okPageSize.includes(s.pageSize as never) ? (s.pageSize as PdfDefaults['pageSize']) : base.pageSize,
    customWidthMm: clamp(s.customWidthMm, 50, 500, base.customWidthMm),
    customHeightMm: clamp(s.customHeightMm, 50, 500, base.customHeightMm),
    margin: okMargin.includes(s.margin as never) ? (s.margin as PdfDefaults['margin']) : base.margin,
    customMarginTopMm: clamp(s.customMarginTopMm, 5, 100, base.customMarginTopMm),
    customMarginRightMm: clamp(s.customMarginRightMm, 5, 100, base.customMarginRightMm),
    customMarginBottomMm: clamp(s.customMarginBottomMm, 5, 100, base.customMarginBottomMm),
    customMarginLeftMm: clamp(s.customMarginLeftMm, 5, 100, base.customMarginLeftMm),
    fontFamily: typeof s.fontFamily === 'string' ? s.fontFamily : base.fontFamily,
    fontSize: clamp(s.fontSize, 9, 16, base.fontSize),
    footer: typeof s.footer === 'boolean' ? s.footer : base.footer,
    codeTheme: okCodeTheme.includes(s.codeTheme as never) ? (s.codeTheme as PdfDefaults['codeTheme']) : base.codeTheme,
  };
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      const merged: Settings = { ...defaults(), ...parsed };
      // pdfDefaults is a nested object: do a clamping merge so a missing
      // sub-key (older settings blob) doesn't yield `undefined` and a
      // tampered numeric stays in range.
      merged.pdfDefaults = mergePdfDefaults(parsed.pdfDefaults);
      // One-time v4.0 upgrade: any saved settings blob written before
      // v4.0 release (or by a v4 beta where the panel defaulted off)
      // will not have the `v4AgentPanelMigrated` marker. Force-enable
      // the Agent Panel once and set the marker; subsequent toggles by
      // the user persist normally.
      if (!parsed.v4AgentPanelMigrated) {
        merged.showAgentPanel = true;
        merged.v4AgentPanelMigrated = true;
      }
      // v4.3.x — file tree default flipped to "on" for desktop. Existing
      // installs (where the saved blob has the key as `false`) get the
      // sidebar opened once on next launch; mobile is skipped so phones
      // keep the editor full-width. Marker prevents re-applying after the
      // user explicitly closes it.
      if (!parsed.fileTreeDefaultDesktopMigrated) {
        if (!isMobile()) merged.showFileTree = true;
        merged.fileTreeDefaultDesktopMigrated = true;
      }
      return merged;
    }
  } catch {}
  return defaults();
}

export const useSettingsStore = defineStore('settings', {
  state: (): Settings => load(),
  actions: {
    persist() {
      try {
        // v4.3.0 PR #75 — drop transient `_rsPanesBeforeHide` from disk;
        // it's only meaningful for the current session.
        const { _rsPanesBeforeHide, ...rest } = this.$state as any;
        void _rsPanesBeforeHide;
        localStorage.setItem(LS_KEY, JSON.stringify(rest));
      } catch {}
    },
    setTheme(theme: Theme) {
      this.theme = theme;
      this.persist();
    },
    toggleTheme() {
      this.setTheme(this.theme === 'light' ? 'dark' : 'light');
    },
    setStartupViewMode(mode: ViewMode | null) {
      this.startupViewMode = mode;
      this.persist();
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
    setOutlineSide(side: 'left' | 'right') {
      this.outlineSide = side;
      this.persist();
    },
    toggleFileTree() {
      this.showFileTree = !this.showFileTree;
      this.persist();
    },
    toggleRightSidebar() {
      // v4.3.0 PR #75 — when hiding, snapshot the current pane visibility so
      // toggling back on can restore the exact layout instead of a blank
      // sidebar; when restoring, ensure at least one pane is on so the
      // sidebar isn't empty.
      if (!this.rightSidebarHidden) {
        this._rsPanesBeforeHide = {
          showBacklinks: this.showBacklinks,
          showTagsPanel: this.showTagsPanel,
          showHistoryPanel: this.showHistoryPanel,
          showAgentPanel: this.showAgentPanel,
        };
        this.rightSidebarHidden = true;
      } else {
        this.rightSidebarHidden = false;
        const saved = this._rsPanesBeforeHide;
        if (saved) {
          this.showBacklinks = saved.showBacklinks;
          this.showTagsPanel = saved.showTagsPanel;
          this.showHistoryPanel = saved.showHistoryPanel;
          this.showAgentPanel = saved.showAgentPanel;
          this._rsPanesBeforeHide = null;
        }
        if (!this.showBacklinks && !this.showTagsPanel && !this.showHistoryPanel && !this.showAgentPanel) {
          this.showBacklinks = true;
          this.showTagsPanel = true;
        }
      }
      this.persist();
    },
    /** v4.3.0 PR #75 — called when the user toggles off the last visible
     *  pane via the right-click context menu; auto-hides the sidebar and
     *  remembers the pre-toggle layout for later restore. */
    hideRightSidebarFromPane(paneBeforeToggle: {
      showBacklinks: boolean;
      showTagsPanel: boolean;
      showHistoryPanel: boolean;
      showAgentPanel: boolean;
    }) {
      this._rsPanesBeforeHide = paneBeforeToggle;
      this.rightSidebarHidden = true;
      this.persist();
    },
    /** v4.3.0 PR #75 — ensure the sidebar is visible (used when toggling a
     *  pane ON from the context menu while the sidebar was auto-hidden). */
    ensureRightSidebarVisible() {
      if (this.rightSidebarHidden) {
        this.rightSidebarHidden = false;
      }
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
    togglePerWorkspaceTabs() {
      this.perWorkspaceTabs = !this.perWorkspaceTabs;
      this.persist();
    },
    toggleAutoReloadExternalChanges() {
      this.autoReloadExternalChanges = !this.autoReloadExternalChanges;
      this.persist();
    },
    toggleAutoSaveOnBlur() {
      this.autoSaveOnBlur = !this.autoSaveOnBlur;
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
    markAgentWizardSeen() {
      this.agentWizardSeen = true;
      this.persist();
    },
    resetAgentWizard() {
      this.agentWizardSeen = false;
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
    toggleAgentPanel() {
      this.showAgentPanel = !this.showAgentPanel;
      this.persist();
    },
    toggleAgentAllowWrite() {
      this.agentAllowWrite = !this.agentAllowWrite;
      this.persist();
    },
    setAgentToolLoopCap(n: number) {
      const clean = Math.max(1, Math.min(20, Math.round(n) || 8));
      this.agentToolLoopCap = clean;
      this.persist();
    },
    setSideSidebarWidth(w: number) {
      // Reasonable bounds — narrower than 220 hides text, wider than 800
      // eats too much editor space.
      const clean = Math.max(220, Math.min(800, Math.round(w) || 260));
      this.sideSidebarWidth = clean;
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
      // v4.0.2: panel visibility decoupled from autoGit (#55) — hiding the
      // pane no longer disables sync. Re-enabling sync surfaces the panel
      // again only if the user hasn't explicitly hidden it.
      if (this.autoGitEnabled && !this.showHistoryPanel) this.showHistoryPanel = true;
      this.persist();
    },
    toggleHistoryPanel() {
      this.showHistoryPanel = !this.showHistoryPanel;
      this.persist();
    },
    setRightSidebarPaneHeight(paneId: string, px: number) {
      const clean = Math.max(80, Math.min(2000, Math.round(px) || 0));
      // Allocate a fresh object so Vue reactivity picks up the mutation
      // (the persist() write would catch it, but watchers keyed on the
      // map need the identity change to fire).
      this.rightSidebarPaneHeights = { ...this.rightSidebarPaneHeights, [paneId]: clean };
      this.persist();
    },
    clearRightSidebarPaneHeights() {
      this.rightSidebarPaneHeights = {};
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
    setLanguage(lang: 'en' | 'zh' | 'ja' | 'ko' | 'de' | 'fr' | 'es' | 'pt' | 'it' | 'pl' | 'nl' | 'tr' | 'sv' | 'uk') {
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
    /**
     * v2.5 F3: shallow-merge a partial `pdfDefaults` patch. Used by the
     * Settings panel so each `<select>`/`<input>` only has to send the one
     * field it changed.
     */
    setPdfDefaults(patch: Partial<PdfDefaults>) {
      this.pdfDefaults = mergePdfDefaults({ ...this.pdfDefaults, ...patch });
      this.persist();
    },
    resetPdfDefaults() {
      this.pdfDefaults = defaultPdfDefaults();
      this.persist();
    },
    togglePomodoroShowControls() {
      this.pomodoroShowControls = !this.pomodoroShowControls;
      this.persist();
    },
    togglePomodoroAutoEngageFocus() {
      this.pomodoroAutoEngageFocus = !this.pomodoroAutoEngageFocus;
      this.persist();
    },
    setPomodoroDefaultMinutes(n: number) {
      const clean = Math.max(1, Math.min(600, Math.round(n) || 25));
      this.pomodoroDefaultMinutes = clean;
      this.persist();
    },
    toggleSlashCommandsEnabled() {
      this.slashCommandsEnabled = !this.slashCommandsEnabled;
      this.persist();
    },
    toggleImageExportBranding() {
      this.imageExportBranding = !this.imageExportBranding;
      this.persist();
    },
    setGlobalZoom(n: number) {
      // Clamp to a sane range: 0.75 (text uncomfortably small) to 2.5 (text
      // huge for accessibility / 8K screens). Round to 0.05 so the slider
      // / shortcuts don't accumulate floating-point drift.
      const clean = Math.max(0.75, Math.min(2.5, Math.round((n || 1) * 20) / 20));
      this.globalZoom = clean;
      this.persist();
    },
    zoomIn() {
      this.setGlobalZoom((this.globalZoom || 1) + 0.1);
    },
    zoomOut() {
      this.setGlobalZoom((this.globalZoom || 1) - 0.1);
    },
    resetZoom() {
      this.setGlobalZoom(1);
    },
    toggleCodeBlockLineNumbers() {
      this.codeBlockLineNumbers = !this.codeBlockLineNumbers;
      this.persist();
    },
    /** v4.3.0 issue #57b — reorder the right sidebar by moving a pane id to
     *  a new index. Tolerates out-of-range targets (clamps), no-ops for
     *  unknown ids. */
    moveRsPane(paneId: string, targetIdx: number) {
      const order = [...(this.rsPaneOrder || [])];
      const from = order.indexOf(paneId);
      if (from < 0) return;
      const [item] = order.splice(from, 1);
      const clamped = Math.max(0, Math.min(order.length, targetIdx));
      order.splice(clamped, 0, item);
      this.rsPaneOrder = order;
      this.persist();
    },
    resetRsPaneOrder() {
      this.rsPaneOrder = ['search', 'outline', 'backlinks', 'tags', 'history', 'agent'];
      this.persist();
    },
    /** v4.3.0 PR #74 — preview-only font size. Editor font is the existing
     *  `setFontSize`; this one drives `--content-font-size` (Preview.vue). */
    setPreviewFontSize(n: number) {
      this.previewFontSize = Math.max(10, Math.min(32, Math.round(n || 15)));
      this.persist();
    },
    previewFontIn() { this.setPreviewFontSize((this.previewFontSize || 15) + 1); },
    previewFontOut() { this.setPreviewFontSize((this.previewFontSize || 15) - 1); },
    resetPreviewFontSize() { this.setPreviewFontSize(15); },
    /** v4.3.5 — flip between `shared` (`_assets/`) and `per-file`
     *  (`<basename>.assets/`) attachment storage layouts. */
    setAttachmentMode(mode: 'shared' | 'per-file' | 'custom') {
      this.attachmentMode =
        mode === 'per-file' ? 'per-file' : mode === 'custom' ? 'custom' : 'shared';
      this.persist();
    },
    // #7 — Typora-style custom path template (used when attachmentMode==='custom').
    setAttachmentCustomPath(tpl: string) {
      const cleaned = (tpl || '').trim();
      this.attachmentCustomPath = cleaned || './images/${filename}/';
      this.persist();
    },
    setAssetsDirName(name: string) {
      // Strip slashes/backslashes — the path is joined by the image-paste
      // helper using the platform separator, so a name with separators would
      // create nested folders or break URL prefixes. Trim whitespace; fall
      // back to the default when empty.
      const cleaned = (name || '').replace(/[\\/]/g, '').trim();
      this.assetsDirName = cleaned || '_assets';
      this.persist();
    },
    /** v4.3.0 PR #74 — editor-only font size convenience wrappers. The
     *  underlying field is the existing `fontSize`. */
    editorFontIn() { this.setFontSize((this.fontSize || 14) + 1); },
    editorFontOut() { this.setFontSize((this.fontSize || 14) - 1); },
    resetEditorFontSize() { this.setFontSize(14); },
    // v4.6 F6 — Inbox workflow toggles.
    toggleInboxWorkflow() {
      this.inboxWorkflowEnabled = !this.inboxWorkflowEnabled;
      this.persist();
    },
    toggleAutoAdvanceInbox() {
      this.autoAdvanceInboxAfterOrganize = !this.autoAdvanceInboxAfterOrganize;
      this.persist();
    },
  },
});
