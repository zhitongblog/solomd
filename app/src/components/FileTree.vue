<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
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

interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
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
const tabs = useTabsStore();
const { t } = useI18n();

const root = ref<Node | null>(null);

// v2.4 inbox filter — when on, the FileTreeNode subtree below prunes
// non-inbox files (and dirs whose subtree contains no inbox docs).
const showInboxOnly = computed(() => inbox.filterMode.value);

/** Sentinel emitted by the Rust backend when it truncated a huge dir
 * past the 10,000-entry hard cap. We surface it as a dedicated UI
 * row instead of rendering it as a fake file. */
const TRUNCATED_SENTINEL = '__solomd_truncated__';

async function loadDir(path: string): Promise<{ children: Node[]; truncated: boolean }> {
  try {
    const entries = await invoke<Entry[]>('list_dir', { path });
    let truncated = false;
    const filtered: Node[] = [];
    for (const e of entries) {
      if (e.name === TRUNCATED_SENTINEL && !e.is_dir && e.path === '') {
        truncated = true;
        continue;
      }
      filtered.push({ ...e });
    }
    return { children: filtered, truncated };
  } catch (e) {
    console.error('list_dir failed', e);
    return { children: [], truncated: false };
  }
}

async function refreshRoot() {
  if (!workspace.currentFolder) {
    root.value = null;
    return;
  }
  const path = workspace.currentFolder;
  root.value = {
    name: path.split(/[\\/]/).pop() ?? path,
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

async function toggle(node: Node) {
  if (!node.is_dir) {
    await files.openPath(node.path);
    return;
  }
  if (node.expanded) {
    node.expanded = false;
    return;
  }
  if (!node.children) {
    node.loading = true;
    const { children, truncated } = await loadDir(node.path);
    node.children = children;
    node.truncated = truncated;
    node.loading = false;
  }
  node.expanded = true;
}

watch(() => workspace.currentFolder, refreshRoot, { immediate: true });

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
}

function onSaved() { scheduleRefresh(); }
function onRemotePulled() { scheduleRefresh(); }

let unlistenIndex: UnlistenFn | null = null;
onMounted(async () => {
  window.addEventListener('solomd:saved', onSaved as EventListener);
  window.addEventListener('solomd:remote-pulled', onRemotePulled as EventListener);
  try {
    unlistenIndex = await listen('solomd://index-updated', () => scheduleRefresh());
  } catch {}
});
onBeforeUnmount(() => {
  window.removeEventListener('solomd:saved', onSaved as EventListener);
  window.removeEventListener('solomd:remote-pulled', onRemotePulled as EventListener);
  if (unlistenIndex) unlistenIndex();
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

function openCtx(e: MouseEvent, node: Node | null) {
  e.preventDefault();
  e.stopPropagation();
  ctx.value = { x: e.clientX, y: e.clientY, node };
}
function closeCtx() {
  ctx.value = null;
}

async function startNewFile(parent: string) {
  closeCtx();
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
      const target = joinPath(e.parent, finalName);
      await invoke('fs_create_file', { path: target, content: '' });
      editing.value = null;
      scheduleRefresh();
      await files.openPath(target, { bypassNewWindow: true });
    } else if (e.kind === 'new-dir') {
      await invoke('fs_create_dir', { path: joinPath(e.parent, name) });
      editing.value = null;
      scheduleRefresh();
    } else if (e.kind === 'rename' && e.original) {
      const target = joinPath(e.parent, name);
      if (target === e.original) {
        editing.value = null;
        return;
      }
      await invoke('fs_rename', { from: e.original, to: target });
      editing.value = null;
      scheduleRefresh();
      // v4.3.5 — if the renamed file is open in a tab, point the tab at the
      // new path and (when content might have changed on disk via the
      // per-file `.assets/` link rewrite) reload from disk for clean tabs.
      // Dirty tabs keep their in-memory content; user resolves on save.
      //
      // #91 fix: the dirty check has to run BEFORE we call markSaved —
      // markSaved sets savedContent = content as part of its bookkeeping,
      // so the comparison was always true and dirty tabs lost their
      // in-memory edits to whatever was on disk. Snapshot first, reload
      // only if it was already clean.
      try {
        const tab = tabs.tabs.find((t: { filePath?: string }) => t.filePath === e.original);
        if (tab) {
          const wasClean = tab.savedContent === tab.content;
          if (wasClean) {
            // Clean tab: safe to repoint + reload from disk (picks up any
            // per-file `.assets/` link rewrite the rename triggered).
            tabs.markSaved(tab.id, target);
            const fr = await invoke<{ content: string }>('read_file', { path: target });
            tabs.setContent(tab.id, fr.content);
            tabs.markSaved(tab.id, target);
          } else {
            // Dirty tab: repoint to the new path but KEEP the unsaved edits
            // AND the dirty flag. markSaved() here would clear savedContent
            // and silently lose the edits when the tab is later closed (#91).
            tabs.renamePath(tab.id, target);
          }
        }
      } catch (err) {
        console.warn('[FileTree.rename] tab refresh failed', err);
      }
    }
  } catch (err) {
    toasts.error(String(err));
  }
}

function cancelEdit() {
  editing.value = null;
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
    e.preventDefault();
    void commitEdit();
  }
}

