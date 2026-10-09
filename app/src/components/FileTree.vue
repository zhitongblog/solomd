<script setup lang="ts">
import { computed, h as hEdit, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { revealInFileManager } from '../lib/reveal-in-file-manager';
import { useWorkspaceStore } from '../stores/workspace';
import { useFiles } from '../composables/useFiles';
import { useInbox } from '../composables/useInbox';
import { useInboxView } from '../composables/useInboxView';
import { useSettingsStore } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import { useGithubSyncStore } from '../stores/githubSync';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useTabsStore } from '../stores/tabs';
import { useI18n } from '../i18n';
import { isIOS, isMobile, revealLabelKey, usesCommandKey } from '../lib/platform';
import { usePendingDeletes, isDeletePending, UNDO_WINDOW_MS } from '../composables/usePendingDeletes';
import { isSafPath, fromSafPath, safList, safCreate } from '../lib/saf-fs';
import {
  revealRequest,
  revealedPath,
  clearRevealRequest,
  clearRevealedPath,
} from '../composables/useFileTreeReveal';
import { newFileInTreeRequest, clearNewFileInTreeRequest } from '../composables/useFileTreeNewFile';
import MoveToDialog from './MoveToDialog.vue';
import Icon from './Icons.vue';
import { DsButton, DsModal } from '../ui';
import { parentDirOf, setTreeSelection } from '../lib/new-file-target';
import {
  dragPath,
  dragIsDir,
  dropTarget,
  endDrag,
  suppressClick,
  canDropInto,
  baseName,
  sepOf,
  reorderTarget,
  parentDir,
} from '../composables/useTreeDrag';
import {
  sortEntries,
  sortNeedsTimes,
  reorderedNames,
  renameInOrder,
  TREE_SORT_MODES,
  type TreeSortMode,
} from '../lib/tree-sort';

interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
  modified?: number;
  created?: number;
}
interface Node extends Entry {
  expanded?: boolean;
  children?: Node[];
  loading?: boolean;
  /** True when the directory had more children than we serialized — surface
   *  a "+N more" hint instead of silently hiding files. */
  truncated?: boolean;
}

const workspace = useWorkspaceStore();
const files = useFiles();
const inbox = useInbox();
const inboxView = useInboxView();
const settings = useSettingsStore();
const toasts = useToastsStore();
const ghSync = useGithubSyncStore();

/** 5.0 — inside Sidebar.vue the tree drops its own chrome: the sidebar owns
 *  the width, the resize handle, the background and the scrolling, and the
 *  Inbox row lives in the sidebar's nav. */
const props = defineProps<{ embedded?: boolean }>();

/** v4.6.1 — Tolaria-parity "Copy Git URL": repository-backed blob URL for a
 *  file node, built from the linked remote + relative path (branch=main). */
async function copyGitUrl(node: Node) {
  const folder = workspace.currentFolder;
  const remote = ghSync.status?.remote_url ?? '';
  const m = remote.match(/(?:@|:\/\/)([^/:]+)[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!folder || !m) {
    toasts.warning(t('explorer.copyGitUrlNoRepo') || 'This workspace has no linked Git remote.');
    return;
  }
  const [, host, owner, repo] = m;
  const sep = node.path.includes('\\') ? '\\' : '/';
  const folderNorm = folder.endsWith(sep) ? folder : folder + sep;
  const rel = node.path.slice(folderNorm.length).split('\\').join('/').split('/').map(encodeURIComponent).join('/');
  const blobSeg = /gitlab/i.test(host) ? '/-/blob/' : '/blob/';
  await writeText(`https://${host}/${owner}/${repo}${blobSeg}main/${rel}`);
  toasts.success(t('explorer.copyGitUrlDone') || 'Git URL copied to clipboard.');
  closeCtx();
}

/** #120 — copy the node's absolute filesystem path (file OR folder). */
async function copyNodePath(node: Node) {
  await writeText(node.path);
  toasts.success(t('explorer.copyPathDone') || 'Path copied.');
  closeCtx();
}

/** #120 — copy the node's path relative to the workspace root, slash-normalised. */
async function copyNodeRelativePath(node: Node) {
  const folder = workspace.currentFolder;
  const sep = node.path.includes('\\') ? '\\' : '/';
  let rel = node.path;
  if (folder) {
    const folderNorm = folder.endsWith(sep) ? folder : folder + sep;
    if (node.path.startsWith(folderNorm)) rel = node.path.slice(folderNorm.length);
  }
  await writeText(rel.split('\\').join('/'));
  toasts.success(t('explorer.copyRelPathDone') || 'Relative path copied.');
  closeCtx();
}
const tabs = useTabsStore();
const { t } = useI18n();
const pendingDeletes = usePendingDeletes();

const root = ref<Node | null>(null);

// ---------------------------------------------------------------------------
// Selection — the row the user last touched, and the folder a new entry goes
// into. Clicking a file opens it and clicking a folder toggles it; either way
// that row becomes the selection. "New file" then means "here": a selected
// folder is the destination, a selected file sends the note to its own folder
// (see lib/new-file-target.ts, which the save dialog reads too).
//
// The open document drives it as well, so the file being read is the
// selection without needing a click on its row — which is also what gets the
// row highlighted in the tree.
// ---------------------------------------------------------------------------
const selected = ref<{ path: string; isDir: boolean } | null>(null);

watch(selected, (sel) => setTreeSelection(sel), { immediate: true });
watch(
  () => tabs.activeTab?.filePath,
  (path) => {
    if (path) selected.value = { path, isDir: false };
  },
  { immediate: true },
);

/** Folder the section row's + / context menu creates in: the selected folder, the
 *  selected file's folder, else the vault root. Only rows that are actually in
 *  the tree count — a selected document can live outside the open workspace,
 *  and an entry created there would have no row to appear in (#321). */
function newEntryParent(): string {
  const sel = selected.value;
  const node = sel ? findNode(sel.path) : null;
  if (node) {
    const dir = node.is_dir ? node.path : parentDirOf(node.path);
    if (dir) return dir;
  }
  return root.value?.path ?? '';
}

// v2.4 inbox filter — when on, the FileTreeNode subtree below prunes
// non-inbox files (and dirs whose subtree contains no inbox docs).
const showInboxOnly = computed(() => inbox.filterMode.value);

/** Sentinel emitted by the Rust backend when it truncated a huge dir
 * past the 10,000-entry hard cap. We surface it as a dedicated UI
 * row instead of rendering it as a fake file. */
const TRUNCATED_SENTINEL = '__solomd_truncated__';

/** True when the workspace folder itself is gone (moved, deleted, unmounted
 *  drive). Distinct from "empty": an empty tree under the folder's own name is
 *  indistinguishable from data loss, which is how it read before. */
const rootMissing = ref(false);
/** Why the root could not be listed — shown under the path so a report says
 *  "permission denied" vs "no such file" without a debugger. */
const rootError = ref('');

/**
 * #325 — attachment folders are the app's, not the user's: pasted images land
 * there and notes link into them by path, so renaming or moving one by
 * accident breaks every image in the folder. They are treated like dot-folders
 * — out of the tree unless "Show hidden files" is on. Both attachment modes:
 * the shared folder (`_assets`, or whatever it was renamed to) and the
 * per-file `<note>.assets/` folders.
 */
function isAttachmentDir(name: string): boolean {
  return name === (settings.assetsDirName || '_assets') || /\.assets$/i.test(name);
}
function hiddenInTree(e: { name: string; is_dir: boolean }): boolean {
  if (settings.explorerShowHidden) return false;
  return e.name.startsWith('.') || (e.is_dir && isAttachmentDir(e.name));
}

// ---------------------------------------------------------------------------
// #342 — sort order. One mode per workspace (settings.explorerSortByFolder);
// "manual" keeps a per-folder name list in <vault>/.solomd/order.json, which
// is written only once the user actually drags something into place — the
// file is not created just by opening a vault (see #236).
// ---------------------------------------------------------------------------
const sortMode = computed<TreeSortMode>(
  () => (workspace.currentFolder && settings.explorerSortByFolder[workspace.currentFolder]) || 'name-asc',
);
const sortOpen = ref(false);
/** Folder path relative to the vault root ('' = root) → child names in order. */
const manualOrder = ref<Record<string, string[]>>({});

function orderKey(folder: string): string {
  return folder === workspace.currentFolder ? '' : rootRelative(folder);
}
function orderPath(): string | null {
  const rootPath = workspace.currentFolder;
  if (!rootPath || isSafPath(rootPath)) return null;
  return joinPath(joinPath(rootPath, '.solomd'), 'order.json');
}
async function loadManualOrder() {
  manualOrder.value = {};
  const path = orderPath();
  if (!path) return;
  try {
    const fr = await invoke<{ content: string }>('read_file', { path });
    const parsed = JSON.parse(fr.content);
    if (parsed && typeof parsed === 'object') {
      const clean: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) clean[k] = v.filter((x) => typeof x === 'string');
      }
      manualOrder.value = clean;
    }
  } catch {
    /* no order file yet — every folder falls back to creation order */
  }
}
async function saveManualOrder() {
  const path = orderPath();
  if (!path) return;
  try {
    await invoke('fs_create_dir', { path: path.replace(/[\\/][^\\/]+$/, '') }).catch(() => {});
    await invoke('write_file', {
      path,
      content: JSON.stringify(manualOrder.value, null, 2) + '\n',
      encoding: 'UTF-8',
    });
  } catch (err) {
    toasts.error(String(err));
  }
}
function sortChildren<T extends Entry>(folder: string, children: T[]): T[] {
  return sortEntries(children, sortMode.value, manualOrder.value[orderKey(folder)] ?? []);
}
/** Re-apply the current order to everything already loaded (no re-listing). */
function resortLoaded() {
  function walk(n: Node | null | undefined) {
    if (!n || !n.children) return;
    n.children = sortChildren(n.path, n.children);
    n.children.forEach(walk);
  }
  walk(root.value);
}
function setSortMode(mode: TreeSortMode) {
  sortOpen.value = false;
  const folder = workspace.currentFolder;
  if (!folder) return;
  const hadTimes = sortNeedsTimes(sortMode.value);
  settings.setExplorerSort(folder, mode);
  // Date and manual modes need timestamps the plain listing doesn't carry,
  // so switching into one re-lists; otherwise re-sorting in place is enough.
  if (sortNeedsTimes(mode) && !hadTimes) void refreshTreePreservingExpansion();
  else resortLoaded();
}
function sortLabel(mode: TreeSortMode): string {
  const key = {
    'name-asc': 'explorer.sortNameAsc',
    'name-desc': 'explorer.sortNameDesc',
    'created-asc': 'explorer.sortCreatedAsc',
    'created-desc': 'explorer.sortCreatedDesc',
    'modified-desc': 'explorer.sortModifiedDesc',
    manual: 'explorer.sortManual',
  }[mode];
  return t(key);
}

async function loadDir(path: string): Promise<{ children: Node[]; truncated: boolean }> {
  try {
    // #148 — SAF vault: list children via ContentResolver, not std::fs.
    if (isSafPath(path) && workspace.safTreeUri) {
      const safChildren = await safList(workspace.safTreeUri, fromSafPath(path));
      // A delete still inside its undo window is presented as done — the file
      // is on disk for a few more seconds but the user has been told it is gone.
      // The hidden-file filter is applied here rather than in the Kotlin
      // lister, so the setting means the same thing on a SAF vault as on a
      // plain folder.
      return {
        children: sortChildren(
          path,
          (safChildren as Node[]).filter((c) => !isDeletePending(c.path) && !hiddenInTree(c)),
        ),
        truncated: false,
      };
    }
    const entries = await invoke<Entry[]>('list_dir', {
      path,
      showHidden: settings.explorerShowHidden,
      withTimes: sortNeedsTimes(sortMode.value),
    });
    let truncated = false;
    const filtered: Node[] = [];
    for (const e of entries) {
      if (e.name === TRUNCATED_SENTINEL && !e.is_dir && e.path === '') {
        truncated = true;
        continue;
      }
      if (isDeletePending(e.path)) continue;
      if (hiddenInTree(e)) continue;
      filtered.push({ ...e });
    }
    // A successful listing clears the "folder is gone" state, so putting the
    // folder back (or reconnecting the drive) recovers on the next refresh
    // rather than needing the workspace re-picked.
    if (path === workspace.currentFolder) rootMissing.value = false;
    return { children: sortChildren(path, filtered), truncated };
  } catch (e) {
    console.error('list_dir failed', e);
    // Only the root's disappearance is worth a special state; a subfolder that
    // vanished mid-expand just lists as empty.
    if (path === workspace.currentFolder) {
      rootError.value = String(e);
      try {
        rootMissing.value = !(await invoke<boolean>('fs_dir_exists', { path }));
      } catch {
        rootMissing.value = false;
      }
    }
    return { children: [], truncated: false };
  }
}

async function refreshRoot() {
  if (!workspace.currentFolder) {
    root.value = null;
    return;
  }
  const path = workspace.currentFolder;
  rootMissing.value = false;
  root.value = {
    name: isSafPath(path) ? workspace.safName ?? 'Vault' : path.split(/[\\/]/).pop() ?? path,
    path,
    is_dir: true,
    expanded: true,
    loading: true,
  };
  const { children, truncated } = await loadDir(path);
  // If a newer setFolder fired during the await, root.value now points at a
  // different node — discarding our stale result is correct. Same v2.3.1
  // pattern that fixed FileTree-stuck-on-Loading.
  if (root.value && root.value.path === path) {
    root.value.children = children;
    root.value.truncated = truncated;
    root.value.loading = false;
  }
}

