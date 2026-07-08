<script setup lang="ts">
import { ref, computed } from 'vue';
import PaneTabBar from './PaneTabBar.vue';
import PaneContent from './PaneContent.vue';
import { useTabsStore } from '../stores/tabs';
import { useTilesStore } from '../stores/tiles';
import type { SplitDirection } from '../types';

const props = defineProps<{
  paneId: string;
  activeTabId: string;
}>();

const emit = defineEmits<{
  (e: 'cursor', line: number, col: number): void;
  (e: 'selection', text: string): void;
  (e: 'goto-line', line: number): void;
}>();

const tabs = useTabsStore();
const tiles = useTilesStore();

const activeTab = computed(() => tabs.tabs.find((t) => t.id === props.activeTabId));
const paneContentRef = ref<InstanceType<typeof PaneContent> | null>(null);

// ---- Drop-zone overlay for drag-to-split ----
// The drag itself is driven by PaneTabBar using pointer events (HTML5 DnD is
// unusable on Windows, see #86). It publishes the hovered pane + edge to the
// tiles store; we just reflect that here for THIS pane.
const dropZone = computed<SplitDirection | null>(() =>
  tiles.dragSplit && tiles.dragSplit.paneId === props.paneId ? tiles.dragSplit.direction : null,
);

function onFocusIn() {
  tiles.setFocusedPane(props.paneId);
}

function onCursor(line: number, col: number) {
  emit('cursor', line, col);
}

function onSelection(text: string) {
  emit('selection', text);
}
</script>

<template>
  <div
    class="pane-host"
    :data-pane-id="paneId"
    :class="{ 'pane-host--focused': tiles.focusedPaneId === paneId }"
    @focusin="onFocusIn"
    @click="tiles.setFocusedPane(paneId)"
  >
    <PaneTabBar :pane-id="paneId" :active-tab-id="activeTabId" />
    <PaneContent
      ref="paneContentRef"
      :pane-id="paneId"
      :tab="activeTab"
      @cursor="onCursor"
      @selection="onSelection"
    />
    <!-- Drop zone overlay indicators -->
    <div class="drop-zone drop-zone--left" v-if="dropZone === 'horizontal'" />
    <div class="drop-zone drop-zone--right" v-if="dropZone === 'horizontal'" />
    <div class="drop-zone drop-zone--top" v-if="dropZone === 'vertical'" />
    <div class="drop-zone drop-zone--bottom" v-if="dropZone === 'vertical'" />
  </div>
</template>

<style scoped>
.pane-host {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  position: relative;
  background: var(--bg);
}
.pane-host--focused {
  /* subtle indicator for focused pane */
}

.drop-zone {
  position: absolute;
  background: rgba(255, 159, 64, 0.15);
  pointer-events: none;
  z-index: 10;
}
.drop-zone--left {
  left: 0; top: 0; bottom: 0; width: 50px;
  border-right: 2px solid var(--accent);
}
.drop-zone--right {
  right: 0; top: 0; bottom: 0; width: 50px;
  border-left: 2px solid var(--accent);
}
.drop-zone--top {
  top: 0; left: 0; right: 0; height: 50px;
  border-bottom: 2px solid var(--accent);
}
.drop-zone--bottom {
  bottom: 0; left: 0; right: 0; height: 50px;
  border-top: 2px solid var(--accent);
}
</style>
