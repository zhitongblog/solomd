<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from '../i18n';
import { useSettingsStore } from '../stores/settings';

const props = defineProps<{
  /** Pane id immediately above the splitter — receives Δ+ when dragging down. */
  above: string;
  /** Pane id immediately below the splitter — receives Δ- when dragging down. */
  below: string;
}>();

const { t } = useI18n();
const settings = useSettingsStore();
const dragging = ref(false);

function startDrag(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  const startY = e.clientY;
  const aboveEl = document.querySelector<HTMLElement>(`[data-rs-pane="${props.above}"]`);
  const belowEl = document.querySelector<HTMLElement>(`[data-rs-pane="${props.below}"]`);
  if (!aboveEl || !belowEl) return;
  const startAboveH = aboveEl.getBoundingClientRect().height;
  const startBelowH = belowEl.getBoundingClientRect().height;
  document.body.classList.add('rs-splitter--dragging');
  dragging.value = true;

  function onMove(ev: MouseEvent) {
    const dy = ev.clientY - startY;
    // Clamp so neither pane shrinks below 80px.
    const min = 80;
    let newAbove = startAboveH + dy;
    let newBelow = startBelowH - dy;
    if (newAbove < min) {
      newAbove = min;
      newBelow = startAboveH + startBelowH - min;
    } else if (newBelow < min) {
      newBelow = min;
      newAbove = startAboveH + startBelowH - min;
    }
    settings.setRightSidebarPaneHeight(props.above, newAbove);
    settings.setRightSidebarPaneHeight(props.below, newBelow);
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('rs-splitter--dragging');
    dragging.value = false;
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
</script>

<template>
  <div
    class="rs-splitter"
    :class="{ 'rs-splitter--active': dragging }"
    :title="t('rightSidebar.dragToResize')"
    @mousedown="startDrag"
    @dblclick="settings.resetRightSidebarPaneHeights()"
  />
</template>

<style scoped>
/* 5.0 — the divider between stacked panes is a hairline (what every
   inspector in a Mac app draws); the 9 px hit area lives in ::before so the
   line stays thin without being hard to grab. #294's "can this be resized?"
   answer is kept: hovering (after a short delay, so a pointer passing over
   doesn't flash) or dragging shows a 2 px accent bar. Double-click resets. */
.rs-splitter {
  flex: 0 0 var(--hair-w);
  height: var(--hair-w);
  position: relative;
  z-index: 5;
  cursor: row-resize;
  background: var(--hairline);
}
.rs-splitter::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -4px;
  bottom: -4px;
}
.rs-splitter::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 2px;
  transform: translateY(-50%);
  background: var(--accent);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease) 0ms;
  pointer-events: none;
}
.rs-splitter:hover::after {
  opacity: 1;
  transition-delay: 150ms;
}
body.rs-splitter--dragging .rs-splitter--active::after {
  opacity: 1;
  transition-delay: 0ms;
}
</style>
