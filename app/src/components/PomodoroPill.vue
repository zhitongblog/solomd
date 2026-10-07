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
import Icons from './Icons.vue';

const pomodoro = usePomodoroStore();
const { t } = useI18n();

const menuOpen = ref(false);
const menuX = ref(0);
const menuY = ref(0);

const phaseIcon = computed(() => {
  if (pomodoro.flashing) return 'check-circle';
  if (pomodoro.isBreak) return 'today';
  return 'recent';
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
    <Icons class="pomo-pill__icon" :name="phaseIcon" :size="12" />
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
  height: 22px;
  padding: 0 9px 0 7px;
  border: 0;
  border-radius: var(--r-full);
  background: var(--accent-soft);
  color: var(--accent-text);
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), opacity var(--dur-fast) var(--ease);
}
.pomo-pill:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }
.pomo-pill:focus-visible { outline: none; box-shadow: var(--ring); }
.pomo-pill__icon { flex: 0 0 auto; }
.pomo-pill__time { font-variant-numeric: tabular-nums; }
.pomo-pill--break { background: var(--fill-1); color: var(--text-2); }
.pomo-pill--break:hover { background: var(--fill-2); color: var(--text); }
.pomo-pill--paused { opacity: 0.6; }
.pomo-pill--flash {
  background: color-mix(in srgb, var(--success) 16%, transparent);
  color: var(--success);
  animation: pomoFlash 0.6s ease-in-out infinite alternate;
}
@keyframes pomoFlash {
  from { box-shadow: 0 0 0 0 transparent; }
  to   { box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 30%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  .pomo-pill--flash { animation: none; }
}
/* Context menu — spec §6 menu style. */
.pomo-pill__menu {
  position: fixed;
  z-index: var(--z-pop);
  min-width: 140px;
  padding: 4px;
  background: var(--bg-pop);
  border: var(--bd-hair);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-pop);
}
.pomo-pill__menu-item {
  display: flex;
  align-items: center;
  width: 100%;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.pomo-pill__menu-item:hover {
  background: var(--fill-1);
}
</style>