async function toggle(node: Node, how: 'click' | 'dblclick' = 'click') {
  // #338 — with "double-click opens folders" a single click on a folder only
  // selects it, and the double click toggles. Without it, a double click is
  // just two clicks (open, close) as it always was, so its own event is
  // ignored — and files open on the first click either way.
  const dblFolders = node.is_dir && settings.explorerDoubleClickFolders;
  // #355 — a single click on a file keeps the keyboard in the tree (F2 / Del
  // act on it, as in VS Code); a double click means "I want to write in it".
  if (how === 'dblclick' && !node.is_dir) {
    focusEditor();
    return;
  }
  if (how === 'dblclick' && !dblFolders) return;
  selected.value = { path: node.path, isDir: !!node.is_dir };
  if (!node.is_dir) {
    await files.openPath(node.path, { fromTree: true });
    // #355 — the editor takes focus when a document opens; a click in the
    // tree gives it back, so F2 / Delete act on the row just clicked.
    if (how === 'click') refocusTree('fromEditor');
    return;
  }
  if (dblFolders && how === 'click') return;
  if (node.expanded) {
    node.expanded = false;
    return;
  }
  await expandDir(node);
}

/** Open a folder row, listing it first if it has never been opened. Used by
 *  the code paths that need a folder open (create in it, reveal, drag-hover)
 *  — unlike toggle() it neither closes an open folder, moves the selection,
 *  nor waits for a double click. */
async function expandDir(node: Node) {
  if (node.expanded) return;
  if (!node.children) {
    node.loading = true;
    const { children, truncated } = await loadDir(node.path);
    node.children = children;
    node.truncated = truncated;
    node.loading = false;
  }
  node.expanded = true;
}

watch(
  () => workspace.currentFolder,
  () => {
    // Leaving the folder ends the undo offer — the toast is about to be out of
    // sight, and a timer that fires against another workspace is a trap.
    void pendingDeletes.flushAll();
    // A reveal highlight belongs to the workspace it was asked for: the same
    // path in the next one must not inherit it.
    clearRevealedPath();
    // Same for the selection: a save dialog aimed at the previous vault's
    // folder is the trap this whole selection exists to avoid.
    selected.value = null;
    void loadManualOrder().then(refreshRoot);
  },
  { immediate: true },
);

// ---------------------------------------------------------------------------
// #282 — "文件树可否增加文件格式过滤，例如我只想显示该文件夹下面的 txt 或者是
// md 文档". The checkbox list offers what the vault actually contains, not a
// canned list of twenty formats.
//
// The filter persists, which makes a hidden filter the obvious failure mode:
// "my files are gone". So whenever it's set the tree shows a banner naming
// the active types with a one-click clear, and the header button changes
// state — see [blank-pane traps]: a persisted flag that hides content must
// never be invisible.
// ---------------------------------------------------------------------------

const filterOpen = ref(false);
const extList = ref<{ ext: string; count: number }[]>([]);
const extFilter = computed<string[]>(() => settings.explorerExtFilter ?? []);

/** Absolute paths of folders whose subtree holds a match, or null when no
 *  filter is active. The tree is lazy, so this can't be derived from the
 *  loaded nodes — it comes from one backend walk per filter change. */
const filterDirs = ref<Set<string> | null>(null);

const filterLabel = computed(() =>
  extFilter.value
    .map((e) => (e === '' ? t('explorer.filterNoExt') || 'no extension' : '.' + e))
    .join('、'),
);

async function refreshFilterDirs() {
  const rootPath = workspace.currentFolder;
  if (!rootPath || extFilter.value.length === 0 || isSafPath(rootPath)) {
    filterDirs.value = null;
    return;
  }
  try {
    const rels = await invoke<string[]>('fs_dirs_with_extensions', {
      root: rootPath,
      exts: extFilter.value,
      showHidden: settings.explorerShowHidden,
    });
    filterDirs.value = new Set(
      rels.map((rel) => rel.split('/').reduce((acc, seg) => joinPath(acc, seg), rootPath)),
    );
  } catch (err) {
    console.warn('[FileTree] dirs-with-extensions failed', err);
    // Failing open beats hiding folders we could not verify.
    filterDirs.value = null;
  }
}

// 5.0 — the sort / filter / workspace popovers are `position: fixed`, placed
// under the button that opened them. They used to be absolute inside the
// header, which a scrolling sidebar would clip.
const popPos = ref<{ x: number; y: number }>({ x: 0, y: 0 });
const POP_MIN_W = 200;
function anchorPop(ev?: Event, alignWidth = false) {
  const el = (ev?.currentTarget as HTMLElement | null) ?? null;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = alignWidth ? r.left : Math.min(r.left, window.innerWidth - POP_MIN_W - 8);
  popPos.value = { x: Math.max(8, Math.round(x)), y: Math.round(r.bottom + 4) };
}

function toggleSortMenu(ev?: Event) {
  sortOpen.value = !sortOpen.value;
  filterOpen.value = false;
  switcherOpen.value = false;
  if (sortOpen.value) anchorPop(ev);
}

async function openFilter(ev?: Event) {
  sortOpen.value = false;
  switcherOpen.value = false;
  filterOpen.value = !filterOpen.value;
  if (filterOpen.value) anchorPop(ev);
  if (!filterOpen.value) return;
  const rootPath = workspace.currentFolder;
  if (!rootPath || isSafPath(rootPath)) {
    extList.value = [];
    return;
  }
  try {
    extList.value = await invoke<{ ext: string; count: number }[]>('fs_list_extensions', {
      root: rootPath,
      showHidden: settings.explorerShowHidden,
    });
  } catch (err) {
    toasts.error(String(err));
    extList.value = [];
  }
}

function extLabel(ext: string): string {
  return ext === '' ? t('explorer.filterNoExt') || 'no extension' : '.' + ext;
}

// `immediate` matters: on startup the workspace folder is restored before
// this watcher exists, so without it a filter that survived the last session
// would sit there with its banner showing while the tree stayed unfiltered
// until the next manual refresh.
watch(
  [extFilter, () => settings.explorerShowHidden, () => workspace.currentFolder],
  () => {
    void refreshFilterDirs();
  },
  { immediate: true },
);
// Flipping "show hidden files" changes what every already-loaded directory
// should contain, so the whole tree is re-listed — expanded folders included.
watch(
  () => settings.explorerShowHidden,
  () => {
    void refreshTreePreservingExpansion();
  },
);

// ---------------------------------------------------------------------------
// v3.0: auto-refresh on save / pull / external-change
// ---------------------------------------------------------------------------

let refreshDebounce: ReturnType<typeof setTimeout> | null = null;
function scheduleRefresh() {
  if (refreshDebounce) clearTimeout(refreshDebounce);
  refreshDebounce = setTimeout(() => {
    refreshDebounce = null;
    void refreshTreePreservingExpansion();
  }, 250);
}

async function refreshTreePreservingExpansion() {
  if (!workspace.currentFolder) return;
  const expanded = new Set<string>();
  function walk(n: Node | null | undefined) {
    if (!n) return;
    if (n.is_dir && n.expanded) expanded.add(n.path);
    n.children?.forEach(walk);
  }
  walk(root.value);
  const path = workspace.currentFolder;
  const { children, truncated } = await loadDir(path);
  async function rehydrate(nodes: Node[]) {
    for (const n of nodes) {
      if (n.is_dir && expanded.has(n.path)) {
        const sub = await loadDir(n.path);
        n.children = sub.children;
        n.truncated = sub.truncated;
        n.expanded = true;
        await rehydrate(sub.children);
      }
    }
  }
  await rehydrate(children);
  if (root.value) {
    root.value.children = children;
    root.value.truncated = truncated;
    root.value.loading = false;
  }
  // Creating / deleting / moving a file can change which folders hold a match
  // for the extension filter (#282). This runs after every tree refresh
  // rather than on a `watch(root)`, because the refresh mutates the root node
  // in place — the ref identity never changes and a watcher would never fire.
  if (extFilter.value.length) void refreshFilterDirs();
}

function onSaved() { scheduleRefresh(); }
function onRemotePulled() { scheduleRefresh(); }

let unlistenIndex: UnlistenFn | null = null;
let unlistenCapture: UnlistenFn | null = null;
/** Closing the window while a delete is pending: run it. The user asked for
 *  the delete and saw it happen; having the file reappear on next launch would
 *  be the surprise, not the safety. Best-effort — the IPC may not land. */
function onBeforeUnload() {
  void pendingDeletes.flushAll();
}

onMounted(async () => {
  window.addEventListener('solomd:saved', onSaved as EventListener);
  window.addEventListener('solomd:remote-pulled', onRemotePulled as EventListener);
  window.addEventListener('beforeunload', onBeforeUnload);
  try {
    unlistenIndex = await listen('solomd://index-updated', () => scheduleRefresh());
  } catch {}
  try {
    // A quick capture writes straight to disk from Rust; without this the new
    // Inbox note is invisible until something else happens to refresh.
    unlistenCapture = await listen('solomd://capture-written', () => scheduleRefresh());
  } catch {}
});
onBeforeUnmount(() => {
  window.removeEventListener('solomd:saved', onSaved as EventListener);
  window.removeEventListener('solomd:remote-pulled', onRemotePulled as EventListener);
  window.removeEventListener('beforeunload', onBeforeUnload);
  // Hiding the tree unmounts it; a selection left behind would keep aiming
  // "new file" at a folder the user can no longer see.
  setTreeSelection(null);
  if (unlistenIndex) unlistenIndex();
  if (unlistenCapture) unlistenCapture();
  if (refreshDebounce) clearTimeout(refreshDebounce);
});

// ---------------------------------------------------------------------------
// v3.0: right-click context menu + inline new / rename
// ---------------------------------------------------------------------------

interface CtxMenu {
  x: number;
  y: number;
  /** null = clicked the workspace root (no node) */
  node: Node | null;
}
const ctx = ref<CtxMenu | null>(null);

interface InlineEdit {
  /** 'new-file' / 'new-dir' / 'rename' */
  kind: 'new-file' | 'new-dir' | 'rename';
  /** For "new", this is the parent dir; for rename, the target's parent. */
  parent: string;
  /** For rename only — the original full path. */
  original?: string;
  /** Editable name (defaults to a sensible placeholder). */
  name: string;
}
const editing = ref<InlineEdit | null>(null);
const editInput = ref<HTMLInputElement | null>(null);

// #321 — the inline input shows up where the entry will actually be: at the
// end of the folder it is created in, or in place of the row being renamed.
// It used to sit at the very top of the tree whatever the target, so a file
// created inside a folder three levels down appeared to be going to the
// root. Nodes are rendered by FileTreeNode (a render function), which draws
// the row through this. The tree filters (inbox, extension) can hide the
// target, and then the row falls back to the top, where it always was.
const editInTree = computed(() => {
  const e = editing.value;
  if (!e || showInboxOnly.value || extFilter.value.length) return false;
  if (e.kind === 'rename') return !!e.original && !!findNode(e.original);
  return e.parent === root.value?.path || !!findNode(e.parent)?.expanded;
});
function renderEditRow(depth: number) {
  const e = editing.value;
  if (!e) return null;
  const isDir = e.kind === 'new-dir' || (e.kind === 'rename' && !!e.original && !!findNode(e.original)?.is_dir);
  return hEdit('li', { class: 'ftree__edit', style: { paddingLeft: `${INDENT_BASE + depth * INDENT_STEP}px` } }, [
    ...indentGuides(depth),
    hEdit('span', { class: 'ftree__caret' }),
    hEdit('span', { class: 'ftree__icon' }, [hEdit(Icon, { name: isDir ? 'folder-sm' : 'file', size: 16 })]),
    hEdit('input', {
      ref: (el: unknown) => {
        if (el) editInput.value = el as HTMLInputElement;
      },
      value: e.name,
      class: 'ftree__edit-input',
      spellcheck: 'false',
      onInput: (ev: Event) => {
        if (editing.value) editing.value.name = (ev.target as HTMLInputElement).value;
      },
      onKeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          cancelEdit();
          return;
        }
        onRenameKey(ev);
      },
      onBlur: commitEdit,
      // A click in the box must not reach the row underneath and open or
      // toggle it.
      onClick: (ev: MouseEvent) => ev.stopPropagation(),
      onPointerdown: (ev: PointerEvent) => ev.stopPropagation(),
    }),
  ]);
}
provide(FTREE_EDIT, { editing, editInTree, renderEditRow });
// One stable component for the root level: an inline `() => …` in the
// template would be a new component type on every render, and the input
// would be torn down — and lose focus — on every keystroke.
const EditRowAtRoot = () => renderEditRow(0);

function openCtx(e: MouseEvent, node: Node | null) {
  e.preventDefault();
  e.stopPropagation();
  openCtxAt(e.clientX, e.clientY, node);
}
function openCtxAt(x: number, y: number, node: Node | null) {
  // Right-clicking a row selects it (the usual desktop convention), so the
  // menu's actions and "new file" agree about what "here" means. Empty-area
  // clicks keep whatever was selected.
  if (node) selected.value = { path: node.path, isDir: !!node.is_dir };
  ctx.value = { x, y, node };
  // Keep it on screen: on a phone a press near the right or bottom edge
  // put half the menu (often Delete) out of reach.
  void nextTick(() => {
    const el = ctxEl.value;
    if (!el || !ctx.value) return;
    const r = el.getBoundingClientRect();
    const nx = Math.max(8, Math.min(ctx.value.x, window.innerWidth - r.width - 8));
    const ny = Math.max(8, Math.min(ctx.value.y, window.innerHeight - r.height - 8));
    if (nx !== ctx.value.x || ny !== ctx.value.y) ctx.value = { ...ctx.value, x: nx, y: ny };
  });
}
const ctxEl = ref<HTMLElement | null>(null);

