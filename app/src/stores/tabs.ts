import { samePath } from '../lib/path-key';
import { defineStore } from 'pinia';
import type { Language, Tab } from '../types';
import { useSettingsStore } from './settings';
import { useTilesStore } from './tiles';
import { useWritingSessionStore } from './writingSession';
import { useWindowsStore } from './windows';
import { stampGoalSetAtIfMissing } from '../composables/useWritingGoals';

// Legacy / global key (used when per-workspace tabs is OFF, and as the
// migration source on first upgrade).
const LS_KEY = 'solomd.tabs.v1';
// Per-workspace bucket prefix: `solomd.tabs.v1::<folder>`. Each workspace
// remembers its own open tabs, so opening folder A never dumps folder B's
// accumulated tabs, and two windows on different workspaces write distinct
// keys instead of clobbering one global blob.
const LS_BUCKET_PREFIX = 'solomd.tabs.v1::';
const NO_WORKSPACE = '__none__';

// #103 — auxiliary windows ("Open file in new window") get their own tab
// bucket so multiple windows on the same folder don't clobber each other's
// open tabs. The main window keeps the un-suffixed keys above (backward
// compatible — existing sessions restore unchanged); auxiliary windows
// append `::win::<label>`. Labels are the stable `solomd-window-N` ids the
// windows store hands out.
const AUX_LABEL_PREFIX = 'solomd-window-';

/** The current Tauri window's label, or 'main' outside Tauri (Vitest, the
 *  marketing site preview, etc.). Read lazily and defensively because tabs.ts
 *  initializes before the Tauri API is guaranteed ready. */
function currentWindowLabel(): string {
  try {
    const internals = (window as any).__TAURI_INTERNALS__;
    const label = internals?.metadata?.currentWindow?.label;
    if (typeof label === 'string' && label) return label;
  } catch {}
  return 'main';
}

/** Per-window scope suffix appended to a bucket key. Empty for the main
 *  window (preserves legacy keys); `::win::<label>` for auxiliary windows. */
function windowScopeSuffix(): string {
  const label = currentWindowLabel();
  return label.startsWith(AUX_LABEL_PREFIX) ? `::win::${label}` : '';
}

let nextId = 1;
const newId = () => `tab-${Date.now()}-${nextId++}`;

function inferLanguage(name: string): Language {
  const lower = name.toLowerCase();
  if (/\.(md|markdown|mdown|mkd)$/.test(lower)) return 'markdown';
  return 'plaintext';
}

interface PersistedState {
  tabs: Tab[];
  activeId: string;
}

/** Read-only check for the "restore previous session" setting, inlined
 *  from localStorage so we can run before the settings store hydrates. */
function restoreSessionEnabled(): boolean {
  try {
    const raw = localStorage.getItem('solomd.settings.v1');
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s.restoreSession === 'boolean') return s.restoreSession;
    }
  } catch {}
  return true;
}

/** Per-workspace tab scoping. Default ON. Inlined from localStorage so it
 *  works before the settings store hydrates (loadPersisted runs at store
 *  creation). */
function perWorkspaceTabsEnabled(): boolean {
  try {
    const raw = localStorage.getItem('solomd.settings.v1');
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s.perWorkspaceTabs === 'boolean') return s.perWorkspaceTabs;
    }
  } catch {}
  return true;
}

/** Current workspace folder, read straight from localStorage to avoid a
 *  static import cycle with the workspace store and to work at init time. */
function currentWorkspaceFolder(): string | null {
  try {
    const raw = localStorage.getItem('solomd.workspace.v1');
    if (raw) {
      const w = JSON.parse(raw);
      if (w && typeof w.currentFolder === 'string') return w.currentFolder;
    }
  } catch {}
  return null;
}

/** localStorage key for a workspace's tab bucket. Falls back to the single
 *  global key when per-workspace scoping is off. Auxiliary windows (#103)
 *  get a per-window suffix so they don't share a bucket with the main window
 *  or each other; the main window's keys are unchanged. */
function bucketKey(folder: string | null): string {
  if (!perWorkspaceTabsEnabled()) return LS_KEY + windowScopeSuffix();
  return LS_BUCKET_PREFIX + (folder || NO_WORKSPACE) + windowScopeSuffix();
}

function isDirty(t: Tab): boolean {
  return t.content !== t.savedContent;
}

/** True when `filePath` lives inside `folder`. Separator- and (on Windows)
 *  case-insensitive so OneDrive / drive-letter paths compare correctly. */
