<script setup lang="ts">
/**
 * v2.5 F4 — Pomodoro popover.
 *
 * Sits next to the focus-mode button in Toolbar.vue and exposes start
 * presets + custom minutes + the per-session toggles. Everything below
 * this component lives in the Pinia store; we only handle UI here.
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { shortcutLabel } from '../lib/keybindings';
import { usesCommandKey } from '../lib/platform';
import { useSettingsStore } from '../stores/settings';
import { usePomodoroStore } from '../stores/pomodoro';
import { useI18n } from '../i18n';
import '../styles/panels.css';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const pomodoro = usePomodoroStore();
const { t } = useI18n();
// #180 — the chord in this sentence comes from the user's bindings.
const macChord = usesCommandKey();
const kbSettings = useSettingsStore();
function withChord(key: string, actionId: string): string {
  return t(key, { key: shortcutLabel(actionId, kbSettings.keybindings, macChord) || '—' });
}

const customMin = ref<number>(15);
const autoBreak = ref<boolean>(false);
const notify = ref<boolean>(true);

const presets = computed(() => [
  { min: 25, label: t('pomodoro.preset25') },
  { min: 50, label: t('pomodoro.preset50') },
  { min: 90, label: t('pomodoro.preset90') },
]);

function startWith(min: number) {
  if (!Number.isFinite(min) || min <= 0) return;
  pomodoro.start(min, { autoBreak: autoBreak.value, notify: notify.value });
  emit('close');
}

function startCustom() {
  startWith(Number(customMin.value));
}

// Esc closes the popover. Mirrors the global Esc handler in App.vue but
// scoped tighter so the user doesn't lose focus on other dialogs when
// closing this one.
function onKeydown(e: KeyboardEvent) {
  if (!props.open) return;
  if (e.key === 'Escape') emit('close');
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div v-if="open" class="pomo-popover" role="dialog" :aria-label="t('pomodoro.heading')">
    <div class="pomo-popover__head">{{ t('pomodoro.heading') }}</div>
    <button
      v-for="p in presets"
      :key="p.min"
      class="pomo-popover__row"
      @mousedown.prevent="startWith(p.min)"
    >
      <span class="pomo-popover__row-name">{{ p.label }}</span>
      <span class="pomo-popover__row-min">{{ p.min }} {{ t('pomodoro.minShort') }}</span>
    </button>
    <div class="pomo-popover__custom">
      <input
        type="number"
        min="1"
        max="600"
        :value="customMin"
        @input="customMin = Math.max(1, Math.min(600, +($event.target as HTMLInputElement).value || 1))"
        class="rp-input pomo-popover__num"
        :aria-label="t('pomodoro.customMinutes')"
      />
      <span class="pomo-popover__custom-suffix">{{ t('pomodoro.minShort') }}</span>
      <button class="rp-btn rp-btn--sm rp-btn--primary pomo-popover__start" @mousedown.prevent="startCustom">
        {{ t('pomodoro.start') }}
      </button>
    </div>
    <div class="pomo-popover__sep"></div>
    <label class="pomo-popover__toggle">
      <input type="checkbox" class="rp-check" v-model="autoBreak" />
      <span>{{ t('pomodoro.autoBreak') }}</span>
    </label>
    <label class="pomo-popover__toggle">
      <input type="checkbox" class="rp-check" v-model="notify" />
      <span>{{ t('pomodoro.notify') }}</span>
    </label>
    <div class="pomo-popover__hint">{{ withChord('pomodoro.shortcutHint', 'pomodoro.startLast') }}</div>
  </div>
</template>

<style scoped>
/* Spec §6 popover: --bg-pop, 10 px radius, 4 px padding, 28 px rows. */
.pomo-popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 248px;
  padding: 4px;
  background: var(--bg-pop);
  border: var(--bd-hair);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-pop);
  z-index: var(--z-pop);
  color: var(--text);
  font-size: 13px;
  transform-origin: top left;
  animation: pomo-pop-in var(--dur-fast) var(--ease-out);
}
@keyframes pomo-pop-in {
  from {
    opacity: 0;
    transform: scale(0.98);
  }
}
.pomo-popover__head {
  padding: 6px 10px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-3);
}
.pomo-popover__row {
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
.pomo-popover__row:hover {
  background: var(--fill-1);
}
.pomo-popover__row-name { flex: 1; margin-right: 12px; }
.pomo-popover__row-min {
  color: var(--text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.pomo-popover__custom {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 10px;
}
.pomo-popover__num {
  width: 64px;
  height: 26px;
  font-variant-numeric: tabular-nums;
}
.pomo-popover__custom-suffix {
  color: var(--text-3);
  font-size: 12px;
}
.pomo-popover__start {
  margin-left: auto;
}
.pomo-popover__sep {
  height: 0;
  border-top: var(--bd-hair);
  margin: 4px 6px;
}
.pomo-popover__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--r-sm);
  color: var(--text);
  cursor: pointer;
}
.pomo-popover__toggle:hover {
  background: var(--fill-1);
}
.pomo-popover__hint {
  padding: 4px 10px 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-3);
}
</style>