async function deleteNode(node: Node) {
  closeCtx();
  const ok = window.confirm(
    node.is_dir
      ? `Delete folder "${node.name}" and everything inside?\n\nThis cannot be undone.`
      : `Delete "${node.name}"?\n\nThis cannot be undone.`,
  );
  if (!ok) return;
  try {
    await invoke('fs_delete', { path: node.path });
    scheduleRefresh();
    toasts.success(`Deleted ${node.name}`);
  } catch (e) {
    toasts.error(`Delete failed: ${e}`);
  }
}

async function revealNode(node: Node) {
  closeCtx();
  try {
    await revealItemInDir(node.path);
  } catch (e) {
    console.warn('reveal failed', e);
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

function toggleSwitcher() {
  switcherOpen.value = !switcherOpen.value;
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

// Close the context menu on any outside click / escape.
function onWindowClick() {
  if (switcherOpen.value) closeSwitcher();
  if (!ctx.value) return;
  closeCtx();
}
function onWindowKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    closeCtx();
    closeSwitcher();
    if (editing.value) editing.value = null;
  }
}
onMounted(() => {
  window.addEventListener('click', onWindowClick);
  window.addEventListener('keydown', onWindowKey);
});
onBeforeUnmount(() => {
  window.removeEventListener('click', onWindowClick);
  window.removeEventListener('keydown', onWindowKey);
});
</script>

<template>
  <aside class="ftree" @contextmenu.prevent="openCtx($event, null)">
    <div class="ftree__header">
      <span>Explorer</span>
      <div class="ftree__header-btns">
        <button
          class="ftree__hbtn"
          :title="t('explorer.newFile') || 'New file'"
          @click="root && startNewFile(root.path)"
          :disabled="!root"
        >＋</button>
        <button
          class="ftree__hbtn"
          :title="t('explorer.refresh') || 'Refresh'"
          @click="scheduleRefresh"
          :disabled="!root"
        >↻</button>
        <button
          class="ftree__hbtn"
          :title="t('explorer.openFolder') || 'Open folder…'"
          @click="files.openFolder"
        >📁</button>
      </div>
    </div>

    <div v-if="!root" class="ftree__empty">
      <button class="ftree__open-btn" @click="files.openFolder">Open Folder…</button>
    </div>
    <div v-else class="ftree__body">
      <!-- v4.3.5: root display doubles as the workspace switcher. Click
           opens a dropdown listing recent folders + "Open folder…". -->
      <div class="ftree__root-wrap">
        <button
          class="ftree__root ftree__root--btn"
          :class="{ 'ftree__root--open': switcherOpen }"
          :title="(t('explorer.switchWorkspace') || 'Switch workspace') + ' · ' + root.path"
          @click.stop="toggleSwitcher"
          @contextmenu.prevent="openCtx($event, root)"
        >
          <span class="ftree__root-vicon" aria-hidden="true">🗂</span>
          <span class="ftree__root-name">{{ root.name }}</span>
          <span class="ftree__root-caret" aria-hidden="true">▾</span>
        </button>
        <div v-if="switcherOpen" class="ftree__switcher" @click.stop>
          <div class="ftree__switcher-label">{{ t('explorer.recentFolders') }}</div>
          <button
            v-for="folder in switcherList"
            :key="folder.path"
            class="ftree__switcher-item"
            :class="{ 'ftree__switcher-item--active': folder.path === root.path }"
            :title="folder.path"
            @click="pickRecentFolder(folder.path)"
          >
            <span class="ftree__switcher-name">{{ folder.name }}</span>
            <span class="ftree__switcher-path">{{ folder.parent }}</span>
          </button>
          <div v-if="switcherList.length === 0" class="ftree__switcher-empty">
            {{ t('explorer.noRecentFolders') }}
          </div>
          <div class="ftree__switcher-sep"></div>
          <button class="ftree__switcher-item ftree__switcher-item--cta" @click="openFolderAndClose">
            📁 {{ t('explorer.openFolder') }}
          </button>
        </div>
      </div>

      <!-- Inline new/rename input — appears at the top of the tree. -->
      <div v-if="editing" class="ftree__edit">
        <span class="ftree__icon">{{ editing.kind === 'new-dir' ? '▸' : editing.kind === 'rename' ? '•' : '•' }}</span>
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

      <!-- v2.4 / v4.6 F6: Inbox row. The chevron toggles the inbox-only tree
           filter (so the tree below shows only `inbox: true` docs); clicking
           the name opens the dedicated InboxView workflow. Gated on the
           v4.6 inbox-workflow opt-out. -->
      <div
        v-if="settings.inboxWorkflowEnabled"
        class="ftree__inbox"
        :class="{ 'ftree__inbox--active': showInboxOnly }"
      >
        <button
          class="ftree__inbox-toggle"
          :title="showInboxOnly ? t('inbox.filterOff') : t('inbox.filterOn')"
          @click="inbox.toggleFilter()"
        >
          <span class="ftree__icon">{{ showInboxOnly ? '▾' : '▸' }}</span>
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

      <div v-if="root.loading" class="ftree__loading">
        <span class="ftree__spinner" aria-hidden="true"></span>
        <span>Loading…</span>
      </div>
      <ul v-else class="ftree__list">
        <FileTreeNode
          v-for="child in root.children"
          :key="child.path"
          :node="child"
          :depth="0"
          :inbox-only="showInboxOnly"
          :inbox-paths="inbox.inboxPaths.value"
          @toggle="toggle"
          @contextmenu="openCtx"
        />
        <li v-if="root.truncated" class="ftree__truncated" :title="`This folder has more than 10,000 entries; showing the first batch. Move groups into subfolders to see them all.`">
          + 10,000+ more —— folder is huge
        </li>
      </ul>
    </div>

    <!-- Context menu — absolute-positioned floating div. Items vary by
         whether the click landed on a file, a folder, or empty area. -->
    <div
      v-if="ctx"
      class="ftree__ctx"
      :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }"
      @click.stop
    >
      <template v-if="!ctx.node || ctx.node.is_dir">
        <button class="ftree__ctx-item" @click="startNewFile((ctx.node ?? root!).path)">
          📄 {{ t('explorer.newFile') || 'New File' }}
        </button>
        <button class="ftree__ctx-item" @click="startNewFolder((ctx.node ?? root!).path)">
          📁 {{ t('explorer.newFolder') || 'New Folder' }}
        </button>
      </template>
      <div v-if="ctx.node" class="ftree__ctx-sep"></div>
      <button v-if="ctx.node" class="ftree__ctx-item" @click="startRename(ctx.node)">
        ✎ {{ t('explorer.rename') || 'Rename' }}
      </button>
      <button v-if="ctx.node" class="ftree__ctx-item ftree__ctx-item--danger" @click="deleteNode(ctx.node)">
        🗑 {{ t('explorer.delete') || 'Delete' }}
      </button>
      <button v-if="ctx.node && !ctx.node.is_dir" class="ftree__ctx-item" @click="copyGitUrl(ctx.node)">
        🔗 {{ t('explorer.copyGitUrl') || 'Copy Git URL' }}
      </button>
      <div class="ftree__ctx-sep"></div>
      <button class="ftree__ctx-item" @click="revealNode(ctx.node ?? root!)">
        🔍 {{ t('explorer.reveal') || 'Reveal in Finder' }}
      </button>
    </div>
  </aside>
