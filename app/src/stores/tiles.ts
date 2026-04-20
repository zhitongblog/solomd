import { defineStore } from 'pinia';
import type { SplitDirection, TileBranch, TileLeaf, TileNode } from '../types';
import { useTabsStore } from './tabs';

const LS_KEY = 'solomd.tiles.v1';

let nextPaneId = 0;
const newPaneId = () => `pane-${Date.now()}-${nextPaneId++}`;
const newBranchId = () => `branch-${Date.now()}-${nextPaneId++}`;

interface PersistedState {
  root: TileNode;
  focusedPaneId: string;
}

function loadPersisted(): PersistedState | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const data = JSON.parse(raw) as PersistedState;
      if (data.root) return data;
    }
  } catch {}
  return null;
}

// ---- Tree helpers ----

function collectLeaves(node: TileNode): TileLeaf[] {
  if (node.type === 'leaf') return [node];
  return [...collectLeaves(node.children[0]), ...collectLeaves(node.children[1])];
}

function findNode(root: TileNode, id: string): TileNode | null {
  if (root.id === id) return root;
  if (root.type === 'leaf') return null;
  return findNode(root.children[0], id) ?? findNode(root.children[1], id);
}

function findLeaf(root: TileNode, paneId: string): TileLeaf | null {
  const node = findNode(root, paneId);
  return node?.type === 'leaf' ? node : null;
}

function findParent(root: TileNode, id: string): { parent: TileBranch; index: 0 | 1 } | null {
  if (root.type === 'leaf') return null;
  for (let i = 0 as 0 | 1; i <= 1; i++) {
    if (root.children[i].id === id) return { parent: root, index: i };
    const found = findParent(root.children[i], id);
    if (found) return found;
  }
  return null;
}

/** Replace a node in the tree by id, returning a new tree (immutable). */
function replaceNode(root: TileNode, targetId: string, replacement: TileNode): TileNode {
  if (root.id === targetId) return replacement;
  if (root.type === 'leaf') return root;
  return {
    ...root,
    children: [
      replaceNode(root.children[0], targetId, replacement),
      replaceNode(root.children[1], targetId, replacement),
    ] as [TileNode, TileNode],
  };
}

function firstLeaf(node: TileNode): TileLeaf {
  if (node.type === 'leaf') return node;
  return firstLeaf(node.children[0]);
}

