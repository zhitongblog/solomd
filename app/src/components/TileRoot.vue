<script setup lang="ts">
import PaneHost from './PaneHost.vue';
import TileDivider from './TileDivider.vue';
import type { TileNode } from '../types';

defineProps<{
  node: TileNode;
}>();

const emit = defineEmits<{
  (e: 'cursor', line: number, col: number): void;
  (e: 'goto-line', paneId: string, line: number): void;
}>();
</script>

<template>
  <!-- Leaf: render a single pane host -->
  <PaneHost
    v-if="node.type === 'leaf'"
    :pane-id="node.id"
    :active-tab-id="node.activeTabId"
    @cursor="(l, c) => emit('cursor', l, c)"
  />

  <!-- Branch: flex container with two children and a divider -->
  <div
    v-else
    class="tile-branch"
    :class="`tile-branch--${node.direction}`"
  >
    <div
      class="tile-child"
      :style="{ flex: `0 0 ${node.sizes[0]}%` }"
    >
      <TileRoot
        :node="node.children[0]"
        @cursor="(l: number, c: number) => emit('cursor', l, c)"
      />
    </div>
    <TileDivider
      :branch-id="node.id"
      :direction="node.direction"
    />
    <div class="tile-child" style="flex: 1; min-width: 0; min-height: 0;">
      <TileRoot
        :node="node.children[1]"
        @cursor="(l: number, c: number) => emit('cursor', l, c)"
      />
    </div>
  </div>
</template>

<style scoped>
.tile-branch {
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  flex: 1;
}
.tile-branch--horizontal {
  flex-direction: row;
}
.tile-branch--vertical {
  flex-direction: column;
}
.tile-child {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
</style>
