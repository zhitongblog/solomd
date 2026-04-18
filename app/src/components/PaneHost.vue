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
  (e: 'goto-line', line: number): void;
}>();

const tabs = useTabsStore();
const tiles = useTilesStore();

const activeTab = computed(() => tabs.tabs.find((t) => t.id === props.activeTabId));
const paneContentRef = ref<InstanceType<typeof PaneContent> | null>(null);

// ---- Drop zone for drag-to-split ----
const dropZone = ref<SplitDirection | null>(null);

function onDragOver(e: DragEvent) {
  if (!e.dataTransfer) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const target = e.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const threshold = 50;

  if (x < threshold) dropZone.value = 'horizontal';
  else if (x > rect.width - threshold) dropZone.value = 'horizontal';
  else if (y < threshold) dropZone.value = 'vertical';
  else if (y > rect.height - threshold) dropZone.value = 'vertical';
  else dropZone.value = null;
}

function onDragLeave() {
  dropZone.value = null;
}

function onDrop(e: DragEvent) {
  dropZone.value = null;
  if (!e.dataTransfer) return;
  const tabId = e.dataTransfer.getData('text/plain');
  if (!tabId) return;

  const target = e.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const threshold = 50;

  let direction: SplitDirection | null = null;
  if (x < threshold || x > rect.width - threshold) direction = 'horizontal';
  else if (y < threshold || y > rect.height - threshold) direction = 'vertical';

  if (direction) {
    tiles.splitPane(props.paneId, direction, tabId);
  }
}

function onFocusIn() {
  tiles.setFocusedPane(props.paneId);
}

function onCursor(line: number, col: number) {
  emit('cursor', line, col);
}
</script>

<template>
  <div
    class="pane-host"
    :data-pane-id="paneId"
    :class="{ 'pane-host--focused': tiles.focusedPaneId === paneId }"
    @focusin="onFocusIn"
    @click="tiles.setFocusedPane(paneId)"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <PaneTabBar :pane-id="paneId" :active-tab-id="activeTabId" />
    <PaneContent
      ref="paneContentRef"
      :pane-id="paneId"
      :tab="activeTab"
      @cursor="onCursor"
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
