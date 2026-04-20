<script setup lang="ts">
import { ref } from 'vue';
import { useTilesStore } from '../stores/tiles';
import type { SplitDirection } from '../types';

const props = defineProps<{
  branchId: string;
  direction: SplitDirection;
}>();

const tiles = useTilesStore();
const active = ref(false);

function onMouseDown(e: MouseEvent) {
  e.preventDefault();
  active.value = true;

  const startPos = props.direction === 'horizontal' ? e.clientX : e.clientY;
  const startSizes = (() => {
    const node = findBranch();
    return node ? [...node.sizes] as [number, number] : [50, 50] as [number, number];
  })();

  // Get the branch container dimensions
  const container = (e.target as HTMLElement).parentElement;
  const totalSize = container
    ? (props.direction === 'horizontal' ? container.clientWidth : container.clientHeight) - 4 // minus divider width
    : 1000;

  function onMove(ev: MouseEvent) {
    const currentPos = props.direction === 'horizontal' ? ev.clientX : ev.clientY;
    const delta = currentPos - startPos;
    const deltaPercent = (delta / totalSize) * 100;
    const newSizes: [number, number] = [
      startSizes[0] + deltaPercent,
      startSizes[1] - deltaPercent,
    ];
    tiles.setSizes(props.branchId, newSizes);
  }

  function onUp() {
    active.value = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function findBranch() {
  function walk(node: any): any {
    if (node.id === props.branchId) return node;
    if (node.type === 'leaf') return null;
    return walk(node.children[0]) ?? walk(node.children[1]);
  }
  return walk(tiles.root);
}
</script>

<template>
  <div
    class="tile-divider"
    :class="[
      `tile-divider--${direction}`,
      { 'tile-divider--active': active }
    ]"
    @mousedown="onMouseDown"
  />
</template>

<style scoped>
.tile-divider {
  flex-shrink: 0;
  background: var(--border);
  transition: background 0.15s;
}
.tile-divider:hover,
.tile-divider--active {
  background: var(--accent);
}
.tile-divider--horizontal {
  width: 4px;
  cursor: col-resize;
}
.tile-divider--vertical {
  height: 4px;
  cursor: row-resize;
}
</style>
