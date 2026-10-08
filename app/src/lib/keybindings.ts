/**
 * Rebindable keyboard shortcuts (#180).
 *
 * Until now every app-level shortcut lived in one long if/else chain in
 * `useShortcuts.ts`, which meant the answer to "how do I change a shortcut"
 * was "you can't". This module turns that chain into data: a table of
 * bindable actions with their defaults, plus the combo parsing/formatting
 * both the dispatcher and the settings UI need.
 *
 * Combo syntax is a normalized string — `Mod+Shift+K`, `Mod+Alt+ArrowRight`,
 * `Shift+F3`, `F1`. Parts are ordered Mod, Alt, Shift, key so two spellings
 * of the same chord can never disagree. `Mod` is ⌘ on macOS and Ctrl
 * everywhere else, which is what lets one table serve every platform.
 *
 * Editor-internal keys (CodeMirror's own keymap: ⌘J AI rewrite, list
 * indentation, …) are deliberately NOT here. They live inside the editor's
 * keymap where CodeMirror resolves them against the document context, and
 * folding them into a global table would change when they fire.
 */

export type KeyCombo = string;

/**
 * The user's overrides, as stored in `settings.keybindings`. A string or a
 * list of strings replaces the action's defaults (a list keeps more than one
 * chord — the Typora/Word preset gives "toggle live edit" both ⌘/ and ⌘⌥/),
 * `null` unbinds it, and a missing key means "use the default".
 */
export type KeyOverride = string | string[] | null | undefined;
export type KeyOverrides = Record<string, KeyOverride>;

