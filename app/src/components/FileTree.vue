<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useWorkspaceStore } from '../stores/workspace';
import { useFiles } from '../composables/useFiles';
import { useInbox } from '../composables/useInbox';
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
  // Phase 1: show "Loading…" immediately so a slow filesystem (Windows
  // OneDrive, network mounts) doesn't render as an empty pane.
  root.value = {
    name: path.split(/[\\/]/).pop() ?? path,
    path,
    is_dir: true,
    expanded: true,
    loading: true,
  };
  // Phase 2: load children, then mutate through the existing proxy so
  // Vue picks up the change. (Re-assigning the same raw `node` object
  // back into `root.value` after mutating it externally is a no-op —
  // ref's setter checks identity. Going through `root.value.x = y`
  // routes through the reactive proxy and does trigger updates.)
  const { children, truncated } = await loadDir(path);
  if (root.value) {
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

// v3.0 fix: auto-refresh the tree when files appear / disappear under
// us. Three triggers we care about:
//   - `solomd:saved`        — user pressed ⌘S; if this is a fresh
//     Untitled tab being saved-as for the first time, the path is brand
//     new and won't show in the tree until we re-list.
//   - `solomd:remote-pulled`— GitHub sync just fetched + decrypted,
//     potentially adding new files we haven't seen.
//   - `solomd://index-updated` — Rust workspace_index emits this on
//     watcher debounce when anything in the tree changes from outside.
//
// Refreshes are debounced 250ms — multiple rapid events coalesce into
// one re-list. We keep currently-expanded subtrees expanded by walking
// the new tree and re-applying expansion state from the old one.
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
  const oldRoot = root.value;
  // Capture the set of expanded directory paths so the refresh doesn't
  // collapse everything the user had open.
  const expanded = new Set<string>();
  function walk(n: Node | null | undefined) {
    if (!n) return;
    if (n.is_dir && n.expanded) expanded.add(n.path);
    n.children?.forEach(walk);
  }
  walk(oldRoot);

  const path = workspace.currentFolder;
  const { children, truncated } = await loadDir(path);
  // Re-expand: lazily reload children for any directory whose path was
  // previously expanded.
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
</script>

<template>
  <aside class="ftree">
    <div class="ftree__header">
      <span>Explorer</span>
      <button @click="files.openFolder" title="Open folder…">⊕</button>
    </div>
    <div v-if="!root" class="ftree__empty">
      <button class="ftree__open-btn" @click="files.openFolder">Open Folder…</button>
    </div>
    <div v-else class="ftree__body">
      <div class="ftree__root">{{ root.name }}</div>

      <!-- v2.4: Inbox row. Clicking toggles the inbox-only filter so the
           tree below shows only docs with `inbox: true` in their YAML. -->
      <button
        class="ftree__inbox"
        :class="{ 'ftree__inbox--active': showInboxOnly }"
        :title="showInboxOnly ? t('inbox.filterOff') : t('inbox.filterOn')"
        @click="inbox.toggleFilter()"
      >
        <span class="ftree__icon">{{ showInboxOnly ? '▾' : '▸' }}</span>
        <span class="ftree__name">{{ t('inbox.heading') }}</span>
        <span class="ftree__badge" v-if="inbox.inboxCount.value > 0">
          {{ inbox.inboxCount.value }}
        </span>
      </button>

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
        />
        <li v-if="root.truncated" class="ftree__truncated" :title="`This folder has more than 10,000 entries; showing the first batch. Move groups into subfolders to see them all.`">
          + 10,000+ more —— folder is huge
        </li>
      </ul>
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
    /** v2.4: when true, hide files that aren't in `inboxPaths`. Empty
     *  directories along the way also collapse out of the rendered tree. */
    inboxOnly: { type: Boolean, default: false },
    inboxPaths: { type: Object as () => Set<string>, default: () => new Set() },
  },
  emits: ['toggle'],
  setup(props, { emit }) {
    /**
     * For inbox-only mode, return whether this subtree contains anything
     * worth rendering. Pure read — no eager dir loads, so an unexpanded
     * dir simply won't be flagged as a match.
     */
    const subtreeHasInbox = (node: any): boolean => {
      if (!node.is_dir) return props.inboxPaths.has(node.path);
      if (!node.children) return false;
      return node.children.some(subtreeHasInbox);
    };

    return () => {
      const n = props.node as any;
      const inboxOnly = props.inboxOnly;
      // Filter pruning. Dirs with at least one inbox descendant survive;
      // un-loaded dirs survive too (otherwise we'd hide them on first paint
      // before the user clicks to expand).
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
            title: n.path,
          },
          [
            h('span', { class: 'ftree__icon' }, n.is_dir ? (n.expanded ? '▾' : '▸') : '·'),
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
.ftree__header button {
  padding: 0 6px;
  font-size: 14px;
  color: var(--text-muted);
}
.ftree__empty {
  padding: 24px 14px;
  text-align: center;
}
.ftree__open-btn {
  border: 1px solid var(--border);
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-muted);
}
.ftree__open-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.ftree__body {
  overflow-y: auto;
  flex: 1;
}
.ftree__root {
  padding: 8px 14px;
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ftree__list {
  list-style: none;
  margin: 0;
  padding: 0 0 12px;
}
.ftree__inbox {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 14px;
  background: transparent;
  border: none;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  border-bottom: 1px dashed var(--border);
}
.ftree__inbox:hover {
  background: var(--bg-hover);
}
.ftree__inbox--active {
  background: var(--bg-active, var(--bg-hover));
  color: var(--accent);
}
.ftree__inbox .ftree__icon {
  width: 12px;
  color: var(--text-faint);
  font-size: 10px;
  text-align: center;
}
.ftree__inbox .ftree__name {
  flex: 1;
}
.ftree__badge {
  background: var(--accent);
  color: var(--bg-elev);
  font-size: 10px;
  padding: 0 6px;
  border-radius: 999px;
  min-width: 18px;
  text-align: center;
  font-weight: 700;
}
:deep(.ftree__inbox-dot) {
  color: var(--accent);
  font-size: 8px;
  margin-left: auto;
}
.ftree__loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  font-size: 12px;
  color: var(--text-muted);
}
.ftree__spinner {
  width: 11px;
  height: 11px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: ftree-spin 0.7s linear infinite;
  flex-shrink: 0;
}
@keyframes ftree-spin { to { transform: rotate(360deg); } }
.ftree__truncated {
  padding: 6px 14px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-faint);
  font-style: italic;
  border-top: 1px dashed var(--border);
}
:deep(.ftree__item) {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 8px;
  font-size: 12px;
  cursor: pointer;
  height: 22px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
}
:deep(.ftree__item:hover) {
  background: var(--bg-hover);
}
:deep(.ftree__icon) {
  display: inline-block;
  width: 12px;
  color: var(--text-faint);
  font-size: 10px;
  text-align: center;
}
:deep(.ftree__item--dir .ftree__name) {
  color: var(--text);
}
:deep(.ftree__item--file .ftree__name) {
  color: var(--text-muted);
}
:deep(.ftree__name) {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