function inFolder(filePath: string | undefined, folder: string | null): boolean {
  if (!filePath || !folder) return false;
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const root = norm(folder);
  const fp = norm(filePath);
  const ci = /^[a-zA-Z]:\//.test(root);
  const r = ci ? root.toLowerCase() : root;
  const f = ci ? fp.toLowerCase() : fp;
  return f === r || f.startsWith(r + '/');
}

function readBucket(key: string): PersistedState | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const data = JSON.parse(raw) as PersistedState;
      if (Array.isArray(data.tabs)) return { tabs: data.tabs, activeId: data.activeId || '' };
    }
  } catch {}
  return null;
}

function loadPersisted(): PersistedState {
  if (!restoreSessionEnabled()) return { tabs: [], activeId: '' };
  // Per-workspace OFF → behave exactly like before (single global blob).
  if (!perWorkspaceTabsEnabled()) {
    return readBucket(bucketKey(null)) ?? { tabs: [], activeId: '' };
  }
  const folder = currentWorkspaceFolder();
  const bucket = readBucket(bucketKey(folder));
  if (bucket) return bucket;
  // #103 — auxiliary windows never inherit the main window's legacy global
  // tab blob; they start from their own (possibly empty) bucket and get
  // their document via the `?path=` query param. Only the main window runs
  // the upgrade migration below.
  if (windowScopeSuffix()) return { tabs: [], activeId: '' };
  // First launch after upgrade: no bucket yet for this workspace. Seed it
  // by scoping the legacy global tab list to the current folder (plus any
  // untitled or unsaved tabs), so an upgrading user with tabs accumulated
  // across many folders doesn't get all of them dumped into this window.
  const legacy = readBucket(LS_KEY);
  if (legacy) {
    const scoped = legacy.tabs.filter(
      (t) => !t.filePath || inFolder(t.filePath, folder) || isDirty(t),
    );
    const activeKept = scoped.some((t) => t.id === legacy.activeId);
    return { tabs: scoped, activeId: activeKept ? legacy.activeId : scoped[0]?.id ?? '' };
  }
  return { tabs: [], activeId: '' };
}

/**
 * B4 — "reopen closed tab" (Typora ⌘⇧T). What a closed tab needs to come
 * back: its path (re-read from disk, so it is never stale), or — for a note
 * that was never saved and was discarded on close — its text. Kept in memory
 * only, per window, like a browser's; capped so it cannot grow without bound.
 */
export interface ClosedTabRecord {
  filePath?: string;
  fileName: string;
  content: string;
  language: Language;
}
const CLOSED_TAB_LIMIT = 20;
const closedTabs: ClosedTabRecord[] = [];

/**
 * A12 — caret positions to put back once, for tabs that came back from a
 * persisted session (launch, or returning to a workspace). Snapshotted at
 * load time so the editor's own first cursor report (line 1 on mount) cannot
 * overwrite the remembered position before the pane gets to apply it.
 * Non-reactive on purpose: it is consumed, never rendered.
 */
const launchCursors = new Map<string, { line: number; col: number }>();
function rememberLaunchCursors(list: Tab[]) {
  for (const t of list) {
    const c = t.cursor;
    if (c && Number.isFinite(c.line) && c.line >= 1) launchCursors.set(t.id, { line: c.line, col: c.col || 1 });
  }
}
let cursorPersistTimer: ReturnType<typeof setTimeout> | null = null;