// Touch screens. iOS's web view never turns a long-press into a
// `contextmenu` event (Android's does), so on an iPhone or iPad the menu with
// Rename / Move to… / Delete could not be opened at all — the App Store
// review "can create files but not delete or move them". A long-press now
// opens it on every touch device, and each row also shows a "⋯" button
// (CSS, coarse pointers only) so the menu can be found without knowing.
const LONG_PRESS_MS = 500;
let longPress: { timer: number; x: number; y: number } | null = null;
let ctxOpenedAt = 0;
function startLongPress(e: PointerEvent, node: Node) {
  cancelLongPress();
  const x = e.clientX;
  const y = e.clientY;
  longPress = {
    x,
    y,
    timer: window.setTimeout(() => {
      longPress = null;
      detachLongPress();
      // The finger lifting off ends in a click: it must neither open the
      // file under it nor close the menu it just opened.
      suppressClick.value = true;
      ctxOpenedAt = Date.now();
      openCtxAt(x, y, node);
    }, LONG_PRESS_MS),
  };
  window.addEventListener('pointermove', onLongPressMove);
  window.addEventListener('pointerup', cancelLongPress);
  window.addEventListener('pointercancel', cancelLongPress);
  window.addEventListener('scroll', cancelLongPress, true);
}
function onLongPressMove(e: PointerEvent) {
  // A finger that travels is scrolling the list, not pressing a row.
  if (longPress && Math.hypot(e.clientX - longPress.x, e.clientY - longPress.y) > 10) cancelLongPress();
}
function detachLongPress() {
  window.removeEventListener('pointermove', onLongPressMove);
  window.removeEventListener('pointerup', cancelLongPress);
  window.removeEventListener('pointercancel', cancelLongPress);
  window.removeEventListener('scroll', cancelLongPress, true);
}
function cancelLongPress() {
  if (longPress) window.clearTimeout(longPress.timer);
  longPress = null;
  detachLongPress();
}
function closeCtx() {
  ctx.value = null;
}

/** Open a collapsed folder before creating in it, so the new row has
 *  somewhere to appear. */
async function expandForCreate(parent: string) {
  const node = findNode(parent);
  if (node && node.is_dir && !node.expanded) await expandDir(node);
}

async function startNewFile(parent: string) {
  closeCtx();
  await expandForCreate(parent);
  editing.value = { kind: 'new-file', parent, name: 'untitled.md' };
  await nextTick();
  // Select just the basename (not the .md) so a single keystroke replaces
  // the placeholder, Finder-style.
  const el = editInput.value;
  if (el) {
    el.focus();
    const dot = el.value.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
  }
}

async function startNewFolder(parent: string) {
  closeCtx();
  await expandForCreate(parent);
  editing.value = { kind: 'new-dir', parent, name: 'New Folder' };
  await nextTick();
  const el = editInput.value;
  if (el) {
    el.focus();
    el.select();
  }
}

async function startRename(node: Node) {
  closeCtx();
  const parent = node.path.replace(/[\\/][^\\/]+$/, '');
  editing.value = {
    kind: 'rename',
    parent,
    original: node.path,
    name: node.name,
  };
  await nextTick();
  const el = editInput.value;
  if (el) {
    el.focus();
    const dot = el.value.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
  }
}

function joinPath(parent: string, name: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return parent.endsWith(sep) ? parent + name : parent + sep + name;
}

// ---------------------------------------------------------------------------
// #290 / #267 — moving files and folders between folders.
//
// Two entry points, one implementation: drag a node onto a folder, or pick
// "Move to…" from the context menu. The picker is not a nicety — the drag is
// mouse-only (on a touchscreen a press-and-drag over a scrollable list is a
// scroll) and isn't reachable from the keyboard at all, so without the picker
// the feature wouldn't exist on mobile.
// ---------------------------------------------------------------------------

/** A plain filesystem vault, i.e. not a SAF one (#148, Android), where files
 *  are addressed by content-URI and the std::fs-backed commands don't apply.
 *  Two features are gated on it: moving (there is no ContentResolver move, so
 *  a drag would fail at the IPC boundary) and the file-type filter (both of
 *  its backend walks need real paths). Gating beats offering a dead control. */
const localVault = computed(
  () => !!workspace.currentFolder && !isSafPath(workspace.currentFolder),
);
const canMove = localVault;

/** Point an open tab at a path that just moved on disk.
 *
 *  #91 again: the dirty check has to be snapshotted BEFORE markSaved, which
 *  sets savedContent = content as part of its bookkeeping — comparing after
 *  it always says "clean" and a dirty tab loses its unsaved edits to whatever
 *  is on disk. Clean tabs are reloaded because a move can rewrite the body
 *  (relative links get re-anchored to the new folder). */
async function repointTab(
  tab: { id: string; filePath?: string; content?: string; savedContent?: string },
  next: string,
) {
  const wasClean = tab.savedContent === tab.content;
  if (!wasClean) {
    tabs.renamePath(tab.id, next);
    return;
  }
  tabs.markSaved(tab.id, next);
  try {
    const fr = await invoke<{ content: string }>('read_file', { path: next });
    tabs.setContent(tab.id, fr.content);
    tabs.markSaved(tab.id, next);
  } catch (err) {
    console.warn('[FileTree] tab reload after move failed', err);
  }
}

/** Every tab under the moved path follows it — a folder move has to repoint
 *  each open note inside it, not just an exact match. */
function repointTabs(from: string, to: string, isDir: boolean) {
  const prefixes = isDir ? [from + '/', from + '\\'] : [];
  for (const tab of [...tabs.tabs] as { id: string; filePath?: string }[]) {
    const fp = tab.filePath;
    if (!fp) continue;
    let next: string | null = null;
    if (fp === from) {
      next = to;
    } else if (prefixes.some((pre) => fp.startsWith(pre))) {
      next = to + fp.slice(from.length);
    }
    if (next) void repointTab(tab, next);
  }
}

function rootRelative(p: string): string {
  const rootPath = workspace.currentFolder ?? '';
  const sep = sepOf(rootPath);
  const norm = rootPath.endsWith(sep) ? rootPath : rootPath + sep;
  return p.startsWith(norm) ? p.slice(norm.length).split('\\').join('/') : '';
}

/** The folder's name in the header. On iOS the app's own container folder is
 *  ".../Data/Application/<uuid>/Documents", which the Files app shows as
 *  "On My iPhone › SoloMD" — say SoloMD here too, not "Documents". */
const rootDisplayName = computed(() => {
  const r = root.value;
  if (!r) return '';
  if (isIOS() && /\/Data\/Application\/[^/]+\/Documents\/?$/.test(r.path)) return 'SoloMD';
  return r.name;
});

function rootLabel(): string {
  return t('explorer.vaultRoot') || 'Vault root';
}

async function moveNode(from: string, destDir: string, isDir: boolean) {
  if (!canDropInto(from, destDir)) return;
  const name = baseName(from);
  const target = joinPath(destDir, name);
  try {
    // A pending delete on the destination path would fire later and take the
    // moved file with it. Same race the new-file path guards against.
    await pendingDeletes.flushUnder(target);
    await invoke('fs_move', { from, to: target });
  } catch (err) {
    // By far the likeliest failure, and the raw Rust string is half English
    // and half absolute path — say it in the user's language instead.
    const exists = String(err).includes('target already exists');
    toasts.error(
      exists
        ? t('explorer.moveExists', { name, dest: rootRelative(destDir) || rootLabel() })
        : t('explorer.moveFailed', { name, error: String(err) }),
    );
    return;
  }
  repointTabs(from, target, isDir);
  scheduleRefresh();
  toasts.push(
    t('explorer.moved', { name, dest: rootRelative(destDir) || rootLabel() }),
    'success',
    UNDO_WINDOW_MS,
    () => {
      void undoMove(target, from, isDir, name);
    },
    { actionLabel: t('explorer.undo') },
  );
}

/** Undo is the same move run backwards, which also puts the rewritten
 *  relative links back the way they were. */
async function undoMove(current: string, original: string, isDir: boolean, name: string) {
  try {
    await invoke('fs_move', { from: current, to: original });
  } catch (err) {
    toasts.error(
      t('explorer.moveFailed', { name, error: String(err) }) ||
        `Could not move ${name}: ${err}`,
    );
    return;
  }
  repointTabs(current, original, isDir);
  scheduleRefresh();
  toasts.info(t('explorer.moveUndone', { name }));
}

// --- "Move to…" picker -----------------------------------------------------

const moveDialog = ref<{ node: Node; dirs: string[] } | null>(null);

async function startMoveTo(node: Node) {
  closeCtx();
  const rootPath = workspace.currentFolder;
  if (!rootPath || !canMove.value) return;
  try {
    const dirs = await invoke<string[]>('fs_list_dirs', {
      root: rootPath,
      showHidden: settings.explorerShowHidden,
    });
    moveDialog.value = { node, dirs };
  } catch (err) {
    toasts.error(String(err));
  }
}

async function onMovePicked(relDir: string) {
  const pending = moveDialog.value;
  moveDialog.value = null;
  const rootPath = workspace.currentFolder;
  if (!pending || !rootPath) return;
  const dest =
    relDir === ''
      ? rootPath
      : relDir.split('/').reduce((acc, seg) => joinPath(acc, seg), rootPath);
  await moveNode(pending.node.path, dest, !!pending.node.is_dir);
}

// --- the drag itself -------------------------------------------------------
//
// Pointer events, NOT the HTML5 Drag and Drop API — see the note in
// useTreeDrag.ts. The short version: `dragDropEnabled: true` (which the app
// needs for "drop a file from Finder to open it") makes the native handler
// swallow in-page drags, and `dragstart` still fires, so the breakage is
// invisible until you actually try to drop something. #86 and #131 both
// learned this the hard way.

const DRAG_THRESHOLD = 4; // px of movement before a press counts as a drag
const AUTO_EXPAND_MS = 600;
const SCROLL_EDGE = 28; // px from the tree's edge that starts auto-scrolling

const treeBody = ref<HTMLElement | null>(null);

let pointerStart: { x: number; y: number; node: Node } | null = null;
let dragActive = false;
let expandTimer: ReturnType<typeof setTimeout> | null = null;
let expandArmedFor = '';