/** The chords an override stands for, or null when it defers to the defaults. */
function overrideCombos(override: KeyOverride): KeyCombo[] | null {
  if (override === null) return [];
  if (override === undefined || override === '') return null;
  const list = Array.isArray(override) ? override : [override];
  const out: KeyCombo[] = [];
  for (const c of list) {
    if (typeof c !== 'string' || !c) continue;
    const n = normalizeCombo(c);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Effective chords for one action under a set of overrides. */
function effectiveCombos(action: KeyActionDef, overrides: KeyOverrides): KeyCombo[] {
  return overrideCombos(overrides[action.id]) ?? action.defaults.map(normalizeCombo);
}

/** Settings › Shortcuts groups — one per menu-bar menu, in menu order. */
export const KEY_CATEGORIES = ['file', 'edit', 'paragraph', 'format', 'navigate', 'view', 'help'] as const;
export type KeyCategory = (typeof KEY_CATEGORIES)[number];

export interface KeyActionDef {
  /** Stable id — matches the command registry's id where one exists. */
  id: string;
  /** Name shown in Settings. English, like the command palette's titles. */
  label: string;
  category: KeyCategory;
  /**
   * Defaults, in priority order. A few actions ship two chords — ⌘N and ⌘T
   * both make a note, F1 and ⌘/ both open help — because both are muscle
   * memory from different editors. A user binding replaces the whole set.
   */
  defaults: KeyCombo[];
  /**
   * Platforms this action exists on. Omitted means all of them, which is the
   * case for everything except `file.exit` — see its entry.
   */
  platforms?: ('mac' | 'windows' | 'linux')[];
}

/** Which platform's key table to build. Overridable so tests can pin one. */
function currentPlatform(): 'mac' | 'windows' | 'linux' {
  // `?forcePlatform=windows` is a dev-only QA hook, the same idea as
  // `?forcePlain` / `?forceWinChrome`: it lets the Windows-only parts of the
  // shortcut panel be driven from a macOS dev build. The Tauri shell has no
  // URL bar, so it is inert for real users.
  if (typeof location !== 'undefined') {
    const forced = /[?&]forcePlatform=(mac|windows|linux)\b/.exec(location.search);
    if (forced) return forced[1] as 'mac' | 'windows' | 'linux';
  }
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Mac|iPhone|iPad/.test(ua)) return 'mac';
  if (/Win/.test(ua)) return 'windows';
  return 'linux';
}

/** The actions bindable on this platform. Every consumer iterates this, not
 *  `KEY_ACTIONS`, so a platform-gated action never reaches the settings list,
 *  the resolver, or the conflict check. */
export function activeKeyActions(
  platform: 'mac' | 'windows' | 'linux' = currentPlatform(),
): KeyActionDef[] {
  return KEY_ACTIONS.filter((a) => !a.platforms || a.platforms.includes(platform));
}

/** id → action for one platform. `combosFor` runs once per label at startup
 *  (every toolbar tooltip, palette entry and menu accelerator), and a fresh
 *  `activeKeyActions()` filter + linear find per call made that quadratic.
 *  KEY_ACTIONS is a constant table, so the index never goes stale. */
const actionIndex = new Map<string, Map<string, KeyActionDef>>();
function activeActionById(actionId: string, platform: 'mac' | 'windows' | 'linux'): KeyActionDef | undefined {
  let index = actionIndex.get(platform);
  if (!index) {
    index = new Map();
    // First match wins, as with the `find` this replaces.
    for (const a of activeKeyActions(platform)) if (!index.has(a.id)) index.set(a.id, a);
    actionIndex.set(platform, index);
  }
  return index.get(actionId);
}

/**
 * Every app-level shortcut, transcribed from the pre-#180 handler so the
 * defaults are byte-for-byte what shipped before.
 */
export const KEY_ACTIONS: KeyActionDef[] = [
  // Grouped and ordered as the menu bar is (lib/app-menu.ts), so Settings ›
  // Shortcuts reads like the menus it rebinds — a tester's review (bug/,
  // 2026-10-07) found a 工具 group no menu had.

  // ---- File ----
  { id: 'file.new', label: 'New Note', category: 'file', defaults: ['Mod+N', 'Mod+T'] },
  { id: 'file.newText', label: 'New Plain Text', category: 'file', defaults: ['Mod+Alt+N'] },
  // #338 — a note in the folder selected in the file tree (or the selected
  // file's folder).
  { id: 'file.newInFolder', label: 'New Note in Selected Folder', category: 'file', defaults: ['Mod+Alt+Shift+N'] },
  { id: 'window.new', label: 'New Window', category: 'file', defaults: ['Mod+Shift+N'] },
  { id: 'capture.quick', label: 'Quick Capture…', category: 'file', defaults: [] },
  { id: 'file.open', label: 'Open File…', category: 'file', defaults: ['Mod+O'] },
  // Not ⌘⇧O (the outline, and AMD's on Windows) and not Alt+O (on a Mac ⌥O
  // types ø). Three modifiers is the price of a chord free everywhere.
  { id: 'file.openFolder', label: 'Open Folder…', category: 'file', defaults: ['Mod+Alt+Shift+O'] },
  { id: 'daily.openToday', label: "Open Today's Daily Note", category: 'file', defaults: ['Mod+D'] },
  { id: 'daily.openYesterday', label: "Open Yesterday's Daily Note", category: 'file', defaults: [] },
  { id: 'daily.openTomorrow', label: "Open Tomorrow's Daily Note", category: 'file', defaults: [] },
  { id: 'file.save', label: 'Save', category: 'file', defaults: ['Mod+S'] },
  { id: 'file.saveAs', label: 'Save As…', category: 'file', defaults: ['Mod+Shift+S'] },
  { id: 'file.import', label: 'Import Documents…', category: 'file', defaults: ['Mod+Shift+L'] },
  { id: 'image.uploadLocalImages', label: 'Upload Local Images to Image Host…', category: 'file', defaults: [] },
  { id: 'export.html', label: 'Export as HTML', category: 'file', defaults: [] },
  { id: 'export.docx', label: 'Export as Word', category: 'file', defaults: [] },
  { id: 'export.pdfPrint', label: 'Print / PDF', category: 'file', defaults: ['Mod+Alt+Shift+P'] },
  { id: 'export.pdf', label: 'Export as PDF (Image)', category: 'file', defaults: [] },
  { id: 'export.image', label: 'Export as Image', category: 'file', defaults: [] },
  { id: 'export.copyHtml', label: 'Copy as HTML', category: 'file', defaults: ['Mod+Shift+C'] },
  { id: 'export.copyMd', label: 'Copy as Markdown', category: 'file', defaults: ['Mod+Alt+C'] },
  { id: 'inbox.open', label: 'Open Inbox', category: 'file', defaults: [] },
  { id: 'inbox.toggle', label: 'Toggle Inbox Flag / Organize', category: 'file', defaults: ['Mod+E'] },
  { id: 'file.openExternal', label: 'Open in External Editor', category: 'file', defaults: ['Mod+Shift+E'] },
  { id: 'settings.open', label: 'Settings', category: 'file', defaults: ['Mod+Comma'] },
  { id: 'file.closeTab', label: 'Close Tab', category: 'file', defaults: ['Mod+W'] },
  // B4 — Typora's "reopen closed tab". ⌘⇧T was free, so it ships bound.
  { id: 'tab.reopenClosed', label: 'Reopen Closed Tab', category: 'file', defaults: ['Mod+Shift+T'] },
  // #272 — not on macOS: Quit ⌘Q belongs to the OS app menu, and the native
  // Exit item is built `#[cfg(target_os = "linux")]`, so a rebind here could
  // never reach the menu that actually owns the chord. Listing it in Settings
  // would be the exact lie #180 set out to remove.
  {
    id: 'file.exit',
    label: 'Exit',
    category: 'file',
    defaults: ['Mod+Q'],
    platforms: ['windows', 'linux'],
  },

  // ---- Edit ----
  // Find runs in whichever find is focused (the preview's, CodeMirror's, the
  // plain editor's bar); Replace opens the same bar with the caret in the
  // replace field. Ctrl+H is browser History inside WebView2 — release builds
  // turn the browser accelerators off (runner.rs), which is what frees it.
  { id: 'editor.find', label: 'Find…', category: 'edit', defaults: ['Mod+F'] },
  { id: 'editor.replace', label: 'Replace…', category: 'edit', defaults: ['Mod+H'], platforms: ['windows', 'linux'] },
  // ⌘H hides the app on a Mac; ⌥⌘F is where Mac editors keep Replace.
  { id: 'editor.replace', label: 'Replace…', category: 'edit', defaults: ['Mod+Alt+F'], platforms: ['mac'] },
  { id: 'editor.caseCycle', label: 'Cycle Case of Selection', category: 'edit', defaults: ['Shift+F3'] },
  // ---- Typora-style selection commands (B4) ----
  // Each one works in all three editors (lib/editor-commands.ts decides the
  // range; Editor.vue applies it). Bound by default only where the chord was
  // free: ⌘D is today's daily note, so "select word" waits for the
  // Typora / Word preset (or the user) to give it a key.
  { id: 'editor.selectWord', label: 'Select Word', category: 'edit', defaults: [] },
  { id: 'editor.deleteWord', label: 'Delete Word', category: 'edit', defaults: ['Mod+Shift+D'] },
  { id: 'editor.selectLine', label: 'Select Line', category: 'edit', defaults: ['Mod+L'] },
  { id: 'editor.jumpToSelection', label: 'Jump to Selection', category: 'edit', defaults: ['Mod+Alt+J'] },
  { id: 'editor.aiRewrite', label: 'AI Rewrite Selection', category: 'edit', defaults: ['Mod+J'] },
  { id: 'clean.aiArtifacts', label: 'Clean AI Formatting Marks', category: 'edit', defaults: [] },
  { id: 'clean.stripMarkdown', label: 'Strip All Markdown', category: 'edit', defaults: [] },
  { id: 'format.markdown', label: 'Format Markdown', category: 'edit', defaults: ['Mod+Alt+L'] },
  { id: 'proofread.cjk', label: 'CJK Proofread', category: 'edit', defaults: ['Mod+Shift+J'] },

  // ---- Paragraph (#296, #274) ----
  { id: 'fmt.h1', label: 'Heading 1', category: 'paragraph', defaults: ['Mod+1'] },
  { id: 'fmt.h2', label: 'Heading 2', category: 'paragraph', defaults: ['Mod+2'] },
  { id: 'fmt.h3', label: 'Heading 3', category: 'paragraph', defaults: ['Mod+3'] },
  { id: 'fmt.h4', label: 'Heading 4', category: 'paragraph', defaults: ['Mod+4'] },
  { id: 'fmt.h5', label: 'Heading 5', category: 'paragraph', defaults: ['Mod+5'] },
  { id: 'fmt.h6', label: 'Heading 6', category: 'paragraph', defaults: ['Mod+6'] },
  // B4 — Typora's ⌘= / ⌘- / ⌘0. Those chords zoom the whole UI here, so the
  // commands ship unbound and the Typora / Word preset hands them the keys.
  { id: 'heading.promote', label: 'Increase Heading Level', category: 'paragraph', defaults: [] },
  { id: 'heading.demote', label: 'Decrease Heading Level', category: 'paragraph', defaults: [] },
  { id: 'heading.paragraph', label: 'Convert to Paragraph', category: 'paragraph', defaults: [] },
  { id: 'fmt.ol', label: 'Numbered List', category: 'paragraph', defaults: ['Mod+Alt+7'] },
  { id: 'fmt.ul', label: 'Bulleted List', category: 'paragraph', defaults: ['Mod+Alt+8'] },
  { id: 'fmt.task', label: 'Task List', category: 'paragraph', defaults: ['Mod+Alt+9'] },
  { id: 'fmt.quote', label: 'Blockquote', category: 'paragraph', defaults: ['Mod+Alt+Q'] },
  { id: 'fmt.codeblock', label: 'Code Block', category: 'paragraph', defaults: ['Mod+Alt+K'] },
  { id: 'editor.tableEditor', label: 'Edit Current Table…', category: 'paragraph', defaults: ['Mod+Alt+T'] },
  { id: 'editor.formulaEditor', label: 'Edit Current Formula…', category: 'paragraph', defaults: ['Mod+Alt+M'] },

  // ---- Format ----
  // Bold is NOT on Mod+B by default: that has toggled the file tree since
  // 1.0 (the VS Code habit), and taking it away from everyone to match the
  // Typora habit trades one group's muscle memory for another's. The writer
  // preset below swaps the two in one click instead.
  { id: 'fmt.bold', label: 'Bold', category: 'format', defaults: ['Mod+Shift+B'] },
  { id: 'fmt.italic', label: 'Italic', category: 'format', defaults: ['Mod+I'] },
  { id: 'fmt.strike', label: 'Strikethrough', category: 'format', defaults: ['Mod+Shift+X'] },
  { id: 'fmt.code', label: 'Inline Code', category: 'format', defaults: ['Mod+Shift+M'] },
  { id: 'fmt.link', label: 'Link', category: 'format', defaults: ['Mod+K'] },

  // ---- Navigate ----
  { id: 'palette.open', label: 'Command Palette', category: 'navigate', defaults: ['Mod+Shift+K'] },
  { id: 'quickSwitcher.open', label: 'Quick File Switcher', category: 'navigate', defaults: ['Mod+P'] },
  { id: 'search.global', label: 'Search in Folder', category: 'navigate', defaults: ['Mod+Shift+F'] },
  { id: 'tab.prev', label: 'Previous Tab', category: 'navigate', defaults: ['Mod+BracketLeft'] },
  { id: 'tab.next', label: 'Next Tab', category: 'navigate', defaults: ['Mod+BracketRight'] },
  { id: 'tile.splitRight', label: 'Split Pane Right', category: 'navigate', defaults: ['Mod+Backslash'] },
  { id: 'tile.splitDown', label: 'Split Pane Down', category: 'navigate', defaults: ['Mod+Shift+Backslash'] },
  { id: 'tile.focusNext', label: 'Focus Next Pane', category: 'navigate', defaults: ['Mod+Alt+ArrowRight'] },
  { id: 'tile.focusPrev', label: 'Focus Previous Pane', category: 'navigate', defaults: ['Mod+Alt+ArrowLeft'] },

  // ---- View ----
  // #180: Typora users flip source <-> WYSIWYG with Ctrl+/. That chord is
  // Markdown Help here, so the default is Mod+Alt+/; rebind it to Mod+/ in
  // Settings -> Shortcuts to get Typora's muscle memory back.
  { id: 'view.toggleLiveEdit', label: 'Toggle Source / Live Edit', category: 'view', defaults: ['Mod+Alt+Slash'] },
  { id: 'view.cycleView', label: 'Cycle Edit / Split / Preview', category: 'view', defaults: ['Mod+Shift+P'] },
  { id: 'view.toggleReading', label: 'Toggle Reading Mode', category: 'view', defaults: ['Mod+Shift+R'] },
  { id: 'view.slideshow', label: 'Slideshow', category: 'view', defaults: ['Mod+Alt+P'] },
  { id: 'view.toggleFileTree', label: 'Toggle File Tree', category: 'view', defaults: ['Mod+B'] },
  { id: 'view.toggleRightSidebar', label: 'Toggle Right Sidebar', category: 'view', defaults: ['Mod+Alt+B'] },
  { id: 'view.toggleOutline', label: 'Toggle Outline', category: 'view', defaults: ['Mod+Shift+O'] },
  { id: 'view.toggleInspector', label: 'Toggle Properties Inspector', category: 'view', defaults: ['Mod+Shift+I'] },
  // Folding. The chords mirror CodeMirror's own fold keymap so the muscle
  // memory carries over — but they are handled at app level, which is what
  // makes them work in the Windows plain-textarea editor too (it has no
  // CodeMirror keymap to reach).
  { id: 'fold.toggle', label: 'Fold / Unfold Section at Cursor', category: 'view', defaults: ['Mod+Shift+BracketLeft'] },
  { id: 'fold.all', label: 'Fold All Sections', category: 'view', defaults: ['Mod+Alt+BracketLeft'] },
  { id: 'fold.none', label: 'Unfold All', category: 'view', defaults: ['Mod+Alt+BracketRight'] },
  // B4 — F8 / F9 as in Typora. Both keys were free.
  { id: 'view.toggleFocusMode', label: 'Toggle Focus Mode', category: 'view', defaults: ['F8'] },
  { id: 'view.toggleTypewriter', label: 'Toggle Typewriter Mode', category: 'view', defaults: ['F9'] },
  // Unbound by default. It shipped on ⌘⇧Z, which is redo on macOS (and in
  // CodeMirror everywhere), so every redo also started a writing session
  // (5.0 regression run, F-1). Bind it in Settings › Shortcuts.
  { id: 'pomodoro.startLast', label: 'Start Focused Writing Session', category: 'view', defaults: [] },
  { id: 'view.toggleToolbar', label: 'Show / Hide Toolbar Buttons', category: 'view', defaults: ['Mod+Alt+Shift+T'] },
  // Zoom used to be hard-wired in App.vue. It is rebindable now because the
  // Typora / Word preset gives ⌘= / ⌘- / ⌘0 to the heading-level commands,
  // and a chord that cannot be unbound cannot be given away. The preview
  // axis (⌃⌘= on macOS) stays a fixed menu accelerator: "Mod" cannot say
  // "⌘ and ⌃ together".
  { id: 'view.zoomUiIn', label: 'UI: Zoom In', category: 'view', defaults: ['Mod+Equal'] },
  { id: 'view.zoomUiOut', label: 'UI: Zoom Out', category: 'view', defaults: ['Mod+Minus'] },
  { id: 'view.zoomUiReset', label: 'UI: Reset Zoom', category: 'view', defaults: ['Mod+0'] },
  { id: 'view.zoomEditorIn', label: 'Editor: Zoom In', category: 'view', defaults: ['Mod+Shift+Equal'] },
  { id: 'view.zoomEditorOut', label: 'Editor: Zoom Out', category: 'view', defaults: ['Mod+Shift+Minus'] },
  { id: 'view.zoomEditorReset', label: 'Editor: Reset Zoom', category: 'view', defaults: ['Mod+Shift+0'] },

  // ---- Help ----
  { id: 'help.markdown', label: 'Markdown Help', category: 'help', defaults: ['F1', 'Mod+Slash'] },
];

/**
 * The chords every text field means the same thing by — undo, redo, select
 * all, clipboard. No app action ships on one, and when the editor has
 * already acted on one no app action runs for it either (`appRunsAfterEditor`).
 */
export const STANDARD_EDITING_CHORDS: readonly KeyCombo[] = [
  'Mod+Z', 'Mod+Shift+Z', 'Mod+Y', 'Mod+A', 'Mod+C', 'Mod+V', 'Mod+X',
];

/** File, window and navigation commands act on the app, not the text, so
 *  they still run when the editor also used the chord (Vim's Ctrl-o, …). */
const OVERRIDES_EDITOR: ReadonlySet<KeyCategory> = new Set(['file', 'navigate', 'help']);

/**
 * Whether the window-level shortcut handler should still run `actionId` for
 * a keydown CodeMirror's own keymap already handled (it called
 * preventDefault). App shortcuts listen on `window`, after the editor, so a
 * chord in both did two things at once: ⌘⇧Z redid the edit *and* started a
 * Pomodoro session. Editing-level actions defer to the editor; commands
 * about files, windows and navigation still run.
 */
export function appRunsAfterEditor(
  actionId: string,
  combo: KeyCombo,
  platform: 'mac' | 'windows' | 'linux' = currentPlatform(),
): boolean {
  if (STANDARD_EDITING_CHORDS.includes(normalizeCombo(combo))) return false;
  const def = activeActionById(actionId, platform);
  return !!def && OVERRIDES_EDITOR.has(def.category);
}

/** Keys whose `event.key` is punctuation — spelled by code for stability. */
const PUNCT_BY_CODE: Record<string, string> = {
  Comma: ',',
  Slash: '/',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Semicolon: ';',
  Quote: "'",
  Period: '.',
  Backquote: '`',
};
const CODE_BY_PUNCT: Record<string, string> = Object.fromEntries(
  Object.entries(PUNCT_BY_CODE).map(([code, ch]) => [ch, code]),
);

/**
 * Normalized chord for a keydown, or null when the event carries no usable
 * key (a bare modifier, an IME composition).
 *
 * The `event.code` preference for Alt combos is load-bearing, not a style
 * choice: macOS composes Option+letter into another glyph (⌥C arrives as
 * "ç", ⌥N as "Dead"), so matching on `event.key` would make every Alt
 * shortcut silently dead there. Scoped to Alt so non-Latin layouts keep
 * using `key` for everything else.
 */
export function eventToCombo(e: KeyboardEvent): KeyCombo | null {
  if (e.isComposing) return null;
  const raw = e.key;
  if (!raw || raw === 'Dead' || raw === 'Unidentified') {
    // Alt on macOS can produce "Dead" — fall through to the code path below
    // rather than dropping the event.
    if (!(e.altKey && /^(Key[A-Z]|Digit\d)$/.test(e.code))) return null;
  }
  if (['Control', 'Meta', 'Shift', 'Alt', 'CapsLock'].includes(raw)) return null;

  let key: string;
  // Windows, with an input method attached to the focused field (a Chinese
  // IME — in its English mode too): keys the IME looks at arrive as
  // key "Process" / keyCode 229. Under a Ctrl/⌘ chord that is never text, so
  // read the physical key — otherwise every chord typed into the editor is
  // dead there and works everywhere else.
  const imeProcessed = (raw === 'Process' || e.keyCode === 229) && (e.ctrlKey || e.metaKey);
  if (imeProcessed && /^Key[A-Z]$/.test(e.code)) {
    key = e.code.slice(3);
  } else if (imeProcessed && /^Digit\d$/.test(e.code)) {
    key = e.code.slice(5);
  } else if (e.altKey && /^Key[A-Z]$/.test(e.code)) {
    key = e.code.slice(3).toUpperCase();
  } else if (e.altKey && /^Digit\d$/.test(e.code)) {
    // Same story for the number row: ⌥8 arrives as "•", ⌥7 as "¶".
    key = e.code.slice(5);
  } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && /^Digit\d$/.test(e.code)) {
    // ⌘⇧0 arrives as ")" on a US layout — read the digit, so "editor: reset
    // zoom" (Mod+Shift+0) matches on every layout.
    key = e.code.slice(5);
  } else if (e.code === 'NumpadAdd' || e.code === 'NumpadSubtract') {
    // The keypad's + / − have always zoomed along with = / -.
    key = e.code === 'NumpadAdd' ? 'Equal' : 'Minus';
  } else if (PUNCT_BY_CODE[e.code]) {
    key = e.code;
  } else if (/^F\d{1,2}$/.test(raw)) {
    key = raw;
  } else if (raw.length === 1) {
    key = raw.toUpperCase();
  } else {
    key = raw; // ArrowLeft, Enter, Escape, Tab, Backspace…
  }

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** Canonical ordering, so `Shift+Mod+k` and `Mod+Shift+K` are one binding. */
export function normalizeCombo(combo: string): KeyCombo {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() ?? '';
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const out: string[] = [];
  if (mods.has('mod') || mods.has('cmd') || mods.has('ctrl') || mods.has('control') || mods.has('meta')) out.push('Mod');
  if (mods.has('alt') || mods.has('option')) out.push('Alt');
  if (mods.has('shift')) out.push('Shift');
  const punctCode = CODE_BY_PUNCT[key];
  out.push(punctCode ?? (key.length === 1 ? key.toUpperCase() : key));
  return out.join('+');
}

/** Human-readable chord: `⌘⇧K` on macOS, `Ctrl+Shift+K` elsewhere. */
export function formatCombo(combo: KeyCombo, isMac: boolean): string {
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  const has = (m: string) => parts.includes(m);
  const shown = PUNCT_BY_CODE[key] ?? key.replace(/^Arrow/, '');
  if (isMac) {
    return `${has('Mod') ? '⌘' : ''}${has('Alt') ? '⌥' : ''}${has('Shift') ? '⇧' : ''}${shown}`;
  }
  const mods = [has('Mod') && 'Ctrl', has('Alt') && 'Alt', has('Shift') && 'Shift'].filter(Boolean);
  return [...mods, shown].join('+');
}

/**
 * Effective binding table: defaults with the user's overrides applied.
 *
 * An override of `null` means "unbound" — a user who wants ⌘E back for the
 * browser/OS gets to switch ours off rather than being told to live with it.
 */
export function resolveBindings(
  overrides: KeyOverrides = {},
  platform: 'mac' | 'windows' | 'linux' = currentPlatform(),
): Map<KeyCombo, string> {
  const map = new Map<KeyCombo, string>();
  for (const action of activeKeyActions(platform)) {
    for (const combo of effectiveCombos(action, overrides)) {
      // First writer wins, so an earlier action in the table keeps a chord a
      // later one also asks for. The settings UI surfaces the clash before it
      // gets here; this is the tiebreak for a hand-edited settings file.
      if (!map.has(combo)) map.set(combo, action.id);
    }
  }
  return map;
}

/** The chords currently bound to one action (for display in settings). */
export function combosFor(
  actionId: string,
  overrides: KeyOverrides = {},
  platform: 'mac' | 'windows' | 'linux' = currentPlatform(),
): KeyCombo[] {
  const action = activeActionById(actionId, platform);
  if (!action) return [];
  return effectiveCombos(action, overrides);
}

/**
 * Chords another program takes over before SoloMD can see them.
 *
 * Reported from a Windows 10 machine with an AMD card (2026-09-20): AMD
 * Software's global hotkeys swallow most of the Ctrl+Shift row, so those
 * commands simply never fire — the driver's own overlay answers instead.
 * Microsoft Pinyin takes one more. These are *global* hotkeys, registered by
 * the other program at the OS level, so there is nothing the app can do at
 * runtime except say so and offer somewhere else to put the command.
 *
 * Defaults deliberately stay as they are: most people do not run this
 * software, and moving everyone's keys to dodge one vendor's overlay costs
 * more muscle memory than it saves. The settings panel flags the affected
 * rows and offers the alternatives below in one click.
 *
 * Only chords that are really *intercepted* belong here. Ctrl+Shift+P is a
 * habit clash with VS Code's palette, not an interception, and listing it
 * would blur what this table means.
 */
export interface HotkeyInterception {
  /** The chord, as `combosFor` spells it. */
  combo: KeyCombo;
  /** What takes it — shown to the user verbatim. */
  source: string;
  platforms: ('mac' | 'windows' | 'linux')[];
  /** Where the compatibility preset moves the command. */
  alternative: KeyCombo;
}

const AMD = 'AMD Software: Adrenalin Edition';

export const HOTKEY_INTERCEPTIONS: HotkeyInterception[] = [
  { combo: 'Mod+Shift+L', source: AMD, platforms: ['windows'], alternative: 'Mod+Alt+Shift+L' },
  { combo: 'Mod+Shift+R', source: AMD, platforms: ['windows'], alternative: 'Mod+Alt+R' },
  { combo: 'Mod+Shift+E', source: AMD, platforms: ['windows'], alternative: 'Mod+Alt+E' },
  { combo: 'Mod+Shift+C', source: AMD, platforms: ['windows'], alternative: 'Mod+Alt+Shift+C' },
  { combo: 'Mod+Shift+I', source: AMD, platforms: ['windows'], alternative: 'Mod+Alt+I' },
  // F7, not ⌘⌥J: that chord is "jump to selection" now (B4), and F7 is where
  // Word keeps its proofing tools.
  { combo: 'Mod+Shift+J', source: AMD, platforms: ['windows'], alternative: 'F7' },
  { combo: 'Mod+Shift+S', source: AMD, platforms: ['windows'], alternative: 'Mod+Alt+S' },
  { combo: 'Mod+Shift+O', source: AMD, platforms: ['windows'], alternative: 'Mod+Alt+O' },
  { combo: 'Mod+Shift+F', source: 'Microsoft Pinyin', platforms: ['windows'], alternative: 'Mod+Alt+F' },
];

export interface InterceptedBinding {
  action: KeyActionDef;
  combo: KeyCombo;
  source: string;
  alternative: KeyCombo;
}

/**
 * Which bindings *currently in effect* are intercepted on this platform.
 *
 * Reads the effective chords, so a user who already moved a command off the
 * clashing key is not told about it again, and the preset has nothing left to
 * do for them. An alternative already taken by something else is dropped
 * rather than offered — the preset must never create a conflict of its own.
 */
export function interceptedBindings(
  overrides: KeyOverrides = {},
  platform: 'mac' | 'windows' | 'linux' = currentPlatform(),
): InterceptedBinding[] {
  const effective = (action: KeyActionDef): KeyCombo[] => effectiveCombos(action, overrides);
  const actions = activeKeyActions(platform);
  const taken = new Map<KeyCombo, string>();
  for (const action of actions) {
    for (const combo of effective(action)) taken.set(combo, action.id);
  }
  const out: InterceptedBinding[] = [];
  for (const action of actions) {
    for (const combo of effective(action)) {
      const hit = HOTKEY_INTERCEPTIONS.find(
        (h) => normalizeCombo(h.combo) === combo && h.platforms.includes(platform),
      );
      if (!hit) continue;
      const alternative = normalizeCombo(hit.alternative);
      const owner = taken.get(alternative);
      if (owner && owner !== action.id) continue;
      out.push({ action, combo, source: hit.source, alternative });
    }
  }
  return out;
}

/**
 * The "writer" preset: Mod+B is bold, as in Typora, Word and every rich-text
 * box on the web, and the file tree moves to where bold was. It is a swap, so
 * it can never leave either command without a key or create a conflict.
 */
export const WRITER_PRESET: Record<string, KeyCombo> = {
  'fmt.bold': 'Mod+B',
  'view.toggleFileTree': 'Mod+Shift+B',
};

/** True when both halves of the swap are in effect (however they got there). */
export function writerPresetActive(
  overrides: KeyOverrides = {},
): boolean {
  return Object.entries(WRITER_PRESET).every(([id, combo]) => {
    const now = combosFor(id, overrides);
    return now.length === 1 && now[0] === normalizeCombo(combo);
  });
}

/**
 * The "Typora / Word" preset — a tester's full remap (bug/B4, section 八,
 * 28 changes), offered as one click rather than shipped as the defaults:
 *
 * - every Ctrl+Shift chord AMD Software or Microsoft Pinyin swallows moves
 *   to the Ctrl+Alt family (file/edit/view/navigate rows below);
 * - ⌘B is bold and ⌘⇧B the file tree (the writer swap);
 * - ⌘E and ⌘D go back to what Word and Typora do with them (inbox and the
 *   daily note move to ⌘⌥A / ⌘⌥D — ⌘⌥Y on a Mac — and ⌘D selects a word);
 * - ⌘= / ⌘- / ⌘0 change heading levels, so UI zoom keeps its menu entries
 *   but loses its chords;
 * - ⌘/ toggles source / live edit (⌘⌥/ kept as a second key), and Markdown
 *   help keeps F1 alone.
 *
 * `null` unbinds. Commands the preset does not mention keep whatever they
 * have — including a user's own rebinds.
 */
export const TYPORA_PRESET: Record<string, KeyOverride> = {
  // File
  // A tester's follow-up (bug/, 2026-10-07): D is for Daily, and import keeps
  // its L — Mod+Alt+Shift+L is also where the AMD fix moves it.
  'file.import': 'Mod+Alt+Shift+L',
  'file.saveAs': 'Mod+Alt+S',
  'file.openExternal': 'Mod+Alt+E',
  // Edit
  'fmt.bold': 'Mod+B',
  'export.copyHtml': 'Mod+Alt+H',
  'proofread.cjk': 'F7',
  // View
  'view.toggleReading': 'Mod+Alt+R',
  'view.toggleOutline': 'Mod+Alt+O',
  'view.toggleInspector': 'Mod+Alt+I',
  'view.toggleFileTree': 'Mod+Shift+B',
  'view.toggleLiveEdit': ['Mod+Slash', 'Mod+Alt+Slash'],
  'view.zoomUiIn': null,
  'view.zoomUiOut': null,
  'view.zoomUiReset': null,
  // Navigate
  'search.global': 'Mod+Alt+F',
  // Tools
  'inbox.toggle': 'Mod+Alt+A',
  'daily.openToday': 'Mod+Alt+D',
  'help.markdown': 'F1',
  // New commands (B4 section 七)
  'view.toggleFocusMode': 'F8',
  'view.toggleTypewriter': 'F9',
  'editor.selectWord': 'Mod+D',
  'editor.deleteWord': 'Mod+Shift+D',
  'editor.selectLine': 'Mod+L',
  'editor.jumpToSelection': 'Mod+Alt+J',
  'heading.promote': 'Mod+Equal',
  'heading.demote': 'Mod+Minus',
  'heading.paragraph': 'Mod+0',
  'tab.reopenClosed': 'Mod+Shift+T',
};

/**
 * Chords macOS itself answers before any app sees them (or that the app menu
 * owns by convention). The B4 remap was written on Windows; two of its Ctrl+Alt
 * picks are ⌘⌥D (Dock hiding) and ⌘⌥H (Hide Others) on a Mac, so there the
 * preset leaves those two commands where they were. Nothing else in it clashes.
 */
const MAC_RESERVED = new Set(['Mod+Alt+D', 'Mod+Alt+H', 'Mod+H', 'Mod+M', 'Mod+Q', 'Mod+Alt+Escape']);

/**
 * Where a preset entry goes on a Mac when its Windows chord is one macOS
 * keeps. Dropping the entry is not enough for the daily note: the preset
 * gives ⌘D to "select word", so the note must move somewhere.
 */
const MAC_PRESET_FALLBACK: Record<string, KeyOverride> = {
  'daily.openToday': 'Mod+Alt+Y',
};

/** The Typora / Word preset as it applies on one platform. */
export function typoraPreset(
  platform: 'mac' | 'windows' | 'linux' = currentPlatform(),
): Record<string, KeyOverride> {
  const known = new Set(activeKeyActions(platform).map((a) => a.id));
  const out: Record<string, KeyOverride> = {};
  for (const [id, preset] of Object.entries(TYPORA_PRESET)) {
    if (!known.has(id)) continue;
    let value = preset;
    if (platform === 'mac' && (overrideCombos(value) ?? []).some((c) => MAC_RESERVED.has(c))) {
      if (!(id in MAC_PRESET_FALLBACK)) continue;
      value = MAC_PRESET_FALLBACK[id];
    }
    out[id] = value;
  }
  // The remap was written against the Windows defaults. A chord it hands out
  // may be some other command's default on another platform (⌥⌘F is Replace
  // on a Mac) — that entry stays where it was rather than create a clash.
  for (const [id, value] of Object.entries(out)) {
    const clash = (overrideCombos(value) ?? []).some((c) => {
      const owner = conflictFor(c, id, out, platform);
      return !!owner && !(owner in out);
    });
    if (clash) delete out[id];
  }
  return out;
}

/** True when every binding in `preset` is the one in effect. */
export function presetActive(
  preset: Record<string, KeyOverride>,
  overrides: KeyOverrides = {},
  platform: 'mac' | 'windows' | 'linux' = currentPlatform(),
): boolean {
  return Object.entries(preset).every(([id, value]) => {
    const want = overrideCombos(value) ?? [];
    const now = combosFor(id, overrides, platform);
    return now.length === want.length && now.every((c, i) => c === want[i]);
  });
}

/**
 * What applying `preset` on top of the current overrides would do. A chord the
 * user has already given to some command outside the preset is left with them,
 * and the preset entry wanting it is skipped (reported, not forced): a preset
 * must never quietly take a key away from a choice the user made.
 */
export function planPreset(
  preset: Record<string, KeyOverride>,
  overrides: KeyOverrides = {},
  platform: 'mac' | 'windows' | 'linux' = currentPlatform(),
): { apply: Record<string, KeyOverride>; skipped: string[] } {
  const next: KeyOverrides = { ...overrides, ...preset };
  const apply: Record<string, KeyOverride> = {};
  const skipped: string[] = [];
  for (const [id, value] of Object.entries(preset)) {
    const clash = (overrideCombos(value) ?? []).some((c) => {
      const owner = conflictFor(c, id, next, platform);
      return !!owner && !(owner in preset) && owner in overrides;
    });
    if (clash) skipped.push(id);
    else apply[id] = value;
  }
  return { apply, skipped };
}

/**
 * Search over the bindable actions — by name (in the UI language *and* in
 * English, so "bold" finds 加粗), by id, or by the chord itself ("⌘B",
 * "ctrl shift k"). One implementation for the help sheet and the settings
 * list, so the two can never disagree about what a query matches.
 */
export function filterKeyActions(
  actions: KeyActionDef[],
  query: string,
  localizedLabel: (a: KeyActionDef) => string,
  overrides: KeyOverrides = {},
  mac = false,
): KeyActionDef[] {
  const words = query.trim().toLowerCase().split(/[\s+]+/).filter(Boolean);
  if (!words.length) return actions;

  // "ctrl shift k" is a chord, not three words: as text, the lone "k" would
  // match strike, backslash and everything else with a k in it. When the query
  // names a modifier, compare it to the bindings part by part instead.
  const MODS: Record<string, string> = {
    ctrl: 'Mod', control: 'Mod', cmd: 'Mod', command: 'Mod', mod: 'Mod', '⌘': 'Mod', '⌃': 'Mod',
    alt: 'Alt', option: 'Alt', opt: 'Alt', '⌥': 'Alt',
    shift: 'Shift', '⇧': 'Shift',
  };
  // "⌘⇧k" typed without spaces still means three parts.
  const parts = words.flatMap((w) => w.split(/(?=[⌘⌃⌥⇧])|(?<=[⌘⌃⌥⇧])/)).filter(Boolean);
  const wantMods = new Set(parts.filter((w) => MODS[w]).map((w) => MODS[w]));
  const keys = parts.filter((w) => !MODS[w]);
  if (wantMods.size && keys.length <= 1) {
    return actions.filter((a) =>
      combosFor(a.id, overrides).some((c) => {
        const cp = c.split('+');
        const key = cp[cp.length - 1].toLowerCase();
        const mods = new Set(cp.slice(0, -1));
        if (mods.size !== wantMods.size || [...wantMods].some((m) => !mods.has(m))) return false;
        if (!keys.length) return true;
        return key === keys[0] || (PUNCT_BY_CODE[cp[cp.length - 1]] ?? '') === keys[0];
      }),
    );
  }

  return actions.filter((a) => {
    const combos = combosFor(a.id, overrides);
    const hay = [
      localizedLabel(a),
      a.label,
      a.id,
      ...combos,
      ...combos.map((c) => formatCombo(c, mac)),
      // "ctrl" / "cmd" are what people type; the table says "Mod".
      combos.some((c) => c.includes('Mod')) ? 'ctrl cmd command control' : '',
      combos.some((c) => c.includes('Alt')) ? 'option opt' : '',
    ].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Which other action already owns this chord, if any. */
export function conflictFor(
  combo: KeyCombo,
  actionId: string,
  overrides: KeyOverrides = {},
  platform: 'mac' | 'windows' | 'linux' = currentPlatform(),
): string | null {
  const target = normalizeCombo(combo);
  for (const action of activeKeyActions(platform)) {
    if (action.id === actionId) continue;
    if (effectiveCombos(action, overrides).includes(target)) return action.id;
  }
  return null;
}

// The native menu's accelerators come from lib/app-menu.ts (`toNativeSpec`),
// which reads the same bindings for every item — bug/C1 replaced the per-item
// override table that used to live here.

/** `Mod+Shift+K` → `CmdOrCtrl+Shift+K` (Tauri's accelerator grammar). */
export function toTauriAccelerator(combo: KeyCombo): string {
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  const out: string[] = [];
  if (parts.includes('Mod')) out.push('CmdOrCtrl');
  if (parts.includes('Alt')) out.push('Alt');
  if (parts.includes('Shift')) out.push('Shift');
  const named: Record<string, string> = {
    Comma: 'Comma', Slash: 'Slash', BracketLeft: 'BracketLeft', BracketRight: 'BracketRight',
    Backslash: 'Backslash', Minus: 'Minus', Equal: 'Equal', Semicolon: 'Semicolon',
    Quote: 'Quote', Period: 'Period', Backquote: 'Backquote',
  };
  out.push(named[key] ?? key);
  return out.join('+');
}

/** Formatted primary chord for a UI label, or '' when the action is unbound. */
export function shortcutLabel(
  actionId: string,
  overrides: KeyOverrides = {},
  isMac = false,
): string {
  const combos = combosFor(actionId, overrides);
  return combos.length ? formatCombo(combos[0], isMac) : '';
}

/**
 * `Mod+Shift+K` → `Mod-Shift-k`, CodeMirror's keymap spelling. Used for the
 * one editor-level chord that is user-bindable (AI rewrite); the popup
 * navigation keys stay hard-wired because they only mean anything while a
 * popup is open.
 */
export function toCodeMirrorKey(combo: KeyCombo): string {
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  const out: string[] = [];
  if (parts.includes('Mod')) out.push('Mod');
  if (parts.includes('Alt')) out.push('Alt');
  if (parts.includes('Shift')) out.push('Shift');
  const punct: Record<string, string> = {
    Comma: ',', Slash: '/', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Minus: '-', Equal: '=', Semicolon: ';', Quote: "'", Period: '.', Backquote: '`',
  };
  out.push(punct[key] ?? (key.length === 1 ? key.toLowerCase() : key));
  return out.join('-');
}

/** `Shift-Mod-k` and `Mod-Shift-k` are one CodeMirror key: compare canonically. */
function canonicalCmKey(key: string): string {
  const parts = key.split(/-(?!$)/);
  const last = parts.pop() ?? '';
  const mods = parts.map((m) => (m === 'Cmd' || m === 'Meta' ? 'Mod' : m === 'Control' ? 'Ctrl' : m)).sort();
  return [...mods, last.length === 1 ? last.toLowerCase() : last].join('-');
}

/**
 * The app-level binding owns its chord inside CodeMirror too.
 *
 * App shortcuts listen on `window`, after CodeMirror's own keymap has run on
 * the same keydown — so a chord in both used to do two things at once
 * (⌘D: today's note *and* select-next-occurrence; ⌘/: Markdown help *and*
 * an HTML comment). Editor.vue drops every CodeMirror default/search binding
 * this returns true for, and re-filters whenever the user rebinds.
 */
export function cmKeyOwnedByApp(
  binding: { key?: string; mac?: string; win?: string; linux?: string },
  overrides: KeyOverrides = {},
  platform: 'mac' | 'windows' | 'linux' = currentPlatform(),
): boolean {
  const key =
    (platform === 'mac' ? binding.mac : platform === 'windows' ? binding.win : binding.linux) ?? binding.key;
  if (!key) return false;
  const want = canonicalCmKey(key);
  for (const [combo, actionId] of resolveBindings(overrides, platform)) {
    // AI rewrite is itself a CodeMirror keymap entry, not a window handler.
    // Find is app-level only in the preview: in the editor its handler
    // declines so CodeMirror's own ⌘F opens the search panel — filtering that
    // binding out left ⌘F doing nothing in the editor (4.14.8–4.14.9).
    if (actionId === 'editor.aiRewrite' || actionId === 'editor.find') continue;
    if (canonicalCmKey(toCodeMirrorKey(combo)) === want) return true;
  }
  return false;
}