export const useTabsStore = defineStore('tabs', {
  state: (): PersistedState => {
    const s = loadPersisted();
    rememberLaunchCursors(s.tabs);
    return s;
  },
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
      const settings = useSettingsStore();
      const tab: Tab = {
        id: newId(),
        fileName,
        content: '',
        savedContent: '',
        encoding: 'UTF-8',
        language,
        hadBom: false,
        showOutline: language === 'markdown' && settings.showOutline,
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
      // One file, one tab — however the path is spelled (lib/path-key.ts):
      // `c:\notes\a.md` and `C:\Notes\a.md` are the same document on Windows,
      // and two buffers of it would lose whichever is saved first.
      const existing = this.tabs.find((t) => samePath(t.filePath, payload.filePath));
      if (existing) {
        this.activeId = existing.id;
        // #317 — and adopt what the caller just read off disk. Opening a file
        // that is already open used to only focus the tab and throw the fresh
        // read away, so a document another editor had changed kept showing the
        // stale copy with no way to refresh it from inside the app — opening
        // it again, the obvious move, did nothing. Unsaved edits are never
        // discarded: a dirty tab keeps its text and the watcher's conflict
        // dialog owns that case.
        if (existing.content === existing.savedContent) {
          this.applyDiskRead(existing.id, payload);
        }
        return existing;
      }
      const fileName = payload.filePath.split(/[\\/]/).pop() ?? 'Untitled';
      const settings = useSettingsStore();
      // CodeMirror normalizes \r\n → \n when the doc is created. Mirror
      // that normalization here so content and savedContent stay in
      // lock-step — otherwise opening a Windows-saved file makes the
      // tab "dirty" the moment any docChanged transaction fires
      // (cursor click, extension dispatch) and closing prompts to
      // save even though the user didn't edit anything.
      const lineEnding: 'lf' | 'crlf' = payload.content.includes('\r\n')
        ? 'crlf'
        : 'lf';
      const normalized =
        lineEnding === 'crlf' ? payload.content.replace(/\r\n/g, '\n') : payload.content;
      const tab: Tab = {
        id: newId(),
        filePath: payload.filePath,
        fileName,
        content: normalized,
        savedContent: normalized,
        encoding: payload.encoding,
        language: payload.language,
        hadBom: payload.hadBom,
        lineEnding,
        showOutline: payload.language === 'markdown' && settings.showOutline,
      };
      this.tabs.push(tab);
      this.activeId = tab.id;
      return tab;
    },
    /** #317 — apply a fresh read of the file to an open tab. The tab ends up
     *  clean, because what it shows is exactly what the file holds. Line
     *  endings are normalized the way `openFromDisk` does, or the tab would
     *  read as dirty the moment the editor touched it. Returns whether
     *  anything actually changed. */
    applyDiskRead(
      id: string,
      payload: { content: string; encoding: string; hadBom: boolean },
    ): boolean {
      const t = this.tabs.find((x) => x.id === id);
      if (!t) return false;
      const lineEnding: 'lf' | 'crlf' = payload.content.includes('\r\n') ? 'crlf' : 'lf';
      const normalized =
        lineEnding === 'crlf' ? payload.content.replace(/\r\n/g, '\n') : payload.content;
      const changed = t.content !== normalized || t.savedContent !== normalized;
      t.content = normalized;
      t.savedContent = normalized;
      t.encoding = payload.encoding;
      t.hadBom = payload.hadBom;
      t.lineEnding = lineEnding;
      return changed;
    },
    setContent(id: string, content: string) {
      const t = this.tabs.find((x) => x.id === id);
      if (t) t.content = content;
    },
    /** A12 — record the caret (1-based line/col) the editor reports. The
     *  auto-persist watcher in App.vue keys on content, not on the caret,
     *  so persist here on a short debounce (one localStorage write per
     *  pause, not per arrow key). */
    setCursor(id: string, line: number, col: number) {
      const t = this.tabs.find((x) => x.id === id);
      if (!t || line < 1) return;
      if (t.cursor && t.cursor.line === line && t.cursor.col === col) return;
      t.cursor = { line, col };
      if (cursorPersistTimer) clearTimeout(cursorPersistTimer);
      cursorPersistTimer = setTimeout(() => {
        cursorPersistTimer = null;
        this.persist();
      }, 800);
    },
    /** A12 — the caret position remembered for this tab from the previous
     *  session, returned once (then forgotten). */
    takeLaunchCursor(id: string): { line: number; col: number } | null {
      const c = launchCursors.get(id) ?? null;
      launchCursors.delete(id);
      return c;
    },
    /** v4.6 F1 — apply content that was just written to disk by an external
     *  path (the Properties inspector's Rust frontmatter round-trip). Sets both
     *  `content` (so the editor reflows) and `savedContent` (so the tab is NOT
     *  left falsely dirty, since the bytes already match disk). Unlike
     *  `markSaved` this does no goal-stamping — the on-disk file IS the source
     *  of truth here and must stay byte-identical to what the editor shows. */
    applyExternalSave(id: string, content: string) {
      const t = this.tabs.find((x) => x.id === id);
      if (!t) return;
      t.content = content;
      t.savedContent = content;
    },
    /** #91 — repoint a tab at a new path WITHOUT touching `savedContent`.
     *  Used when a file is renamed while it has unsaved edits: the on-disk
     *  file (now at `filePath`) still holds the old, last-saved bytes, which
     *  are exactly this tab's `savedContent`, so the tab must stay dirty
     *  (content !== savedContent) — otherwise the unsaved-dot vanishes and
     *  closing the tab silently drops the edits. markSaved() is wrong here
     *  because it sets savedContent = content (marks the tab clean). */
    renamePath(id: string, filePath: string) {
      const t = this.tabs.find((x) => x.id === id);
      if (!t) return;
      t.filePath = filePath;
      t.fileName = filePath.split(/[\\/]/).pop() ?? t.fileName;
      t.language = inferLanguage(t.fileName);
    },
    markSaved(id: string, filePath: string) {
      const t = this.tabs.find((x) => x.id === id);
      if (!t) return;
      t.filePath = filePath;
      // Android SAF save-as hands back a content:// URI whose last '/'
      // segment is the percent-encoded documentId ("primary%3A…%2Fnote.md");
      // decode it so the tab shows "note.md", not the raw id.
      if (filePath.startsWith('content://')) {
        try {
          t.fileName =
            decodeURIComponent(filePath).split(/[\\/:]/).filter(Boolean).pop() ?? t.fileName;
        } catch {
          t.fileName = filePath.split(/[\\/]/).pop() ?? t.fileName;
        }
      } else {
        t.fileName = filePath.split(/[\\/]/).pop() ?? t.fileName;
      }
      // v2.5 — auto-stamp `goal_set_at: <today>` on the first save of any
      // doc that declares a `goal:`. This is the anchor the streak counter
      // uses. Idempotent — no-op when the field already exists or there's
      // no goal declared.
      const stamped = stampGoalSetAtIfMissing(t.content);
      if (stamped !== t.content) {
        t.content = stamped;
      }
      t.savedContent = t.content;
      t.language = inferLanguage(t.fileName);
      // v2.5 — push a "saved" anchor into the writing-session store so the
      // popover can show "since last save" instead of "since open".
      try {
        const ws = useWritingSessionStore();
        ws.markSaved(filePath, ws.sessionForPath(filePath)?.current ?? 0);
      } catch {}
    },
    closeTab(id: string) {
      const idx = this.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const closed = this.tabs[idx];
      // A blank untitled tab has nothing worth bringing back.
      if (closed && (closed.filePath || closed.content.trim())) {
        closedTabs.push({
          filePath: closed.filePath,
          fileName: closed.fileName,
          content: closed.content,
          language: closed.language,
        });
        if (closedTabs.length > CLOSED_TAB_LIMIT) closedTabs.shift();
      }
      this.tabs.splice(idx, 1);
      if (this.activeId === id) {
        this.activeId = this.tabs[idx]?.id ?? this.tabs[idx - 1]?.id ?? '';
      }
      // Clean up any pane references to the closed tab
      try {
        const tiles = useTilesStore();
        tiles.removePaneReferences(id);
      } catch {}
      // v2.5 — drop the writing-session anchor for this doc so that
      // closing then reopening starts a fresh "since opened" delta.
      try {
        const ws = useWritingSessionStore();
        const key = closed?.filePath || closed?.id;
        if (key) ws.closePath(key);
      } catch {}
      if (this.tabs.length === 0) this.newTab();
    },
    activate(id: string) {
      this.activeId = id;
    },
    /** The most recently closed tab, removed from the reopen stack. */
    popClosedTab(): ClosedTabRecord | undefined {
      return closedTabs.pop();
    },
    hasClosedTabs(): boolean {
      return closedTabs.length > 0;
    },
    /** #86 — move tab `tabId` to `intendedIndex` (the position in the list
     *  where the user wants it dropped). Handles the shift caused by removing
     *  the source: dragging right (fromIdx < intended) decrements the target
     *  by one after the splice. No-op when the tab is dropped onto itself or
     *  doesn't exist. */
    reorder(tabId: string, intendedIndex: number) {
      const fromIdx = this.tabs.findIndex((t) => t.id === tabId);
      if (fromIdx < 0) return;
      // Adjust BEFORE the splice: removing the source shifts positions to the
      // right of fromIdx down by one. So when intendedIndex (in the original
      // list) is to the right of fromIdx, the actual target after removal is
      // intendedIndex - 1.
      const adjusted = fromIdx < intendedIndex ? intendedIndex - 1 : intendedIndex;
      const [moved] = this.tabs.splice(fromIdx, 1);
      const target = Math.max(0, Math.min(adjusted, this.tabs.length));
      if (target === fromIdx) { this.tabs.splice(fromIdx, 0, moved); return; }
      this.tabs.splice(target, 0, moved);
    },
    toggleOutline(id: string) {
      const t = this.tabs.find((x) => x.id === id);
      if (t) {
        t.showOutline = !t.showOutline;
        // #207 — turning the outline ON must also un-hide the right sidebar:
        // once every pane was toggled off, the sidebar auto-hid and every
        // outline entry point (shortcut / settings / tab button) flipped the
        // flag invisibly, with no surface left to re-open it from.
        if (t.showOutline) useSettingsStore().ensureRightSidebarVisible();
      }
    },
    setShowOutlineAll(value: boolean) {
      for (const t of this.tabs) {
        if (t.language === 'markdown') t.showOutline = value;
      }
      if (value) useSettingsStore().ensureRightSidebarVisible();
    },
    persist() {
      try {
        localStorage.setItem(
          bucketKey(currentWorkspaceFolder()),
          JSON.stringify({ tabs: this.tabs, activeId: this.activeId }),
        );
      } catch {}
    },
    /** #103 — when this is an auxiliary window, record it in the shared
     *  windows registry so the main window re-spawns it on the next launch.
     *  `path` is the document the window was opened to show; it's stored as
     *  the window's restore anchor. No-op in the main window. */
    registerAuxWindow(path: string) {
      const suffix = windowScopeSuffix();
      if (!suffix) return; // main window — nothing to register
      const label = currentWindowLabel();
      try {
        useWindowsStore().register(label, {
          path,
          folder: currentWorkspaceFolder(),
        });
      } catch {}
    },
    /** Write the current view into a specific workspace's bucket (used when
     *  leaving a workspace, so it's remembered when the user returns). */
    persistToFolder(folder: string | null) {
      if (!perWorkspaceTabsEnabled()) return this.persist();
      try {
        localStorage.setItem(
          bucketKey(folder),
          JSON.stringify({ tabs: this.tabs, activeId: this.activeId }),
        );
      } catch {}
    },
    /** Called by the workspace store when the active folder changes. Saves
     *  the current view into the previous workspace's bucket, then swaps in
     *  the new workspace's remembered tabs. Unsaved (dirty) and untitled
     *  tabs are always carried across so no in-progress work is ever lost. */
    onWorkspaceSwitched(prevFolder: string | null, newFolder: string | null) {
      const settings = useSettingsStore();
      if (!settings.perWorkspaceTabs) return;
      // Remember what was open in the workspace we're leaving.
      this.persistToFolder(prevFolder);
      // Tabs that must follow the user regardless of workspace: anything
      // with unsaved work. `isDirty` covers both dirty saved files AND
      // untitled buffers that have content (their savedContent is empty, so
      // any typed text makes them dirty). A blank untitled tab is disposable
      // — not carried — so entering empty workspaces doesn't accumulate
      // empty scratch tabs.
      const carried = this.tabs.filter((t) => isDirty(t));
      // The new workspace's remembered tabs (only when session restore is on;
      // otherwise we just scope down to the carried set — a blank-ish slate).
      const restored = settings.restoreSession
        ? readBucket(bucketKey(newFolder)) ?? { tabs: [], activeId: '' }
        : { tabs: [], activeId: '' };
      const seenPaths = new Set<string>();
      const seenIds = new Set<string>();
      const merged: Tab[] = [];
      const push = (t: Tab) => {
        // Dedup by id AND by path. The id check matters for untitled tabs
        // (no path): a carried untitled and its copy persisted in the new
        // workspace's bucket share an id, so without this they'd both be
        // added and untitled tabs would multiply on every workspace switch.
        if (seenIds.has(t.id)) return;
        if (t.filePath && seenPaths.has(t.filePath)) return;
        seenIds.add(t.id);
        if (t.filePath) seenPaths.add(t.filePath);
        merged.push(t);
      };
      // Carried tabs win (they hold the live, possibly-unsaved content).
      carried.forEach(push);
      restored.tabs.forEach(push);
      rememberLaunchCursors(restored.tabs.filter((t) => !carried.some((c) => c.id === t.id)));
      const removed = this.tabs.filter((t) => !merged.some((m) => m.id === t.id));
      this.tabs = merged;
      // Pick an active tab: prefer the restored bucket's active, else keep
      // the current one if it survived, else the first tab.
      const ids = new Set(merged.map((t) => t.id));
      if (restored.activeId && ids.has(restored.activeId)) {
        this.activeId = restored.activeId;
      } else if (!ids.has(this.activeId)) {
        this.activeId = merged[0]?.id ?? '';
      }
      // Drop split-pane references to tabs that are no longer open, then
      // make sure at least one tab exists.
      try {
        const tiles = useTilesStore();
        for (const t of removed) tiles.removePaneReferences(t.id);
        tiles.validate(this.tabs);
      } catch {}
      if (this.tabs.length === 0) this.newTab();
      this.persist();
    },
  },
});
