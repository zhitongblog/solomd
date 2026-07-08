<script setup lang="ts">
/**
 * v2.5 F4 — Pomodoro countdown pill.
 *
 * Mounted in StatusBar.vue while a session is active or flashing. Click =
 * pause/resume; right-click = stop / reset menu. Color encodes phase:
 * - focus: accent (orange)
 * - break: blue
 * - flashing (just-completed): green flash for 5s
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { usePomodoroStore } from '../stores/pomodoro';
import { useI18n } from '../i18n';

const pomodoro = usePomodoroStore();
const { t } = useI18n();

const menuOpen = ref(false);
const menuX = ref(0);
const menuY = ref(0);

const tomatoEmoji = computed(() => {
  if (pomodoro.flashing) return '✅';
  if (pomodoro.isBreak) return '☕';
  return '🍅';
});

const pillTitle = computed(() => {
  if (pomodoro.flashing) return t('pomodoro.complete');
  if (pomodoro.isPaused) return t('pomodoro.pillPaused');
  if (pomodoro.isBreak) return t('pomodoro.pillBreak');
  return t('pomodoro.pillFocus');
});

function onClick() {
  if (pomodoro.flashing) return;
  pomodoro.togglePause();
}

function onContextMenu(e: MouseEvent) {
  e.preventDefault();
  menuX.value = e.clientX;
  menuY.value = e.clientY;
  menuOpen.value = true;
}

function closeMenu() { menuOpen.value = false; }

function onStop() {
  pomodoro.stop();
  menuOpen.value = false;
}

function onReset() {
  pomodoro.reset();
  menuOpen.value = false;
}

function onDocClick(e: MouseEvent) {
  if (!menuOpen.value) return;
  const target = e.target as HTMLElement | null;
  if (target && target.closest('.pomo-pill__menu')) return;
  closeMenu();
}

onMounted(() => document.addEventListener('click', onDocClick, true));
onBeforeUnmount(() => document.removeEventListener('click', onDocClick, true));
</script>

<template>
  <button
    class="pomo-pill"
    :class="{
      'pomo-pill--flash': pomodoro.flashing,
      'pomo-pill--break': pomodoro.isBreak && !pomodoro.flashing,
      'pomo-pill--paused': pomodoro.isPaused,
    }"
    :title="pillTitle"
    @click="onClick"
    @contextmenu="onContextMenu"
  >
    <span class="pomo-pill__icon">{{ tomatoEmoji }}</span>
    <span class="pomo-pill__time">{{ pomodoro.flashing ? t('pomodoro.done') : pomodoro.countdown }}</span>
  </button>
  <div
    v-if="menuOpen"
    class="pomo-pill__menu"
    :style="{ left: `${menuX}px`, top: `${menuY}px` }"
  >
    <button class="pomo-pill__menu-item" @mousedown.prevent="onStop">
      {{ t('pomodoro.stop') }}
    </button>
    <button class="pomo-pill__menu-item" @mousedown.prevent="onReset">
      {{ t('pomodoro.reset') }}
    </button>
  </div>
</template>

<style scoped>
.pomo-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  background: var(--accent);
  color: var(--bg-elev);
  border: none;
  cursor: pointer;
  font-family: var(--font-mono);
  transition: background 0.15s, opacity 0.15s;
}
.pomo-pill:hover { filter: brightness(1.1); }
.pomo-pill__icon { font-size: 11px; }
.pomo-pill__time { font-variant-numeric: tabular-nums; }
.pomo-pill--break { background: #4d8fe0; }
.pomo-pill--paused { opacity: 0.6; }
.pomo-pill--flash {
  background: #2ea44f;
  animation: pomoFlash 0.6s ease-in-out infinite alternate;
}
@keyframes pomoFlash {
  from { box-shadow: 0 0 0 0 rgba(46, 164, 79, 0.0); }
  to   { box-shadow: 0 0 0 4px rgba(46, 164, 79, 0.45); }
}
.pomo-pill__menu {
  position: fixed;
  z-index: 200;
  min-width: 120px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  padding: 4px;
}
.pomo-pill__menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 5px 10px;
  font-size: 11px;
  color: var(--text);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.pomo-pill__menu-item:hover {
  background: var(--bg-hover, var(--bg-active));
  color: var(--accent);
}
</style>