function findNode(path: string, nodes?: Node[]): Node | null {
  for (const n of nodes ?? root.value?.children ?? []) {
    if (samePath(n.path, path)) return n;
    if (n.children) {
      const hit = findNode(path, n.children);
      if (hit) return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// "Reveal in File Tree" — the tab's context menu asks for a file, the tree
// expands down to it and highlights the row.
//
// The old implementation re-rooted the workspace at the file's parent folder,
// which is destructive (the switcher's recents, the per-workspace tab set) and
// was a visible no-op whenever the file already lived directly in the open
// workspace root — the reported "nothing happens". Revealing is a view action:
// it must not move the user's workspace. Rooting elsewhere only happens for a
// file that is genuinely outside it, because then there is nothing to reveal.
//
// The highlight itself is deliberately loud and temporary: a fill + ring + a
// short fade, so it reads in a theme whose accent is close to the row colour
// (a colour-only tint was reported as invisible).
// ---------------------------------------------------------------------------
const REVEAL_HOLD_MS = 3200;
let revealTimer: ReturnType<typeof setTimeout> | null = null;

/** Path segments between the workspace root and `path`, or null when the path
 *  is not inside the open workspace. */
function segmentsUnderRoot(path: string): string[] | null {
  const rootPath = root.value?.path;
  if (!rootPath) return null;
  // Spelling-insensitive on Windows (lib/path-key.ts): the shell may hand us
  // `c:\notes\a.md` for a tree rooted at `C:\Notes`.
  return segmentsBelow(rootPath, path);
}

function rowElementFor(path: string): HTMLElement | null {
  const rows = treeBody.value?.querySelectorAll<HTMLElement>('.ftree__item');
  for (const row of rows ?? []) {
    if (samePath(row.dataset.path, path)) return row;
  }
  return null;
}

/** Highlight a row that is already on screen and scroll it into view. */
function flashRow(path: string, row: HTMLElement) {
  revealedPath.value = path;
  row.scrollIntoView({ block: 'center' });
  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    revealTimer = null;
    clearRevealedPath();
  }, REVEAL_HOLD_MS);
}

/** Expand every folder on the way down, then flash the row. False when the
 *  file is not reachable in the tree (filtered out, hidden, or truncated).
 *
 *  `quiet` is the automatic follow (#333): no flash, and the row is only
 *  scrolled as far as needed to be visible, so switching between two files
 *  that are both on screen does not move the tree at all. */
async function revealRow(path: string, quiet = false): Promise<boolean> {
  // The row's own path, not the request's: on Windows the two may differ in
  // spelling, and the highlight compares against the tree's.
  const show = (row: HTMLElement) =>
    quiet ? row.scrollIntoView({ block: 'nearest' }) : flashRow(row.dataset.path ?? path, row);
  // Already rendered — its ancestors are expanded. Checked first because it
  // also covers SAF vaults, whose node paths are opaque `saf:<docId>` values
  // that cannot be walked by prefix.
  const shown = rowElementFor(path);
  if (shown) {
    show(shown);
    return true;
  }
  const parts = segmentsUnderRoot(path);
  if (!parts || parts.length === 0 || !root.value) return false;
  const winPaths = isWindowsStylePath(root.value.path);
  let node: Node = root.value;
  for (const seg of parts.slice(0, -1)) {
    const dir = node.children?.find((c) => c.is_dir && sameName(c.name, seg, winPaths));
    if (!dir) return false;
    if (!dir.expanded) await expandDir(dir);
    node = dir;
  }
  if (!node.children?.some((c) => samePath(c.path, path))) return false;
  await nextTick();
  const row = rowElementFor(path);
  if (!row) return false;
  show(row);
  return true;
}

/** Serve a parked request, once the tree is in a position to answer it. */
async function serveRevealRequest() {
  const path = revealRequest.value;
  // A directory read is in flight — the request is served when it lands, so a
  // reveal that raced a workspace switch is not dropped.
  if (!path || !root.value || root.value.loading) return;
  clearRevealRequest();
  if (!(await revealRow(path))) toasts.warning(t('explorer.revealHidden'), 6000);
}

watch(
  [revealRequest, () => root.value?.path, () => root.value?.loading],
  () => {
    void serveRevealRequest();
  },
  // `immediate` matters: the tree is `v-if`'d on the sidebar toggle, so a
  // reveal can arrive (and park) while this component does not exist yet —
  // a request that is already set when the tree mounts would otherwise never
  // be seen, because a non-immediate watcher only reacts to later changes.
  { immediate: true },
);

// #333 — follow the active document. Switching tabs (or opening a file)
// expands the folders above it and brings its row into view, the way an IDE's
// "always select opened file" does; the row is already highlighted because
// the active file is the selection (see `selected` above). Quiet on purpose:
// no flash, no toast when the file is filtered out, and never a workspace
// re-root — a document outside the open folder is simply not followed. Only
// the tab changing triggers it, so the tree is not yanked back while the user
// scrolls it.
watch(
  [() => tabs.activeTab?.filePath, () => root.value?.path, () => root.value?.loading],
  ([path, , loading]) => {
    if (!settings.explorerFollowActive || !path || loading || !root.value) return;
    if (segmentsUnderRoot(path) === null && !rowElementFor(path)) return;
    void revealRow(path, true).then((ok) => {
      // A workspace load clears the selection (see the root watcher above),
      // which also dropped the highlight when the tab was opened before the
      // tree had listed. The followed file is inside this tree, so it is the
      // selection again.
      if (ok && samePath(tabs.activeTab?.filePath, path)) selected.value = { path, isDir: false };
    });
  },
  { immediate: true },
);

// #338 — the "new file in selected folder" shortcut. Same parked-request
// shape as the reveal above: served once the root has listed.
watch(
  [newFileInTreeRequest, () => root.value?.path, () => root.value?.loading],
  () => {
    if (!newFileInTreeRequest.value || !root.value || root.value.loading) return;
    clearNewFileInTreeRequest();
    void startNewFile(newEntryParent());
  },
  { immediate: true },
);

/** #342 — in manual mode, the top or bottom edge of a sibling row of the
 *  same kind (folder among folders, file among files) means "put it here".
 *  A folder's middle band still means "move into it", so both gestures stay
 *  available; a file row is split in half, since dropping into a file isn't
 *  a thing. Anything else returns null and falls through to the move logic. */
function reorderAt(
  x: number,
  y: number,
  from: string,
  fromIsDir: boolean,
): { path: string; pos: 'before' | 'after' } | null {
  if (sortMode.value !== 'manual') return null;
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const row = el?.closest('.ftree__item') as HTMLElement | null;
  const target = row?.dataset.path;
  if (!row || !target || target === from) return null;
  const rowIsDir = row.dataset.dir === '1';
  if (rowIsDir !== fromIsDir) return null;
  if (parentDir(target) !== parentDir(from)) return null;
  const r = row.getBoundingClientRect();
  const frac = (y - r.top) / Math.max(1, r.height);
  if (rowIsDir) {
    if (frac < 0.25) return { path: target, pos: 'before' };
    if (frac > 0.75) return { path: target, pos: 'after' };
    return null;
  }
  return { path: target, pos: frac < 0.5 ? 'before' : 'after' };
}

async function applyReorder(from: string, target: { path: string; pos: 'before' | 'after' }) {
  const parent = parentDir(from);
  const parentNode = parent === root.value?.path ? root.value : findNode(parent);
  if (!parentNode?.children) return;
  const next = reorderedNames(parentNode.children, baseName(from), baseName(target.path), target.pos);
  if (!next) return;
  manualOrder.value = { ...manualOrder.value, [orderKey(parent)]: next };
  parentNode.children = sortChildren(parent, parentNode.children);
  await saveManualOrder();
}

/** Which folder the pointer is currently over, or null. Files are not drop
 *  targets: filing into a file's parent reads as "dropped into the file" and
 *  there is no honest way to highlight that. */
function destinationAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  const row = el.closest('.ftree__item') as HTMLElement | null;
  if (row) return row.dataset.dir === '1' ? (row.dataset.path ?? null) : null;
  // The workspace row and the empty space under the tree both mean "the
  // vault root" — otherwise there is no way to drag something back to the top.
  if (el.closest('.ftree__root') || el.closest('.ftree__section') || el.closest('.ftree__list')) {
    return root.value?.path ?? null;
  }
  return null;
}

/** Spring-loaded folders: resting on a collapsed folder opens it, so a drag
 *  can reach a nested target without being abandoned halfway. */
function armAutoExpand(dest: string | null) {
  if (dest === expandArmedFor) return;
  expandArmedFor = dest ?? '';
  if (expandTimer) clearTimeout(expandTimer);
  expandTimer = null;
  if (!dest) return;
  const node = findNode(dest);
  if (!node || !node.is_dir || node.expanded) return;
  expandTimer = setTimeout(() => {
    expandTimer = null;
    if (dragActive && !node.expanded) void expandDir(node);
  }, AUTO_EXPAND_MS);
}

/** The element that actually scrolls the rows: the tree's own body when it
 *  stands alone, the sidebar's scroll area when embedded. */
function scrollHost(): HTMLElement | null {
  let el: HTMLElement | null = treeBody.value;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return treeBody.value;
}

function autoScroll(y: number) {
  const body = scrollHost();
  if (!body) return;
  const r = body.getBoundingClientRect();
  if (y < r.top + SCROLL_EDGE) body.scrollTop -= 12;
  else if (y > r.bottom - SCROLL_EDGE) body.scrollTop += 12;
}

/** Mouse only. On a touchscreen a press-and-drag over a scrollable list is
 *  a scroll, so touch users get "Move to…" instead of a drag they'd trigger
 *  by accident. */
function onNodePress(e: PointerEvent, node: Node) {
  // Clear any suppression left over from a previous drag BEFORE deciding
  // whether this press starts one. When a drag ends on a different row than
  // it started on, the browser dispatches the trailing `click` on the two
  // rows' common ancestor — the <ul> — so no row handler ever consumes the
  // flag, and without this it would swallow the user's *next* click instead.
  suppressClick.value = false;
  if (e.pointerType === 'touch' || e.pointerType === 'pen') {
    startLongPress(e, node);
    return;
  }
  if (e.button !== 0 || e.pointerType !== 'mouse' || !canMove.value) return;
  pointerStart = { x: e.clientX, y: e.clientY, node };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragUp);
  window.addEventListener('pointercancel', onDragCancel);
  window.addEventListener('keydown', onDragKey, true);
  window.addEventListener('blur', onDragCancel);
}

// #361 — the drag ghost. A label that follows the pointer and says, in
// words, what letting go will do: "Move to <folder>", "Place before/after
// <file>", "Already in <folder>" or "Can't move here". The insertion line and
// the folder ring stay; the ghost is what makes them readable. It never takes
// pointer events (hit-testing above uses elementFromPoint, which would
// otherwise find the ghost instead of the row under it) and it is moved with
// a transform, not top/left, so following the pointer never triggers layout.

const GHOST_OFFSET_X = 14;
const GHOST_OFFSET_Y = 18;
const GHOST_MARGIN = 8; // px the ghost keeps from every viewport edge

const dragGhost = ref<{ name: string; isDir: boolean; action: string; invalid: boolean } | null>(
  null,
);
const ghostPos = ref({ x: 0, y: 0 });
const ghostEl = ref<HTMLElement | null>(null);

/** What a release at this point would do, in the words the ghost shows.
 *  Mirrors onDragUp exactly: reorder wins, then a legal destination; every
 *  other spot is a release that does nothing, and says so. */
function describeDrop(
  from: string,
  reorder: { path: string; pos: 'before' | 'after' } | null,
  dest: string | null,
): { action: string; invalid: boolean } {
  if (reorder) {
    const name = baseName(reorder.path);
    return {
      action: reorder.pos === 'before'
        ? t('explorer.dragPlaceBefore', { name })
        : t('explorer.dragPlaceAfter', { name }),
      invalid: false,
    };
  }
  const folderLabel = (p: string) => (p === root.value?.path ? rootLabel() : baseName(p));
  if (dest && canDropInto(from, dest)) {
    return { action: t('explorer.dragMoveInto', { name: folderLabel(dest) }), invalid: false };
  }
  // A folder hovered over the folder it already lives in (or a file over the
  // blank space of its own folder) is a no-op, not an error — say where it is.
  if (dest && dest !== from && parentDir(from) === dest) {
    return { action: t('explorer.dragAlreadyIn', { name: folderLabel(dest) }), invalid: true };
  }
  return { action: t('explorer.dragCannotMove'), invalid: true };
}

/** Top-left of the ghost for a pointer at (x, y): below-right of the cursor,
 *  flipped to the other side when that would run off the viewport, and then
 *  clamped so it is always fully on screen. Size is read from the rendered
 *  ghost (the previous frame's, which is the same text or one line off). */
function placeGhost(x: number, y: number) {
  const w = ghostEl.value?.offsetWidth ?? 180;
  const h = ghostEl.value?.offsetHeight ?? 40;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let gx = x + GHOST_OFFSET_X;
  let gy = y + GHOST_OFFSET_Y;
  if (gx + w > vw - GHOST_MARGIN) gx = x - GHOST_OFFSET_X - w;
  if (gy + h > vh - GHOST_MARGIN) gy = y - GHOST_OFFSET_Y - h;
  gx = Math.min(Math.max(GHOST_MARGIN, gx), Math.max(GHOST_MARGIN, vw - GHOST_MARGIN - w));
  gy = Math.min(Math.max(GHOST_MARGIN, gy), Math.max(GHOST_MARGIN, vh - GHOST_MARGIN - h));
  ghostPos.value = { x: Math.round(gx), y: Math.round(gy) };
}

/** The rows set `cursor: pointer`, which beats anything inherited from
 *  <body> — that is why the reporter only ever saw the hand. A class on
 *  <html> plus an !important rule in the unscoped style block below wins
 *  over every row, button and scrollbar for the length of the drag. */
function setDragCursor(state: 'grab' | 'invalid' | null) {
  const cl = document.documentElement.classList;
  cl.toggle('solomd-tree-dragging', state !== null);
  cl.toggle('solomd-tree-drag-invalid', state === 'invalid');
}

function onDragKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  const wasDrag = dragActive;
  teardownDrag();
  if (!wasDrag) return;
  // Esc is the drag's, not the editor's or a dialog's.
  e.preventDefault();
  e.stopPropagation();
  // The pointer is still down; its eventual click must not open the row it
  // happens to be released over.
  suppressClick.value = true;
}

function onDragMove(e: PointerEvent) {
  if (!pointerStart) return;
  if (!dragActive) {
    const moved = Math.abs(e.clientX - pointerStart.x) + Math.abs(e.clientY - pointerStart.y);
    if (moved < DRAG_THRESHOLD) return;
    dragActive = true;
    dragPath.value = pointerStart.node.path;
    dragIsDir.value = !!pointerStart.node.is_dir;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    dragGhost.value = {
      name: pointerStart.node.name || baseName(pointerStart.node.path),
      isDir: !!pointerStart.node.is_dir,
      action: '',
      invalid: false,
    };
  }
  const from = dragPath.value ?? '';
  const reorder = reorderAt(e.clientX, e.clientY, from, dragIsDir.value);
  reorderTarget.value = reorder;
  const dest = reorder ? null : destinationAt(e.clientX, e.clientY);
  const legal = dest && canDropInto(from, dest) ? dest : null;
  dropTarget.value = legal;
  armAutoExpand(legal);
  autoScroll(e.clientY);

  const { action, invalid } = describeDrop(from, reorder, dest);
  if (dragGhost.value) {
    dragGhost.value.action = action;
    dragGhost.value.invalid = invalid;
  }
  setDragCursor(invalid ? 'invalid' : 'grab');
  placeGhost(e.clientX, e.clientY);
}

function teardownDrag() {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragUp);
  window.removeEventListener('pointercancel', onDragCancel);
  window.removeEventListener('keydown', onDragKey, true);
  window.removeEventListener('blur', onDragCancel);
  if (expandTimer) clearTimeout(expandTimer);
  expandTimer = null;
  expandArmedFor = '';
  pointerStart = null;
  dragActive = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  setDragCursor(null);
  dragGhost.value = null;
  endDrag();
}

function onDragCancel() {
  teardownDrag();
}

function onDragUp() {
  const from = dragPath.value;
  const dest = dropTarget.value;
  const reorder = reorderTarget.value;
  const isDir = dragIsDir.value;
  const wasDrag = dragActive;
  teardownDrag();
  if (!wasDrag) return;
  // The click that follows this pointerup belongs to the drag, not to the row.
  suppressClick.value = true;
  if (from && reorder) void applyReorder(from, reorder);
  else if (from && dest) void moveNode(from, dest, isDir);
}

