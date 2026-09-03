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

export interface KeyActionDef {
  /** Stable id — matches the command registry's id where one exists. */
  id: string;
  /** Name shown in Settings. English, like the command palette's titles. */
  label: string;
  category: 'file' | 'edit' | 'view' | 'navigate' | 'tools';
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

/**
 * Every app-level shortcut, transcribed from the pre-#180 handler so the
 * defaults are byte-for-byte what shipped before.
 */
export const KEY_ACTIONS: KeyActionDef[] = [
  // ---- File ----
  { id: 'file.new', label: 'New Note', category: 'file', defaults: ['Mod+N', 'Mod+T'] },
  { id: 'file.newText', label: 'New Plain Text File', category: 'file', defaults: ['Mod+Alt+N'] },
  { id: 'file.open', label: 'Open File…', category: 'file', defaults: ['Mod+O'] },
  { id: 'file.save', label: 'Save', category: 'file', defaults: ['Mod+S'] },
  { id: 'file.saveAs', label: 'Save As…', category: 'file', defaults: ['Mod+Shift+S'] },
  { id: 'file.closeTab', label: 'Close Tab', category: 'file', defaults: ['Mod+W'] },
  { id: 'file.openExternal', label: 'Open in External Editor', category: 'file', defaults: ['Mod+Shift+E'] },
  { id: 'window.new', label: 'New Window', category: 'file', defaults: ['Mod+Shift+N'] },
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
  { id: 'editor.caseCycle', label: 'Cycle Case of Selection', category: 'edit', defaults: ['Shift+F3'] },
  { id: 'format.markdown', label: 'Format Markdown', category: 'edit', defaults: ['Mod+Alt+L'] },
  { id: 'editor.aiRewrite', label: 'AI Rewrite Selection', category: 'edit', defaults: ['Mod+J'] },
  { id: 'export.copyHtml', label: 'Copy as HTML', category: 'edit', defaults: ['Mod+Shift+C'] },
  { id: 'export.copyMd', label: 'Copy as Markdown', category: 'edit', defaults: ['Mod+Alt+C'] },
  { id: 'export.pdfPrint', label: 'Print / PDF', category: 'edit', defaults: ['Mod+Alt+Shift+P'] },

  // ---- View ----
  { id: 'view.cycleView', label: 'Cycle Edit / Split / Preview', category: 'view', defaults: ['Mod+Shift+P'] },
  { id: 'view.toggleReading', label: 'Toggle Reading Mode', category: 'view', defaults: ['Mod+Shift+R'] },
  { id: 'view.toggleFileTree', label: 'Toggle File Tree', category: 'view', defaults: ['Mod+B'] },
  { id: 'view.toggleRightSidebar', label: 'Toggle Right Sidebar', category: 'view', defaults: ['Mod+Alt+B'] },
  { id: 'view.toggleOutline', label: 'Toggle Outline', category: 'view', defaults: ['Mod+Shift+O'] },
  { id: 'view.toggleInspector', label: 'Toggle Properties Inspector', category: 'view', defaults: ['Mod+Shift+I'] },
  { id: 'view.slideshow', label: 'Slideshow', category: 'view', defaults: ['Mod+Alt+P'] },
  { id: 'view.toggleMenuBar', label: 'Toggle Menu Bar', category: 'view', defaults: ['Mod+Shift+M'] },

  // ---- Navigate ----
  { id: 'palette.open', label: 'Command Palette', category: 'navigate', defaults: ['Mod+Shift+K'] },
  { id: 'quickSwitcher.open', label: 'Quick File Switcher', category: 'navigate', defaults: ['Mod+P'] },
  { id: 'search.global', label: 'Search in Folder', category: 'navigate', defaults: ['Mod+Shift+F'] },
  { id: 'editor.find', label: 'Find in Preview', category: 'navigate', defaults: ['Mod+F'] },
  { id: 'tab.prev', label: 'Previous Tab', category: 'navigate', defaults: ['Mod+BracketLeft'] },
  { id: 'tab.next', label: 'Next Tab', category: 'navigate', defaults: ['Mod+BracketRight'] },
  { id: 'tile.splitRight', label: 'Split Pane Right', category: 'navigate', defaults: ['Mod+Backslash'] },
  { id: 'tile.splitDown', label: 'Split Pane Down', category: 'navigate', defaults: ['Mod+Shift+Backslash'] },
  { id: 'tile.focusNext', label: 'Focus Next Pane', category: 'navigate', defaults: ['Mod+Alt+ArrowRight'] },
  { id: 'tile.focusPrev', label: 'Focus Previous Pane', category: 'navigate', defaults: ['Mod+Alt+ArrowLeft'] },

  // ---- Tools ----
  { id: 'settings.open', label: 'Settings', category: 'tools', defaults: ['Mod+Comma'] },
  { id: 'help.markdown', label: 'Markdown Help', category: 'tools', defaults: ['F1', 'Mod+Slash'] },
  { id: 'proofread.cjk', label: 'CJK Proofread', category: 'tools', defaults: ['Mod+Shift+J'] },
  { id: 'daily.openToday', label: "Open Today's Daily Note", category: 'tools', defaults: ['Mod+D'] },
  { id: 'inbox.toggle', label: 'Toggle Inbox Flag / Organize', category: 'tools', defaults: ['Mod+E'] },
  { id: 'pomodoro.startLast', label: 'Start Writing Session (Zen)', category: 'tools', defaults: ['Mod+Shift+Z'] },
];

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
    if (!(e.altKey && /^Key[A-Z]$/.test(e.code))) return null;
  }
  if (['Control', 'Meta', 'Shift', 'Alt', 'CapsLock'].includes(raw)) return null;

  let key: string;
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) {
    key = e.code.slice(3).toUpperCase();
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
  overrides: Record<string, string | null | undefined> = {},
): Map<KeyCombo, string> {
  const map = new Map<KeyCombo, string>();
  for (const action of activeKeyActions()) {
    const override = overrides[action.id];
    if (override === null) continue;
    const combos = override ? [normalizeCombo(override)] : action.defaults.map(normalizeCombo);
    for (const combo of combos) {
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
  overrides: Record<string, string | null | undefined> = {},
): KeyCombo[] {
  const action = activeKeyActions().find((a) => a.id === actionId);
  if (!action) return [];
  const override = overrides[actionId];
  if (override === null) return [];
  return override ? [normalizeCombo(override)] : action.defaults.map(normalizeCombo);
}

/** Which other action already owns this chord, if any. */
export function conflictFor(
  combo: KeyCombo,
  actionId: string,
  overrides: Record<string, string | null | undefined> = {},
): string | null {
  const target = normalizeCombo(combo);
  for (const action of activeKeyActions()) {
    if (action.id === actionId) continue;
    if (combosFor(action.id, overrides).includes(target)) return action.id;
  }
  return null;
}

/**
 * Menu-item id → Tauri accelerator, for the native menu (#180).
 *
 * An empty string means "strip the accelerator": the action moved to a chord
 * the webview handles, so leaving the old one on the menu would keep firing
 * it and a rebind would only ever *add* a shortcut. Only ids the menu
 * actually carries appear here; `set_menu_config` keeps its built-in default
 * for anything absent.
 */
export function nativeMenuAccelerators(
  overrides: Record<string, string | null | undefined> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [actionId, menuId] of Object.entries(MENU_ITEM_BY_ACTION)) {
    if (!Object.prototype.hasOwnProperty.call(overrides, actionId)) continue;
    const combos = combosFor(actionId, overrides);
    out[menuId] = combos.length ? toTauriAccelerator(combos[0]) : '';
  }
  return out;
}

/** Menu items whose accelerator mirrors a rebindable action. */
const MENU_ITEM_BY_ACTION: Record<string, string> = {
  'file.new': 'file.new',
  'file.newText': 'file.newText',
  'file.open': 'file.open',
  'file.save': 'file.save',
  'file.saveAs': 'file.saveAs',
  'file.closeTab': 'file.closeTab',
  'file.openExternal': 'file.openExternal',
  'window.new': 'window.new',
  'file.exit': 'file.exit',
  'export.pdfPrint': 'file.print',
  'view.toggleFileTree': 'view.toggleFileTree',
  'view.toggleRightSidebar': 'view.toggleRightSidebar',
  'view.toggleOutline': 'view.toggleOutline',
  'view.cycleView': 'view.cycleView',
  'search.global': 'search.global',
  'settings.open': 'app.settings',
  'help.markdown': 'help.markdown',
};

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
  overrides: Record<string, string | null | undefined> = {},
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
