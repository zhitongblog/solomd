<script setup lang="ts">
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
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
</script>

<template>
  <div
    class="rs-splitter"
    :title="t('rightSidebar.dragToResize')"
    @mousedown="startDrag"
    @dblclick="settings.clearRightSidebarPaneHeights()"
  />
</template>

<style scoped>
.rs-splitter {
  flex: 0 0 4px;
  height: 4px;
  cursor: row-resize;
  background: transparent;
  border-top: 1px solid var(--border);
  position: relative;
  z-index: 5;
  transition: background 0.15s;
}
/* #294 — the divider used to be a 4px transparent line with no feedback of
   any kind, so "can the outline be resized?" was a fair question: nothing on
   screen said yes. Hovering now paints the accent and shows a short grip, the
   same vocabulary the sidebar's width handle already uses. */
.rs-splitter:hover,
body.rs-splitter--dragging .rs-splitter {
  background: var(--accent);
}
.rs-splitter::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 28px;
  height: 2px;
  transform: translate(-50%, -50%);
  border-radius: 1px;
  background: var(--text-faint);
  opacity: 0;
  transition: opacity 0.15s;
}
.rs-splitter:hover::after {
  opacity: 0.9;
}
</style>