export const useTilesStore = defineStore('tiles', {
  state: (): PersistedState => {
    const saved = loadPersisted();
    if (saved) return saved;
    // Default: single leaf with empty activeTabId (will be set on init)
    const defaultLeaf: TileLeaf = { type: 'leaf', id: newPaneId(), activeTabId: '' };
    return { root: defaultLeaf, focusedPaneId: defaultLeaf.id };
  },

  getters: {
    allLeaves(state): TileLeaf[] {
      return collectLeaves(state.root);
    },
    focusedLeaf(state): TileLeaf | null {
      return findLeaf(state.root, state.focusedPaneId);
    },
    leafForPane(): (paneId: string) => TileLeaf | null {
      return (paneId: string) => findLeaf(this.root, paneId);
    },
  },

  actions: {
    initDefault(tabId: string) {
      const leaf: TileLeaf = { type: 'leaf', id: newPaneId(), activeTabId: tabId };
      this.root = leaf;
      this.focusedPaneId = leaf.id;
    },

    splitPane(paneId: string, direction: SplitDirection, newTabId?: string) {
      const leaf = findLeaf(this.root, paneId);
      if (!leaf) return;

      const child0: TileLeaf = { type: 'leaf', id: leaf.id, activeTabId: leaf.activeTabId };
      const child1: TileLeaf = {
        type: 'leaf',
        id: newPaneId(),
        activeTabId: newTabId ?? leaf.activeTabId,
      };
      const branch: TileBranch = {
        type: 'branch',
        id: newBranchId(),
        direction,
        sizes: [50, 50],
        children: [child0, child1],
      };

      this.root = replaceNode(this.root, paneId, branch);
      this.focusedPaneId = child1.id;
      this.syncActiveTab();
    },

    closePane(paneId: string) {
      const leaves = collectLeaves(this.root);
      if (leaves.length <= 1) return; // always keep at least one pane

      const parentInfo = findParent(this.root, paneId);
      if (!parentInfo) return;

      const { parent, index } = parentInfo;
      const sibling = parent.children[1 - index];

      if (this.root.id === parent.id) {
        this.root = sibling;
      } else {
        this.root = replaceNode(this.root, parent.id, sibling);
      }

      // Focus the first leaf of the sibling subtree
      this.focusedPaneId = firstLeaf(sibling).id;
      this.syncActiveTab();
    },

    setActiveTab(paneId: string, tabId: string) {
      const leaf = findLeaf(this.root, paneId);
      if (!leaf) return;
      const newLeaf: TileLeaf = { ...leaf, activeTabId: tabId };
      this.root = replaceNode(this.root, paneId, newLeaf);
      this.focusedPaneId = paneId;
      this.syncActiveTab();
    },

    /** Sync tabs.activeId to the focused pane without triggering syncActiveTab (avoids loops). */
    syncFromTabs(tabId: string) {
      if (!tabId) return;
      const leaf = findLeaf(this.root, this.focusedPaneId);
      if (leaf && leaf.activeTabId !== tabId) {
        const newLeaf: TileLeaf = { ...leaf, activeTabId: tabId };
        this.root = replaceNode(this.root, leaf.id, newLeaf);
      }
    },

    setFocusedPane(paneId: string) {
      this.focusedPaneId = paneId;
      this.syncActiveTab();
    },

    setSizes(branchId: string, sizes: [number, number]) {
      const node = findNode(this.root, branchId);
      if (!node || node.type !== 'branch') return;
      const clamped: [number, number] = [
        Math.max(10, Math.min(90, sizes[0])),
        0,
      ];
      clamped[1] = 100 - clamped[0];
      const updated: TileBranch = { ...node, sizes: clamped };
      this.root = replaceNode(this.root, branchId, updated);
    },

    removePaneReferences(tabId: string) {
      const tabs = useTabsStore();
      const leaves = collectLeaves(this.root);
      let changed = false;
      for (const leaf of leaves) {
        if (leaf.activeTabId !== tabId) continue;
        const other = tabs.tabs.find((t) => t.id !== tabId);
        const newLeaf: TileLeaf = { ...leaf, activeTabId: other?.id ?? '' };
        this.root = replaceNode(this.root, leaf.id, newLeaf);
        changed = true;
      }
      if (changed) this.syncActiveTab();
    },

    syncActiveTab() {
      const tabs = useTabsStore();
      const leaf = findLeaf(this.root, this.focusedPaneId);
      if (leaf?.activeTabId) {
        tabs.activeId = leaf.activeTabId;
      }
    },

    focusNextPane() {
      const leaves = collectLeaves(this.root);
      if (leaves.length <= 1) return;
      const idx = leaves.findIndex((l) => l.id === this.focusedPaneId);
      const next = leaves[(idx + 1) % leaves.length];
      this.focusedPaneId = next.id;
      this.syncActiveTab();
    },

    focusPrevPane() {
      const leaves = collectLeaves(this.root);
      if (leaves.length <= 1) return;
      const idx = leaves.findIndex((l) => l.id === this.focusedPaneId);
      const prev = leaves[(idx - 1 + leaves.length) % leaves.length];
      this.focusedPaneId = prev.id;
      this.syncActiveTab();
    },

    persist() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ root: this.root, focusedPaneId: this.focusedPaneId }));
      } catch {}
    },

    /** Validate persisted state: ensure all activeTabIds reference existing tabs. */
    validate(tabs: { id: string }[]) {
      const ids = new Set(tabs.map((t) => t.id));
      let changed = false;
      const fix = (node: TileNode): TileNode => {
        if (node.type === 'leaf') {
          if (node.activeTabId && !ids.has(node.activeTabId)) {
            changed = true;
            return { ...node, activeTabId: tabs[0]?.id ?? '' };
          }
          return node;
        }
        return { ...node, children: [fix(node.children[0]), fix(node.children[1])] as [TileNode, TileNode] };
      };
      this.root = fix(this.root);
      // Fix focusedPaneId
      const leafIds = new Set(collectLeaves(this.root).map((l) => l.id));
      if (!leafIds.has(this.focusedPaneId)) {
        this.focusedPaneId = firstLeaf(this.root).id;
        changed = true;
      }
      if (changed) this.syncActiveTab();
    },
  },
});