async function commitEdit() {
  const e = editing.value;
  if (!e) return;
  const name = e.name.trim();
  if (!name) {
    editing.value = null;
    return;
  }
  try {
    if (e.kind === 'new-file') {
      // Default to .md when the user didn't type an extension — we only
      // edit md/txt anyway, so this is the right bias.
      const finalName = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`;
      // #148 — SAF vault: create the file via ContentResolver and open its
      // content-URI, not a std::fs path.
      if (isSafPath(e.parent) && workspace.safTreeUri) {
        const { toSafPath } = await import('../lib/saf-fs');
        const newDocId = await safCreate(workspace.safTreeUri, fromSafPath(e.parent), finalName);
        editing.value = null;
        scheduleRefresh();
        await files.openPath(toSafPath(newDocId), { bypassNewWindow: true });
        return;
      }
      const target = joinPath(e.parent, finalName);
      // A pending delete on this exact path would fire later and take the new
      // file with it. Commit it now so the two never race.
      await pendingDeletes.flushUnder(target);
      await invoke('fs_create_file', { path: target, content: '' });
      editing.value = null;
      scheduleRefresh();
      await files.openPath(target, { bypassNewWindow: true });
    } else if (e.kind === 'new-dir') {
      await pendingDeletes.flushUnder(joinPath(e.parent, name));
      await invoke('fs_create_dir', { path: joinPath(e.parent, name) });
      editing.value = null;
      scheduleRefresh();
    } else if (e.kind === 'rename' && e.original) {
      const target = joinPath(e.parent, name);
      if (target === e.original) {
        editing.value = null;
        return;
      }
      await pendingDeletes.flushUnder(target);
      await invoke('fs_rename', { from: e.original, to: target });
      editing.value = null;
      // #342 — a renamed child keeps its hand-placed position.
      const key = orderKey(e.parent);
      if (manualOrder.value[key]?.includes(baseName(e.original))) {
        manualOrder.value = {
          ...manualOrder.value,
          [key]: renameInOrder(manualOrder.value[key], baseName(e.original), name),
        };
        void saveManualOrder();
      }
      scheduleRefresh();
      // v4.3.5 — if the renamed file is open in a tab, the tab follows it.
      // repointTab is shared with the move path: it keeps a dirty tab's
      // unsaved edits and reloads a clean one, which picks up any per-file
      // `.assets/` link rewrite the rename triggered (#91).
      try {
        const tab = tabs.tabs.find((t: { filePath?: string }) => t.filePath === e.original);
        if (tab) await repointTab(tab, target);
      } catch (err) {
        console.warn('[FileTree.rename] tab refresh failed', err);
      }
    }
  } catch (err) {
    toasts.error(String(err));
  }
}

function cancelEdit() {
  refocusAfterEdit = true;
  editing.value = null;
}

// ---------------------------------------------------------------------------
// #355 — F2 renames, Delete (⌘⌫ on macOS) deletes the selected row, the way
// Explorer / Finder / VS Code do. Tree-scoped on purpose: the listener is on
// the tree's own element, so the keys only mean "file" while keyboard focus
// is in the tree — in the editor, Delete keeps deleting text. That is also
// why these are not in the rebindable table (lib/keybindings.ts): every
// action there is dispatched from a window-level handler, whatever has focus.
// Both keys go through the very functions the context menu calls, so the
// confirmation dialog, the undo toast and the inline rename are the same.
// ---------------------------------------------------------------------------
const treeEl = ref<HTMLElement | null>(null);
const macKeys = usesCommandKey();
const renameKbd = 'F2';
const deleteKbd = computed(() => (macKeys ? '⌘⌫' : t('explorer.deleteKey')));

/** Put keyboard focus back on the tree, after the editor's own deferred
 *  focus has run.
 *  - 'fromEditor': a click opened a file and the editor took focus on open.
 *    Anything else that took it (a dialog, the palette) keeps it.
 *  - 'ifLost': the inline rename box went away under the caret (Enter /
 *    Escape) and focus fell to <body>. A blur-commit because the user clicked
 *    into the editor must leave the editor focused. */
function refocusTree(mode: 'fromEditor' | 'ifLost') {
  const run = () => {
    const el = treeEl.value;
    if (!el) return;
    const now = document.activeElement;
    const lost = !now || now === document.body;
    const editorGrab = !!now && !!now.closest('.cm-editor, .editor, textarea');
    if (lost || (mode === 'fromEditor' && editorGrab)) {
      el.focus({ preventScroll: true });
    }
  };
  // Timers, not requestAnimationFrame: rAF is paused while the window is in
  // the background, and the editor's focus lands in the same task as the
  // open (nextTick) or shortly after, when the editor mounts for a new tab.
  setTimeout(run, 0);
  if (mode === 'fromEditor') setTimeout(run, 150);
}

// Enter / Escape in the inline box: once the box is gone (the commit awaits
// the rename first), the keyboard is back in the tree rather than on <body>.
let refocusAfterEdit = false;
watch(editing, (e) => {
  if (e || !refocusAfterEdit) return;
  refocusAfterEdit = false;
  refocusTree('ifLost');
});

/** Move the keyboard into the active document's editor (either engine). */
function focusEditor() {
  const run = () => {
    const pane =
      document.querySelector('.pane-content .pane--editor:focus-within') ??
      document.querySelector('.pane--editor');
    const target = pane?.querySelector<HTMLElement>(
      '.cm-content, .plain-block--active textarea, .plain-editor',
    );
    target?.focus({ preventScroll: true });
  };
  // After the pending refocusTree() timers (0 / 150 ms) from the click.
  setTimeout(run, 200);
}

function isDeleteChord(e: KeyboardEvent): boolean {
  if (e.altKey || e.shiftKey) return false;
  if (e.key === 'Delete') return !e.ctrlKey && !e.metaKey;
  // Finder's Move to Trash. ⌘ only — Ctrl+Backspace is word-delete elsewhere.
  return macKeys && e.key === 'Backspace' && e.metaKey && !e.ctrlKey;
}

function onTreeKey(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
  const target = e.target as HTMLElement | null;
  // The inline rename box, the filter popover's inputs… type normally there.
  if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
  if (editing.value || deleteTarget.value) return;
  // Enter on a file: open it (if the click hasn't already) and hand the
  // keyboard to the editor — the keyboard way out of the tree.
  if (e.key === 'Enter' && !e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    const sel = selected.value;
    if (sel && !sel.isDir) {
      e.preventDefault();
      e.stopPropagation();
      void (async () => {
        if (tabs.activeTab?.filePath !== sel.path) await files.openPath(sel.path, { fromTree: true });
        focusEditor();
      })();
    }
    return;
  }
  const isRename = e.key === 'F2' && !e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey;
  const isDelete = !isRename && isDeleteChord(e);
  if (!isRename && !isDelete) return;
  const sel = selected.value;
  const node = sel ? findNode(sel.path) : null;
  if (!node) return;
  e.preventDefault();
  e.stopPropagation();
  if (isRename) void startRename(node);
  else deleteNode(node);
}

// CJK / IME guard for the rename / new-file inline input. Mirrors the pattern
// used by AgentPanel.vue::onKeydown — while the user is mid-composition (e.g.
// typing pinyin and pressing Enter to commit an IME candidate), `isComposing`
// is true (or `keyCode === 229` on older engines) and the Enter belongs to
// the IME, not to us. Treating it as "commit" would rename/create the file
// before the candidate is inserted.
function onRenameKey(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter') {
    refocusAfterEdit = true;
    e.preventDefault();
    void commitEdit();
  }
}

// ---------------------------------------------------------------------------
// Delete — confirmed in the app, then held briefly so the toast can take it
// back.
//
// The confirmation used to be `window.confirm`, i.e. the webview's own dialog:
// unstyled next to everything else, suppressed outright on some platforms, and
// English-only. A mis-aimed right-click → Delete was also one keystroke away
// from losing a folder, so the confirmation has to be something the user
// really sees. It is a real dialog now (DsModal, which handles Escape, focus
// and the backdrop), with the file/folder wording and the trash-vs-permanent
// note coming from the locale files.
// ---------------------------------------------------------------------------
const deleteTarget = ref<Node | null>(null);

function deleteNode(node: Node) {
  closeCtx();
  deleteTarget.value = node;
}

async function confirmDelete() {
  const node = deleteTarget.value;
  deleteTarget.value = null;
  if (!node) return;

  // The delete is held for a few seconds so the toast can offer Undo. The
  // file is untouched until then; the tree hides it in the meantime.
  const path = node.path;
  const name = node.name;
  await pendingDeletes.schedule({
    path,
    name,
    isDir: !!node.is_dir,
    delayMs: UNDO_WINDOW_MS,
    commit: async () => {
      try {
        await invoke('fs_delete', { path });
      } catch (e) {
        toasts.error(t('toast.deleteFailed', { error: String(e) }));
      }
      scheduleRefresh();
    },
  });
  scheduleRefresh();
  toasts.push(t('explorer.deleted', { name }), 'success', UNDO_WINDOW_MS, () => {
    if (!pendingDeletes.undo(path)) return;
    scheduleRefresh();
    toasts.info(t('explorer.deleteUndone', { name }));
  }, { actionLabel: t('explorer.undo') });
}

async function revealNode(node: Node) {
  closeCtx();
  try {
    await revealInFileManager(node.path);
  } catch (e) {
    toasts.error(`${e}`);
  }
}

// v4.3.5 — workspace switcher dropdown state.
const switcherOpen = ref(false);

/** Recent folders rendered into the dropdown. Splits each path into the
 *  basename (display) and the parent dir (subtitle), so two folders named
 *  `notes/` from different drives are distinguishable. The current folder
 *  always appears at the top, even if it isn't yet in `recentFolders` —
 *  defends against the (rare) case where session restore set
 *  `currentFolder` without going through `setFolder`. */
const switcherList = computed(() => {
  const seen = new Set<string>();
  const out: Array<{ path: string; name: string; parent: string }> = [];
  const push = (p: string) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    const parts = p.split(/[\\/]/).filter(Boolean);
    const name = parts.length > 0 ? parts[parts.length - 1] : p;
    const parent = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    out.push({ path: p, name, parent });
  };
  if (workspace.currentFolder) push(workspace.currentFolder);
  for (const p of workspace.recentFolders) push(p);
  return out;
});

function toggleSwitcher(ev?: Event) {
  switcherOpen.value = !switcherOpen.value;
  sortOpen.value = false;
  filterOpen.value = false;
  if (switcherOpen.value) anchorPop(ev, true);
}
function closeSwitcher() {
  switcherOpen.value = false;
}
async function pickRecentFolder(path: string) {
  closeSwitcher();
  if (path === workspace.currentFolder) return;
  workspace.setFolder(path);
}
async function openFolderAndClose() {
  closeSwitcher();
  await files.openFolder();
}
/** #118 — close the current workspace folder (return to the no-folder state).
 *  `setFolder(null)` is already a supported "closed workspace" state; this just
 *  exposes it, since previously a folder once opened could never be closed. */
function closeFolder() {
  closeSwitcher();
  workspace.setFolder(null);
}

// Close the context menu on any outside click / escape.
function onWindowClick() {
  filterOpen.value = false;
  sortOpen.value = false;
  if (switcherOpen.value) closeSwitcher();
  if (!ctx.value) return;
  // The click that ends the long-press which opened the menu.
  if (Date.now() - ctxOpenedAt < 700) return;
  closeCtx();
}
function onWindowKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    closeCtx();
    closeSwitcher();
    filterOpen.value = false;
    sortOpen.value = false;
    if (editing.value) editing.value = null;
  }
}
onMounted(() => {
  window.addEventListener('click', onWindowClick);
  window.addEventListener('keydown', onWindowKey);
});
onBeforeUnmount(() => {
  cancelLongPress();
  window.removeEventListener('click', onWindowClick);
  window.removeEventListener('keydown', onWindowKey);
  // A tree unmounted mid-drag (workspace switch, sidebar hidden) must not
  // leave the ghost, the cursor override or the window listeners behind.
  if (pointerStart || dragActive) teardownDrag();
});
</script>

<template>
  <aside
    ref="treeEl"
    class="ftree"
    tabindex="-1"
    @keydown="onTreeKey"
    :class="{ 'ftree--fullnames': settings.explorerFullNames, 'ftree--embedded': props.embedded }"
    :style="props.embedded ? undefined : { '--file-tree-width': settings.fileTreeWidth + 'px' }"
    @contextmenu.prevent="openCtx($event, null)"
  >
    <div v-if="!root" class="ftree__empty">
      <button class="ftree__open-btn" @click="files.openFolder">{{ t('explorer.openFolder') }}</button>
    </div>
    <div v-else ref="treeBody" class="ftree__body">
      <!-- 5.0 section row (spec §4). The label doubles as the workspace
           switcher; the icon buttons on the right appear on hover, and stay
           visible while their popover is open or their state is non-default
           (a persisted sort / filter must never be invisible). It is also the
           "vault root" drop target and right-click target, as the old root
           pill was. -->
      <div
        class="ftree__section"
        :class="{
          'ftree__section--active': switcherOpen || sortOpen || filterOpen,
          'ftree__section--drop': dropTarget === root.path,
        }"
        @contextmenu.prevent.stop="openCtx($event, root)"
      >
        <button
          class="ftree__ws"
          :class="{ 'ftree__ws--open': switcherOpen }"
          type="button"
          aria-haspopup="menu"
          :aria-expanded="switcherOpen"
          :title="(t('explorer.switchWorkspace') || 'Switch workspace') + ' · ' + root.path"
          @click.stop="toggleSwitcher($event)"
        >
          <span class="ftree__section-label">{{ t('sidebar.folders') }}</span>
          <span class="ftree__ws-name">{{ rootDisplayName }}</span>
          <Icon name="chevron-down" :size="12" class="ftree__ws-caret" />
        </button>
        <div class="ftree__tools">
          <button
            class="ftree__tool"
            type="button"
            :title="t('explorer.newFile') || 'New file'"
            :aria-label="t('explorer.newFile') || 'New file'"
            @click.stop="startNewFile(newEntryParent())"
          >
            <Icon name="plus" :size="16" />
          </button>
          <button
            class="ftree__tool"
            type="button"
            :class="{ 'ftree__tool--on': sortMode !== 'name-asc', 'ftree__tool--open': sortOpen }"
            :title="(t('explorer.sortBy') || 'Sort') + ' · ' + sortLabel(sortMode)"
            :aria-label="t('explorer.sortBy') || 'Sort'"
            aria-haspopup="menu"
            :aria-expanded="sortOpen"
            @click.stop="toggleSortMenu($event)"
          >
            <Icon name="sort" :size="16" />
          </button>
          <button
            v-if="localVault"
            class="ftree__tool"
            type="button"
            :class="{ 'ftree__tool--on': extFilter.length > 0, 'ftree__tool--open': filterOpen }"
            :title="t('explorer.filterByType') || 'Filter by file type'"
            :aria-label="t('explorer.filterByType') || 'Filter by file type'"
            aria-haspopup="menu"
            :aria-expanded="filterOpen"
            @click.stop="openFilter($event)"
          >
            <Icon name="filter" :size="16" />
          </button>
          <button
            class="ftree__tool"
            type="button"
            :title="t('explorer.refresh') || 'Refresh'"
            :aria-label="t('explorer.refresh') || 'Refresh'"
            @click.stop="scheduleRefresh"
          >
            <Icon name="refresh" :size="16" />
          </button>
        </div>
      </div>

      <!-- Popovers: one menu style (spec §6), fixed-positioned under the
           button that opened them. -->
      <div
        v-if="switcherOpen"
        class="ftree__menu ftree__menu--switcher"
        role="menu"
        :style="{ left: popPos.x + 'px', top: popPos.y + 'px' }"
        @click.stop
      >
        <div class="ftree__menu-label">{{ t('explorer.recentFolders') }}</div>
        <button
          v-for="folder in switcherList"
          :key="folder.path"
          class="ftree__menu-item ftree__menu-item--two"
          :class="{ 'ftree__menu-item--active': folder.path === root.path }"
          role="menuitemradio"
          :aria-checked="folder.path === root.path"
          :title="folder.path"
          @click="pickRecentFolder(folder.path)"
        >
          <span class="ftree__menu-check">{{ folder.path === root.path ? '✓' : '' }}</span>
          <span class="ftree__menu-text">
            <span class="ftree__switcher-name">{{ folder.name }}</span>
            <span class="ftree__switcher-path">{{ folder.parent }}</span>
          </span>
        </button>
        <div v-if="switcherList.length === 0" class="ftree__menu-empty">
          {{ t('explorer.noRecentFolders') }}
        </div>
        <div class="ftree__menu-sep"></div>
        <button class="ftree__menu-item" role="menuitem" @click="openFolderAndClose">
          <span class="ftree__menu-check"></span>
          <span class="ftree__menu-name">{{ t('explorer.openFolder') }}</span>
        </button>
        <button
          v-if="workspace.currentFolder"
          class="ftree__menu-item"
          role="menuitem"
          @click="closeFolder"
        >
          <span class="ftree__menu-check"></span>
          <span class="ftree__menu-name">{{ t('explorer.closeFolder') }}</span>
        </button>
      </div>
      <div
        v-if="sortOpen"
        class="ftree__menu"
        role="menu"
        :style="{ left: popPos.x + 'px', top: popPos.y + 'px' }"
        @click.stop
      >
        <div class="ftree__menu-label">{{ t('explorer.sortBy') || 'Sort' }}</div>
        <button
          v-for="m in TREE_SORT_MODES"
          :key="m"
          class="ftree__menu-item"
          :class="{ 'ftree__menu-item--active': sortMode === m }"
          role="menuitemradio"
          :aria-checked="sortMode === m"
          :disabled="m === 'manual' && !localVault"
          @click="setSortMode(m)"
        >
          <span class="ftree__menu-check">{{ sortMode === m ? '✓' : '' }}</span>
          <span class="ftree__menu-name">{{ sortLabel(m) }}</span>
        </button>
        <div v-if="sortMode === 'manual'" class="ftree__menu-empty">
          {{ t('explorer.sortManualHint') }}
        </div>
      </div>
      <div
        v-if="filterOpen"
        class="ftree__menu ftree__menu--scroll"
        role="menu"
        :style="{ left: popPos.x + 'px', top: popPos.y + 'px' }"
        @click.stop
      >
        <div class="ftree__menu-label">{{ t('explorer.filterByType') || 'Filter by file type' }}</div>
        <button
          class="ftree__menu-item"
          :class="{ 'ftree__menu-item--active': extFilter.length === 0 }"
          role="menuitemcheckbox"
          :aria-checked="extFilter.length === 0"
          @click="settings.clearExplorerExtFilter()"
        >
          <span class="ftree__menu-check">{{ extFilter.length === 0 ? '✓' : '' }}</span>
          <span class="ftree__menu-name">{{ t('explorer.filterAll') || 'All files' }}</span>
        </button>
        <div class="ftree__menu-sep"></div>
        <button
          v-for="e in extList"
          :key="e.ext || '__noext__'"
          class="ftree__menu-item"
          :class="{ 'ftree__menu-item--active': extFilter.includes(e.ext) }"
          role="menuitemcheckbox"
          :aria-checked="extFilter.includes(e.ext)"
          @click="settings.toggleExplorerExt(e.ext)"
        >
          <span class="ftree__menu-check">{{ extFilter.includes(e.ext) ? '✓' : '' }}</span>
          <span class="ftree__menu-name">{{ extLabel(e.ext) }}</span>
          <span class="ftree__menu-count">{{ e.count }}</span>
        </button>
        <div v-if="extList.length === 0" class="ftree__menu-empty">
          {{ t('explorer.filterNoTypes') || 'Nothing to filter yet.' }}
        </div>
      </div>

      <!-- The folder itself is gone (moved in Finder, deleted, drive
           unmounted). Saying so beats an empty tree under its own name,
           which reads as "my notes are gone". -->
      <div v-if="rootMissing" class="ftree__missing">
        <p class="ftree__missing-title">{{ t('explorer.folderMissing') }}</p>
        <p class="ftree__missing-path">{{ root.path }}</p>
        <p v-if="rootError" class="ftree__missing-path">{{ rootError }}</p>
        <div class="ftree__missing-actions">
          <button class="ftree__open-btn" @click="files.openFolder">
            {{ t('explorer.folderMissingLocate') }}
          </button>
          <button class="ftree__missing-secondary" @click="workspace.setFolder(null)">
            {{ t('explorer.closeFolder') }}
          </button>
        </div>
      </div>

      <!-- Inline new/rename input. Normally drawn in the tree itself (#321,
           see renderEditRow); here only when a filter hides its target. -->
      <div v-if="editing && !editInTree" class="ftree__edit">
        <span class="ftree__icon"><Icon :name="editing.kind === 'new-dir' ? 'folder-sm' : 'file'" :size="16" /></span>
        <input
          ref="editInput"
          v-model="editing.name"
          class="ftree__edit-input"
          spellcheck="false"
          @keydown="onRenameKey"
          @keydown.escape.prevent="cancelEdit"
          @blur="commitEdit"
        />
      </div>

      <!-- v2.4 / v4.6 F6: Inbox row — standalone tree only. Inside the 5.0
           sidebar the Inbox lives in the nav rows above (Sidebar.vue), which
           also carries the inbox-only filter toggle. -->
      <div
        v-if="settings.inboxWorkflowEnabled && !props.embedded"
        class="ftree__inbox"
        :class="{ 'ftree__inbox--active': showInboxOnly }"
      >
        <button
          class="ftree__inbox-toggle"
          :title="showInboxOnly ? t('inbox.filterOff') : t('inbox.filterOn')"
          @click="inbox.toggleFilter()"
        >
          <Icon :name="showInboxOnly ? 'chevron-down' : 'chevron-right'" :size="12" />
        </button>
        <button
          class="ftree__inbox-open"
          :title="t('inbox.openView')"
          @click="inboxView.openInbox()"
        >
          <span class="ftree__name">{{ t('inbox.heading') }}</span>
        </button>
        <span class="ftree__badge" v-if="inbox.inboxCount.value > 0">
          {{ inbox.inboxCount.value }}
        </span>
      </div>

      <!-- The inbox-only filter hides files too: same rule as below. -->
      <div v-if="showInboxOnly" class="ftree__filter-banner">
        <span class="ftree__filter-banner-text">{{ t('sidebar.inboxFilterActive') }}</span>
        <button class="ftree__filter-banner-clear" @click="inbox.setFilter(false)">
          {{ t('explorer.filterClear') || 'Clear' }}
        </button>
      </div>

      <!-- A persisted filter that hides files must never be invisible. -->
      <div v-if="extFilter.length" class="ftree__filter-banner">
        <span class="ftree__filter-banner-text">
          {{ t('explorer.filterActive', { types: filterLabel }) }}
        </span>
        <button class="ftree__filter-banner-clear" @click="settings.clearExplorerExtFilter()">
          {{ t('explorer.filterClear') || 'Clear' }}
        </button>
      </div>

      <div v-if="root.loading" class="ftree__loading">
        <span class="ftree__spinner" aria-hidden="true"></span>
        <span>{{ t('explorer.loading') }}</span>
      </div>
      <ul v-else class="ftree__list" :class="{ 'ftree__list--drop': dropTarget === root.path }">
        <FileTreeNode
          v-for="child in root.children"
          :key="child.path"
          :node="child"
          :depth="0"
          :selected-path="selected?.path ?? ''"
          :inbox-only="showInboxOnly"
          :inbox-paths="inbox.inboxPaths.value"
          :ext-filter="extFilter"
          :filter-dirs="filterDirs"
          @toggle="toggle"
          @contextmenu="openCtx"
          @press="onNodePress"
        />
        <EditRowAtRoot
          v-if="editInTree && editing && editing.kind !== 'rename' && editing.parent === root.path"
        />
        <li v-if="root.truncated" class="ftree__truncated" :title="t('explorer.truncatedHint')">
          {{ t('explorer.truncated') }}
        </li>
      </ul>
    </div>

    <!-- Context menu — absolute-positioned floating div. Items vary by
         whether the click landed on a file, a folder, or empty area. -->
    <div
      v-if="ctx"
      ref="ctxEl"
      class="ftree__menu ftree__ctx"
      role="menu"
      :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }"
      @click.stop
    >
      <template v-if="!ctx.node || ctx.node.is_dir">
        <button class="ftree__ctx-item" @click="startNewFile(ctx.node ? ctx.node.path : newEntryParent())">
          {{ t('explorer.newFile') || 'New File' }}
        </button>
        <button class="ftree__ctx-item" @click="startNewFolder(ctx.node ? ctx.node.path : newEntryParent())">
          {{ t('explorer.newFolder') || 'New Folder' }}
        </button>
      </template>
      <!-- Only between the "new file / folder" section (folders) and the rest:
           on a file the menu would otherwise open with an empty divider. -->
      <div v-if="ctx.node && ctx.node.is_dir" class="ftree__ctx-sep"></div>
      <button
        v-if="ctx.node"
        class="ftree__ctx-item ftree__ctx-item--kbd"
        aria-keyshortcuts="F2"
        @click="startRename(ctx.node)"
      >
        <span>{{ t('explorer.rename') || 'Rename' }}</span>
        <kbd v-if="!isMobile()" class="ftree__ctx-kbd">{{ renameKbd }}</kbd>
      </button>
      <button
        v-if="ctx.node && canMove && ctx.node.path !== root?.path"
        class="ftree__ctx-item"
        @click="startMoveTo(ctx.node)"
      >
        {{ t('explorer.moveTo') || 'Move to…' }}
      </button>
      <button
        v-if="ctx.node"
        class="ftree__ctx-item ftree__ctx-item--kbd ftree__ctx-item--danger"
        :aria-keyshortcuts="macKeys ? 'Meta+Backspace' : 'Delete'"
        @click="deleteNode(ctx.node)"
      >
        <span>{{ t('explorer.delete') || 'Delete' }}</span>
        <kbd v-if="!isMobile()" class="ftree__ctx-kbd">{{ deleteKbd }}</kbd>
      </button>
      <div v-if="ctx.node" class="ftree__ctx-sep"></div>
      <button v-if="ctx.node" class="ftree__ctx-item" @click="copyNodePath(ctx.node)">
        {{ t('explorer.copyPath') || 'Copy Path' }}
      </button>
      <button v-if="ctx.node" class="ftree__ctx-item" @click="copyNodeRelativePath(ctx.node)">
        {{ t('explorer.copyRelPath') || 'Copy Relative Path' }}
      </button>
      <button v-if="ctx.node && !ctx.node.is_dir" class="ftree__ctx-item" @click="copyGitUrl(ctx.node)">
        {{ t('explorer.copyGitUrl') || 'Copy Git URL' }}
      </button>
      <!-- #148 follow-up — hidden on mobile: revealItemInDir silently no-ops
           there (no user-reachable file manager can browse the app sandbox
           on Android, and iOS has no Finder), so the item just looked broken. -->
      <template v-if="!isMobile()">
        <div class="ftree__ctx-sep"></div>
        <button class="ftree__ctx-item" @click="revealNode(ctx.node ?? root!)">
          {{ t(revealLabelKey('explorer.reveal')) }}
        </button>
      </template>
    </div>

    <MoveToDialog
      :open="!!moveDialog"
      :node-name="moveDialog?.node.name ?? ''"
      :dirs="moveDialog?.dirs ?? []"
      :current-dir="moveDialog ? rootRelative(moveDialog.node.path).replace(/\/?[^/]+$/, '') : ''"
      :self-dir="moveDialog?.node.is_dir ? rootRelative(moveDialog.node.path) : null"
      @confirm="onMovePicked"
      @cancel="moveDialog = null"
    />

    <!-- Delete confirmation. In-app rather than `window.confirm`: the
         webview's dialog is unstyled, untranslated and suppressed outright on
         some platforms, and a mis-aimed right-click → Delete should not be one
         keystroke away from losing a folder. -->
    <DsModal
      :model-value="!!deleteTarget"
      :title="t('explorer.deleteTitle')"
      width="420px"
      @update:model-value="deleteTarget = null"
    >
      <p class="ftree__confirm-msg">
        {{
          deleteTarget?.is_dir
            ? t('explorer.deleteFolderMsg', { name: deleteTarget?.name ?? '' })
            : t('explorer.deleteFileMsg', { name: deleteTarget?.name ?? '' })
        }}
      </p>
      <!-- #112 — desktop deletes go to the OS trash and are recoverable; a
           phone has no user-visible trash, so the wording stays honest per
           platform. Server-side, the delete is also held briefly so the toast
           can undo it. -->
      <p class="ftree__confirm-note">
        {{ isMobile() ? t('explorer.deletePermanent') : t('explorer.deleteTrash') }}
      </p>
      <template #footer>
        <DsButton variant="ghost" @click="deleteTarget = null">{{ t('explorer.cancel') }}</DsButton>
        <DsButton variant="danger" @click="confirmDelete">{{ t('explorer.delete') }}</DsButton>
      </template>
    </DsModal>

    <!-- #361 — drag ghost: what releasing here will do. Teleported so no
         sidebar overflow/transform can clip or offset it. -->
    <Teleport to="body">
      <div
        v-if="dragGhost"
        ref="ghostEl"
        class="ftree-ghost"
        :class="{ 'ftree-ghost--invalid': dragGhost.invalid }"
        :style="{ transform: `translate3d(${ghostPos.x}px, ${ghostPos.y}px, 0)` }"
        role="status"
        aria-live="polite"
        data-testid="ftree-drag-ghost"
      >
        <div class="ftree-ghost__name">
          <Icon class="ftree-ghost__icon" :name="dragGhost.isDir ? 'folder-sm' : 'file'" :size="14" aria-hidden="true" />
          <span class="ftree-ghost__label">{{ dragGhost.name }}</span>
        </div>
        <div class="ftree-ghost__action">{{ dragGhost.action }}</div>
      </div>
    </Teleport>
  </aside>
</template>

<script lang="ts">
import { defineComponent, h, inject, type ComputedRef, type Ref, type VNode } from 'vue';
// Module scope: the setup script above uses these too.
import { isWindowsStylePath, sameName, samePath, segmentsBelow } from '../lib/path-key';

/** #321 — how FileTreeNode draws the inline new/rename row in place. */
export const FTREE_EDIT = Symbol('ftree-edit');
interface FtreeEditApi {
  editing: Ref<{ kind: 'new-file' | 'new-dir' | 'rename'; parent: string; original?: string } | null>;
  editInTree: ComputedRef<boolean>;
  renderEditRow: (depth: number) => VNode | null;
}

// The indent geometry, in one place (5.0: 16 px per level). A row's own left
// padding is `INDENT_BASE + depth * INDENT_STEP`; its 12 px chevron starts
// there, so level `i`'s guide line runs through the middle of that level's
// chevron, at `INDENT_BASE + i * INDENT_STEP + GUIDE_X`.
const INDENT_BASE = 6;
const INDENT_STEP = 16;
const GUIDE_X = 6;

/**
 * The visual tree: one dotted vertical line per ancestor level, plus the short
 * stub that joins the row to its parent's line. A flat list of names at
 * slightly different left offsets is hard to read once a vault nests a few
 * folders deep — the guides are what make a depth obvious at a glance.
 *
 * They are absolutely positioned so they cannot disturb the row's layout
 * (padding, gap, hit-testing for drags all stay exactly as they were), and
 * `pointer-events: none` keeps them out of the way of a click.
 */
function indentGuides(depth: number): VNode[] {
  if (depth <= 0) return [];
  const guides: VNode[] = [];
  for (let i = 0; i < depth; i++) {
    guides.push(
      h('i', {
        class: 'ftree__guide',
        style: { left: `${INDENT_BASE + i * INDENT_STEP + GUIDE_X}px` },
        'aria-hidden': 'true',
      }),
    );
  }
  guides.push(
    h('i', {
      class: 'ftree__stub',
      style: { left: `${INDENT_BASE + (depth - 1) * INDENT_STEP + GUIDE_X}px` },
      'aria-hidden': 'true',
    }),
  );
  return guides;
}

export const FileTreeNode = defineComponent({
  name: 'FileTreeNode',
  props: {
    node: { type: Object as () => any, required: true },
    depth: { type: Number, default: 0 },
    /** Path of the selected row, so FileTreeNode can tint it without holding
     *  any selection state of its own. */
    selectedPath: { type: String, default: '' },
    inboxOnly: { type: Boolean, default: false },
    inboxPaths: { type: Object as () => Set<string>, default: () => new Set() },
    /** #282 — lower-case extensions without the dot ('' = no extension).
     *  Empty means no filtering. */
    extFilter: { type: Array as () => string[], default: () => [] },
    /** Absolute paths of folders whose subtree holds a match, or null when
     *  no filter is active (or the backend walk failed — we fail open). */
    filterDirs: { type: Object as () => Set<string> | null, default: null },
  },
  emits: ['toggle', 'contextmenu', 'press'],
  setup(props, { emit }) {
    // #182 — the full-names toggle lives in settings; this inner component is
    // module-scoped so it can't close over <script setup>'s store instance.
    const nodeSettings = useSettingsStore();
    const edit = inject<FtreeEditApi | null>(FTREE_EDIT, null);
    const subtreeHasInbox = (node: any): boolean => {
      if (!node.is_dir) return props.inboxPaths.has(node.path);
      if (!node.children) return false;
      return node.children.some(subtreeHasInbox);
    };

    // The extension the way `Path::extension()` sees it, so the tree filter
    // and the backend's extension index agree: no dot, lower-cased, and a
    // leading-dot name like `.gitignore` has NO extension (it's all stem).
    const extensionOf = (name: string): string => {
      const dot = name.lastIndexOf('.');
      return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
    };

    // #259 — split "name" and ".ext" so CSS can truncate the name to whatever
    // width the sidebar has, keeping the extension visible. This used to be a
    // fixed 30-character cut in JS, so widening the sidebar never showed more.
    const splitName = (name: string): [string, string] => {
      const dot = name.lastIndexOf('.');
      return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    };

    return () => {
      const n = props.node as any;
      const inboxOnly = props.inboxOnly;
      if (inboxOnly) {
        if (!n.is_dir && !props.inboxPaths.has(n.path)) return [];
        if (n.is_dir && n.children && !subtreeHasInbox(n)) return [];
      }
      if (props.extFilter.length) {
        if (!n.is_dir) {
          if (!props.extFilter.includes(extensionOf(n.name))) return [];
        } else if (props.filterDirs && !props.filterDirs.has(n.path)) {
          return [];
        }
      }
      const indent = INDENT_BASE + props.depth * INDENT_STEP;

      // Full name in the tooltip. #182 — the full-names setting wraps
      // instead of truncating.
      const [nameBase, nameExt] = splitName(n.name);
      const nameNode =
        !n.is_dir && !nodeSettings.explorerFullNames && nameExt
          ? h('span', { class: 'ftree__name ftree__name--split' }, [
              h('span', { class: 'ftree__name-base' }, nameBase),
              h('span', { class: 'ftree__name-ext' }, nameExt),
            ])
          : h('span', { class: 'ftree__name' }, n.name);

      const e = edit?.editInTree.value ? edit.editing.value : null;
      const renaming = !!e && e.kind === 'rename' && e.original === n.path;
      const items: any[] = [
        renaming ? edit!.renderEditRow(props.depth) : h(
          'li',
          {
            class: [
              'ftree__item',
              n.is_dir ? 'ftree__item--dir' : 'ftree__item--file',
              samePath(props.selectedPath, n.path) ? 'ftree__item--selected' : '',
              dragPath.value === n.path ? 'ftree__item--dragging' : '',
              n.is_dir && dropTarget.value === n.path ? 'ftree__item--drop' : '',
              revealedPath.value === n.path ? 'ftree__item--revealed' : '',
              reorderTarget.value && reorderTarget.value.path === n.path ? `ftree__item--insert-${reorderTarget.value.pos}` : '',
            ],
            style: { paddingLeft: indent + 'px' },
            // Hit-testing during a drag reads these off whatever row is under
            // the pointer, so the drag logic never has to walk the tree.
            'data-path': n.path,
            'data-dir': n.is_dir ? '1' : '0',
            onPointerdown: (e: PointerEvent) => emit('press', e, n),
            onClick: () => {
              // Swallow the click that ends a drag, or dropping a file would
              // also open it and dropping a folder would toggle it.
              if (suppressClick.value) {
                suppressClick.value = false;
                return;
              }
              emit('toggle', n, 'click');
            },
            onDblclick: () => emit('toggle', n, 'dblclick'),
            onContextmenu: (e: MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              emit('contextmenu', e, n);
            },
            title: n.path,
          },
          [
            ...indentGuides(props.depth),
            // #338 — a folder row is caret + folder glyph; a file row keeps the
            // caret column empty, so its icon lines up with the folder glyph
            // and every file sits visibly to the right of the folders at its
            // level (the file emoji used to be further left than the folder's
            // small caret, which read as "files are the parents").
            h('span', { class: ['ftree__caret', n.is_dir && n.expanded ? 'ftree__caret--open' : ''] },
              n.is_dir ? [h(Icon, { name: 'chevron-right', size: 12 })] : []),
            h('span', { class: 'ftree__icon' }, [h(Icon, { name: n.is_dir ? 'folder-sm' : 'file', size: 16 })]),
            nameNode,
            !n.is_dir && props.inboxPaths.has(n.path)
              ? h('span', { class: 'ftree__inbox-dot', title: 'inbox' })
              : null,
            // Touch screens only (CSS): the row's menu, findable without a
            // long-press or a right-click.
            h('button', {
              class: 'ftree__more',
              type: 'button',
              'aria-label': 'More',
              onPointerdown: (ev: PointerEvent) => ev.stopPropagation(),
              onClick: (ev: MouseEvent) => {
                ev.stopPropagation();
                const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                emit('contextmenu', { clientX: r.left, clientY: r.bottom, preventDefault() {}, stopPropagation() {} } as unknown as MouseEvent, n);
              },
            }, [h(Icon, { name: 'more', size: 16 })]),
          ]
        ),
      ];
      if (n.is_dir && n.expanded && n.children) {
        for (const c of n.children) {
          items.push(
            h(FileTreeNode, {
              node: c,
              depth: props.depth + 1,
              selectedPath: props.selectedPath,
              inboxOnly: props.inboxOnly,
              inboxPaths: props.inboxPaths,
              extFilter: props.extFilter,
              filterDirs: props.filterDirs,
              onToggle: (target: any, how?: 'click' | 'dblclick') => emit('toggle', target, how),
              onContextmenu: (event: MouseEvent, target: any) => emit('contextmenu', event, target),
              onPress: (event: PointerEvent, target: any) => emit('press', event, target),
            })
          );
        }
        // #321 — a new entry being named goes at the end of its folder.
        if (e && e.kind !== 'rename' && e.parent === n.path) items.push(edit!.renderEditRow(props.depth + 1));
      }
      return items;
    };
  },
});
</script>

<style scoped>
/* 5.0 — spec §4 (sidebar tree) and §6 (menus). Tokens only. */
.ftree:focus {
  outline: none;
}
.ftree {
  width: var(--file-tree-width, var(--sidebar-w));
  height: 100%;
  background: var(--bg-sidebar);
  border-right: var(--bd-hair);
  display: flex;
  flex-direction: column;
  user-select: none;
  position: relative;
  font-size: 13px;
  color: var(--text);
}
/* Inside Sidebar.vue: the sidebar owns width, background, border and the
   scrolling; the tree is a block in its scroll area that fills what is left,
   so the space under a short tree is still "the vault root" for a drop or a
   right-click. */
.ftree--embedded {
  width: auto;
  height: auto;
  flex: 1 0 auto;
  background: transparent;
  border-right: 0;
}
.ftree--embedded .ftree__body {
  overflow: visible;
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
}
.ftree--embedded .ftree__list {
  flex: 1 0 auto;
}

/* #342 — manual-sort insertion line, drawn on the row a drop would land
   before or after. :deep() because the rows are rendered by FileTreeNode,
   which scoped styles don't reach otherwise (same as the rules below). */
:deep(.ftree__item--insert-before),
:deep(.ftree__item--insert-after) {
  position: relative;
}
:deep(.ftree__item--insert-before)::after,
:deep(.ftree__item--insert-after)::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  height: 2px;
  border-radius: 1px;
  background: var(--accent);
  pointer-events: none;
}
:deep(.ftree__item--insert-before)::after { top: -1px; }
:deep(.ftree__item--insert-after)::after { bottom: -1px; }

/* ── Section row: 文件夹 · <workspace> ▾ ……… [+][sort][filter][refresh] ── */
.ftree__section {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  height: 28px;
  margin: var(--sp-3) var(--sp-2) 2px;
  padding: 0 2px 0 0;
  border-radius: var(--r-sm);
}
.ftree__section--drop {
  box-shadow: inset 0 0 0 1px var(--accent);
  background: var(--accent-soft);
}
.ftree__ws {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-3);
  font: inherit;
  text-align: left;
  cursor: default;
}
.ftree__ws:hover,
.ftree__ws--open {
  background: var(--fill-1);
}
.ftree__ws:focus-visible,
.ftree__tool:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.ftree__section-label {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.ftree__ws-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-3);
}
.ftree__ws-name::before {
  content: '·';
  margin-right: 6px;
}
.ftree__ws-caret {
  flex: none;
  color: var(--text-3);
  transition: transform var(--dur-fast) var(--ease-out);
}
.ftree__ws--open .ftree__ws-caret {
  transform: rotate(180deg);
}
.ftree__tools {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0;
}
.ftree__tool {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-3);
  cursor: default;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
/* Revealed on hover / keyboard focus; a tool whose state is non-default
   (sorted, filtered) or whose popover is open stays visible. */
.ftree__section:hover .ftree__tool,
.ftree__section:focus-within .ftree__tool,
.ftree__section--active .ftree__tool,
.ftree__tool--on,
.ftree__tool--open {
  opacity: 1;
}
.ftree__tool:hover,
.ftree__tool--open {
  background: var(--fill-1);
  color: var(--text-2);
}
.ftree__tool--on {
  color: var(--accent-text);
}
/* Touch screens have no hover: keep the tools visible. */
@media (hover: none) {
  .ftree__tool {
    opacity: 1;
  }
}

/* ── One menu style for every popover here (spec §6) ── */
.ftree__menu {
  position: fixed;
  z-index: var(--z-pop);
  min-width: 200px;
  max-width: min(320px, calc(100vw - 16px));
  padding: var(--sp-1);
  background: var(--bg-pop);
  border: var(--bd-hair);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-pop);
  font-size: 13px;
  color: var(--text);
  user-select: none;
  transform-origin: top left;
  animation: ftree-pop var(--dur-fast) var(--ease-out);
}
@keyframes ftree-pop {
  from {
    opacity: 0;
    transform: scale(0.98);
  }
}
.ftree__menu--switcher,
.ftree__menu--scroll {
  max-height: min(60vh, 420px);
  overflow-y: auto;
}
.ftree__menu-label {
  padding: 6px 8px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}
.ftree__menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 28px;
  padding: 0 10px 0 6px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: default;
}
.ftree__menu-item--two {
  padding-top: 4px;
  padding-bottom: 4px;
}
.ftree__menu-item:hover:not(:disabled) {
  background: var(--fill-1);
}
.ftree__menu-item:disabled {
  color: var(--text-3);
}
.ftree__menu-check {
  flex: none;
  width: 14px;
  text-align: center;
  font-size: 12px;
  color: var(--text);
}
.ftree__menu-name,
.ftree__menu-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ftree__menu-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.ftree__menu-count {
  flex: none;
  color: var(--text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.ftree__menu-sep {
  height: var(--hair-w);
  margin: var(--sp-1) 6px;
  background: var(--hairline);
}
.ftree__menu-empty {
  padding: 6px 8px 6px 26px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.45;
  white-space: normal;
}
.ftree__switcher-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ftree__switcher-path {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

/* Context menu: same style, its own item class kept for the tests and
   the keyboard-chord layout. */
.ftree__ctx {
  min-width: 200px;
}
.ftree__ctx-item {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: default;
}
.ftree__ctx-item--kbd {
  justify-content: space-between;
}
/* #355 — the chord beside Rename / Delete. */
.ftree__ctx-kbd {
  font: inherit;
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  margin-left: 16px;
}
.ftree__ctx-item:hover {
  background: var(--fill-1);
}
.ftree__ctx-item--danger {
  color: var(--danger);
}
.ftree__ctx-item--danger:hover {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}
.ftree__ctx-sep {
  height: var(--hair-w);
  background: var(--hairline);
  margin: var(--sp-1) 6px;
}

/* ── States: missing folder, empty, loading ── */
.ftree__missing {
  padding: var(--sp-4) 14px;
  text-align: center;
}
.ftree__missing-title {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--danger);
  font-weight: 600;
}
.ftree__missing-path {
  margin: 0 0 10px;
  font-size: 11px;
  color: var(--text-3);
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
}
.ftree__missing-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
}
.ftree__missing-secondary {
  background: transparent;
  border: 0;
  color: var(--text-2);
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}
.ftree__empty {
  padding: var(--sp-5) 14px;
  text-align: center;
}
.ftree__open-btn {
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-md);
  background: var(--fill-1);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  cursor: default;
}
.ftree__open-btn:hover {
  background: var(--fill-2);
}
.ftree__body {
  flex: 1;
  overflow-y: auto;
  padding-bottom: var(--sp-2);
}

/* #282 — a persisted filter must never be invisible. */
.ftree__filter-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px var(--sp-2) 4px;
  padding: 5px 8px;
  border-radius: var(--r-sm);
  background: var(--accent-soft);
  font-size: 12px;
  color: var(--text);
}
.ftree__filter-banner-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ftree__filter-banner-clear {
  flex: none;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--accent-text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.ftree__filter-banner-clear:hover {
  text-decoration: underline;
}

/* ── Rows (spec §4): 28 px, 7 px radius, 16 px per level ── */
.ftree__list {
  list-style: none;
  margin: 0;
  padding: 0 var(--sp-2);
  /* Gives the empty area under a short tree enough body to be a drop target
     for "move to the vault root". */
  min-height: 48px;
}
:deep(.ftree__item) {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 0 8px 0 6px;
  font-size: 13px;
  cursor: default;
  color: var(--text);
  border-radius: 7px;
  /* Anchors the indent guides drawn by indentGuides(). */
  position: relative;
}
:deep(.ftree__item:hover) {
  background: var(--fill-1);
}

/* Indent guides — one hairline per ancestor level, through the middle of
   that level's chevron (see indentGuides()). Absolutely positioned, so the
   row geometry and hit-testing are unaffected. */
:deep(.ftree__guide) {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  border-left: var(--hair-w) solid var(--tree-guide, var(--hairline));
  pointer-events: none;
}
:deep(.ftree__stub) {
  display: none;
}
/* The selected row — the open document, or the row last clicked, which is
   also where "new file" goes. */
:deep(.ftree__item--selected),
:deep(.ftree__item--selected:hover) {
  background: var(--accent-soft);
  color: var(--accent-text);
}
:deep(.ftree__item--selected .ftree__icon),
:deep(.ftree__item--selected .ftree__caret) {
  color: var(--accent-text);
}

/* #290 / #267 — drag to move. The node being dragged fades; the folder that
   would receive it gets a ring rather than a fill. */
:deep(.ftree__item--dragging) {
  opacity: 0.45;
}
:deep(.ftree__item--drop) {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent);
}
/* "Reveal in File Tree": a fill *and* a ring that fade over ~3 s, so it
   reads in a theme whose accent is close to the row colour. */
:deep(.ftree__item--revealed) {
  box-shadow: inset 0 0 0 1px var(--accent);
  animation: ftree-reveal 3.2s ease-out forwards;
}
@keyframes ftree-reveal {
  0% {
    background: color-mix(in srgb, var(--accent) 36%, transparent);
  }
  60% {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
  }
  100% {
    background: transparent;
    box-shadow: inset 0 0 0 1px transparent;
  }
}
.ftree__list--drop {
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  border-radius: 7px;
}
:deep(.ftree__icon) {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
:deep(.ftree__caret) {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  transition: transform var(--dur-fast) var(--ease-out);
}
:deep(.ftree__caret--open) {
  transform: rotate(90deg);
}
/* Long names are cut to the sidebar's current width (#259). */
:deep(.ftree__name) {
  flex: 1;
  min-width: 0;
  margin-left: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* A file name with an extension: the name shrinks with an ellipsis, the
   extension never does — "a-very-long-meeting-no….md". */
:deep(.ftree__name--split) {
  display: flex;
}
:deep(.ftree__name-base) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
:deep(.ftree__name-ext) {
  flex-shrink: 0;
  white-space: nowrap;
}
/* #182 — full-filename mode: wrap long names instead of truncating. */
.ftree--fullnames :deep(.ftree__item) {
  padding-top: 5px;
  padding-bottom: 5px;
}
.ftree--fullnames :deep(.ftree__name) {
  white-space: normal;
  overflow-wrap: break-word;
  word-break: break-word;
  line-height: 1.3;
}
:deep(.ftree__inbox-dot) {
  flex: none;
  width: 6px;
  height: 6px;
  margin-left: auto;
  border-radius: 50%;
  background: var(--accent);
}

/* Standalone tree only — inside the sidebar the Inbox is a nav row. */
.ftree__inbox {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  margin: 0 var(--sp-2);
  padding: 0 8px 0 6px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--text-2);
}
.ftree__inbox:hover {
  background: var(--fill-1);
  color: var(--text);
}
.ftree__inbox--active {
  color: var(--accent-text);
}
.ftree__inbox-toggle,
.ftree__inbox-open {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  cursor: default;
  padding: 0;
  text-align: left;
}
.ftree__inbox-open {
  flex: 1;
  min-width: 0;
}
.ftree__badge {
  margin-left: auto;
  color: var(--text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.ftree__loading {
  padding: var(--sp-4) 14px;
  font-size: 12px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 8px;
}
.ftree__spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--hairline);
  border-top-color: var(--text-3);
  border-radius: 50%;
  animation: ftree-spin 0.7s linear infinite;
}
@keyframes ftree-spin { to { transform: rotate(360deg); } }
.ftree__truncated {
  padding: 6px 8px 6px 26px;
  font-size: 12px;
  color: var(--text-3);
}
/* :deep because the in-folder edit row is rendered by FileTreeNode (#321). */
:deep(.ftree__edit) {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 0 8px 0 6px;
  position: relative;
}
.ftree__body > .ftree__edit {
  margin: 0 var(--sp-2);
}
:deep(.ftree__edit .ftree__icon) {
  color: var(--text-3);
}
:deep(.ftree__edit-input) {
  flex: 1;
  min-width: 0;
  height: 22px;
  margin-left: 2px;
  padding: 0 5px;
  font: inherit;
  font-size: 13px;
  border: 0;
  border-radius: var(--r-xs);
  background: var(--bg);
  color: var(--text);
  outline: none;
  box-shadow: 0 0 0 2px var(--accent-ring);
}
.ftree__confirm-msg {
  margin: 0;
  font-size: 13px;
  color: var(--text);
  line-height: 1.5;
  word-break: break-word;
}
.ftree__confirm-note {
  margin: var(--sp-2) 0 0;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.5;
}
@media (prefers-reduced-motion: reduce) {
  .ftree__menu {
    animation: none;
  }
}
</style>

<style>
/* Window lost focus: the selection turns neutral, as in Finder / Notes
   (spec §1). Unscoped so it outranks the scoped selected-row rule. */
:root.window-inactive .ftree__item--selected,
:root.window-inactive .ftree__item--selected:hover {
  background: var(--select-inactive);
  color: var(--text);
}
:root.window-inactive .ftree__item--selected .ftree__icon,
:root.window-inactive .ftree__item--selected .ftree__caret {
  color: var(--text-3);
}
/* #361 — drag feedback that must live outside the scoped block: the ghost is
   teleported to <body>, and the cursor override has to beat the rows' own
   `cursor: pointer` on every element for the length of the drag. */
html.solomd-tree-dragging,
html.solomd-tree-dragging * {
  cursor: grabbing !important;
}
html.solomd-tree-drag-invalid,
html.solomd-tree-drag-invalid * {
  cursor: not-allowed !important;
}
.ftree-ghost {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-toast, 3000);
  pointer-events: none;
  user-select: none;
  will-change: transform;
  max-width: min(320px, calc(100vw - 16px));
  padding: 6px 10px;
  border-radius: var(--r-md, 8px);
  background: var(--bg-pop);
  color: var(--text);
  border: var(--bd-hair);
  box-shadow: var(--sh-pop);
  font-size: 12px;
  line-height: 1.35;
}
.ftree-ghost--invalid {
  border-color: var(--danger);
}
.ftree-ghost__name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-weight: 600;
}
.ftree-ghost__icon {
  flex-shrink: 0;
  color: var(--text-3);
}
.ftree-ghost__label,
.ftree-ghost__action {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ftree-ghost__action {
  margin-top: 2px;
  color: var(--text-2);
}
.ftree-ghost--invalid .ftree-ghost__action {
  color: var(--danger);
}


/* Global (not scoped): the rows are rendered by FileTreeNode via h(), and
   these must also reach them. Touch screens: no long-press callout or text selection on rows (iOS would
   offer "Copy / Look Up" instead of our menu), and a "⋯" button per row. */
.ftree__more { display: none; }
@media (pointer: coarse) {
  .ftree__item {
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .ftree__more {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: auto;
    min-width: 32px;
    height: 28px;
    padding: 0 6px;
    border: none;
    background: none;
    color: var(--text-3);
    line-height: 1;
    border-radius: 6px;
    flex-shrink: 0;
  }
  .ftree__more:active { background: var(--fill-1); }
}
</style>