</template>

<script lang="ts">
import { defineComponent, h } from 'vue';

export const FileTreeNode = defineComponent({
  name: 'FileTreeNode',
  props: {
    node: { type: Object as () => any, required: true },
    depth: { type: Number, default: 0 },
    inboxOnly: { type: Boolean, default: false },
    inboxPaths: { type: Object as () => Set<string>, default: () => new Set() },
  },
  emits: ['toggle', 'contextmenu'],
  setup(props, { emit }) {
    const subtreeHasInbox = (node: any): boolean => {
      if (!node.is_dir) return props.inboxPaths.has(node.path);
      if (!node.children) return false;
      return node.children.some(subtreeHasInbox);
    };

    return () => {
      const n = props.node as any;
      const inboxOnly = props.inboxOnly;
      if (inboxOnly) {
        if (!n.is_dir && !props.inboxPaths.has(n.path)) return [];
        if (n.is_dir && n.children && !subtreeHasInbox(n)) return [];
      }
      const indent = 8 + props.depth * 12;
      const items: any[] = [
        h(
          'li',
          {
            class: ['ftree__item', n.is_dir ? 'ftree__item--dir' : 'ftree__item--file'],
            style: { paddingLeft: indent + 'px' },
            onClick: () => emit('toggle', n),
            onContextmenu: (e: MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              emit('contextmenu', e, n);
            },
            title: n.path,
          },
          [
            h('span', { class: 'ftree__icon' }, n.is_dir ? (n.expanded ? '▾' : '▸') : '•'),
            h('span', { class: 'ftree__name' }, n.name),
            !n.is_dir && props.inboxPaths.has(n.path)
              ? h('span', { class: 'ftree__inbox-dot', title: 'inbox' }, '●')
              : null,
          ]
        ),
      ];
      if (n.is_dir && n.expanded && n.children) {
        for (const c of n.children) {
          items.push(
            h(FileTreeNode, {
              node: c,
              depth: props.depth + 1,
              inboxOnly: props.inboxOnly,
              inboxPaths: props.inboxPaths,
              onToggle: (target: any) => emit('toggle', target),
              onContextmenu: (event: MouseEvent, target: any) => emit('contextmenu', event, target),
            })
          );
        }
      }
      return items;
    };
  },
});
</script>

