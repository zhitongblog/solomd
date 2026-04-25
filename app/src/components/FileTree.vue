<script setup lang="ts">
import { ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../stores/workspace';
import { useFiles } from '../composables/useFiles';

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

const root = ref<Node | null>(null);

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
  const node: Node = {
    name: path.split(/[\\/]/).pop() ?? path,
    path,
    is_dir: true,
    expanded: true,
    loading: true,
  };
  // Set immediately so the user sees a Loading row instead of an
  // empty pane while a slow filesystem (Windows OneDrive, network
  // mounts) churns through the dir scan.
  root.value = node;
  const { children, truncated } = await loadDir(path);
  node.children = children;
  node.truncated = truncated;
  node.loading = false;
  root.value = node;
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
  },
  emits: ['toggle'],
  setup(props, { emit }) {
    return () => {
      const n = props.node as any;
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
          ]
        ),
      ];
      if (n.is_dir && n.expanded && n.children) {
        for (const c of n.children) {
          items.push(
            h(FileTreeNode, {
              node: c,
              depth: props.depth + 1,
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