<style scoped>
.ftree {
  width: 240px;
  height: 100%;
  background: var(--bg-elev);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  user-select: none;
}
.ftree__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
}
.ftree__header-btns {
  display: flex;
  gap: 2px;
}
.ftree__hbtn {
  padding: 0 6px;
  font-size: 13px;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  line-height: 1.6;
}
.ftree__hbtn:hover:not(:disabled) {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.ftree__hbtn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.ftree__empty {
  padding: 24px 14px;
  text-align: center;
}
.ftree__open-btn {
  border: 1px solid var(--border);
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text);
  background: var(--bg);
  border-radius: 4px;
  cursor: pointer;
}
.ftree__body {
  flex: 1;
  overflow-y: auto;
  padding-bottom: 12px;
}
.ftree__root-wrap {
  position: relative;
}
.ftree__root {
  padding: 8px 14px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
/* v4.6 — workspace switcher reads as an obviously-clickable control
   (distinct pill + folder glyph + caret), not a static section label. */
.ftree__root--btn {
  display: flex;
  align-items: center;
  gap: 7px;
  width: calc(100% - 16px);
  margin: 6px 8px 4px;
  padding: 7px 10px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--r-md, 8px);
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: var(--text);
  text-transform: none;
  letter-spacing: normal;
  font-size: 12.5px;
  font-weight: 600;
  transition: background var(--dur-fast, 120ms) var(--ease),
    border-color var(--dur-fast, 120ms) var(--ease);
}
.ftree__root--btn:hover {
  background: var(--bg-hover);
  border-color: var(--accent);
}
.ftree__root--btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.ftree__root--open {
  background: var(--accent-soft, rgba(255, 159, 64, 0.1));
  border-color: var(--accent);
}
.ftree__root-vicon {
  flex: 0 0 auto;
  font-size: 13px;
  line-height: 1;
}
.ftree__root-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
}
.ftree__root-caret {
  font-size: 11px;
  color: var(--text-muted);
  flex: 0 0 auto;
  transition: transform var(--dur-fast, 120ms) var(--ease),
    color var(--dur-fast, 120ms) var(--ease);
}
.ftree__root--btn:hover .ftree__root-caret,
.ftree__root--open .ftree__root-caret {
  color: var(--accent);
}
.ftree__root--open .ftree__root-caret {
  transform: rotate(180deg);
}
.ftree__switcher {
  position: absolute;
  top: 100%;
  left: 6px;
  right: 6px;
  z-index: 30;
  margin-top: 2px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
  padding: 4px;
  max-height: 60vh;
  overflow-y: auto;
}
.ftree__switcher-label {
  padding: 6px 8px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.ftree__switcher-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  width: 100%;
  padding: 6px 8px;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: var(--text);
  border-radius: 4px;
}
.ftree__switcher-item:hover {
  background: var(--bg-hover);
}
.ftree__switcher-item--active {
  background: var(--bg-hover);
  font-weight: 600;
}
.ftree__switcher-item--cta {
  color: var(--accent, #ff9f40);
  font-weight: 600;
}
.ftree__switcher-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.ftree__switcher-path {
  font-size: 11px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  direction: rtl;
  text-align: left;
}
.ftree__switcher-empty {
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text-faint);
}
.ftree__switcher-sep {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}
.ftree__list {
  list-style: none;
  margin: 0;
  padding: 0;
}
:deep(.ftree__item) {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 14px 3px 8px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text);
  border-radius: 0;
}
:deep(.ftree__item:hover) {
  background: var(--bg-hover, color-mix(in srgb, var(--accent) 10%, transparent));
}
:deep(.ftree__icon) {
  width: 14px;
  flex-shrink: 0;
  text-align: center;
  color: var(--text-faint);
  font-size: 10px;
}
:deep(.ftree__item--dir .ftree__icon) {
  color: var(--accent);
  font-size: 11px;
}
:deep(.ftree__item--file .ftree__icon) {
  color: var(--text-muted);
  font-size: 9px;
}
:deep(.ftree__name) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
:deep(.ftree__item--dir .ftree__name) {
  font-weight: 600;
  color: var(--text);
}
:deep(.ftree__inbox-dot) {
  color: var(--accent);
  font-size: 7px;
  margin-left: auto;
}
.ftree__inbox {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 14px 4px 8px;
  font-size: 12px;
  color: var(--text-muted);
  background: transparent;
  border: none;
  text-align: left;
  border-radius: 0;
}
.ftree__inbox:hover {
  background: var(--bg-hover, color-mix(in srgb, var(--accent) 10%, transparent));
  color: var(--text);
}
.ftree__inbox--active {
  color: var(--accent);
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
  cursor: pointer;
  padding: 0;
  text-align: left;
}
.ftree__inbox-open {
  flex: 1;
  min-width: 0;
}
.ftree__badge {
  margin-left: auto;
  background: var(--accent);
  color: #000;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
}
.ftree__loading {
  padding: 16px 14px;
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 8px;
}
.ftree__spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: ftree-spin 0.7s linear infinite;
}
@keyframes ftree-spin { to { transform: rotate(360deg); } }
.ftree__truncated {
  padding: 6px 14px 6px 22px;
  font-size: 11px;
  color: var(--text-faint);
  font-style: italic;
}
.ftree__edit {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 14px 3px 8px;
}
.ftree__edit-input {
  flex: 1;
  font-size: 13px;
  font-family: inherit;
  padding: 2px 4px;
  border: 1px solid var(--accent);
  border-radius: 3px;
  background: var(--bg);
  color: var(--text);
  outline: none;
  min-width: 0;
}
.ftree__ctx {
  position: fixed;
  z-index: 200;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  padding: 4px 0;
  min-width: 180px;
  font-size: 13px;
  user-select: none;
}
.ftree__ctx-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 14px;
  background: transparent;
  border: none;
  color: var(--text);
  cursor: pointer;
  font: inherit;
}
.ftree__ctx-item:hover {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}
.ftree__ctx-item--danger {
  color: #d12;
}
.ftree__ctx-item--danger:hover {
  background: rgba(221, 17, 34, 0.12);
}
.ftree__ctx-sep {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}
</style>
