<script setup lang="ts">
/**
 * v2.5 F4 — Pomodoro popover.
 *
 * Sits next to the focus-mode button in Toolbar.vue and exposes start
 * presets + custom minutes + the per-session toggles. Everything below
 * this component lives in the Pinia store; we only handle UI here.
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { usePomodoroStore } from '../stores/pomodoro';
import { useI18n } from '../i18n';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const pomodoro = usePomodoroStore();
const { t } = useI18n();

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
        class="pomo-popover__num"
        :aria-label="t('pomodoro.customMinutes')"
      />
      <span class="pomo-popover__custom-suffix">{{ t('pomodoro.minShort') }}</span>
      <button class="pomo-popover__start" @mousedown.prevent="startCustom">
        {{ t('pomodoro.start') }}
      </button>
    </div>
    <div class="pomo-popover__sep"></div>
    <label class="pomo-popover__toggle">
      <input type="checkbox" v-model="autoBreak" />
      <span>{{ t('pomodoro.autoBreak') }}</span>
    </label>
    <label class="pomo-popover__toggle">
      <input type="checkbox" v-model="notify" />
      <span>{{ t('pomodoro.notify') }}</span>
    </label>
    <div class="pomo-popover__hint">{{ t('pomodoro.shortcutHint') }}</div>
  </div>
</template>

<style scoped>
.pomo-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 240px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  z-index: 100;
  padding: 6px;
}
.pomo-popover__head {
  padding: 4px 8px 6px;
  font-size: 11px;
  color: var(--text-faint);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.pomo-popover__row {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 6px 10px;
  font-size: 12px;
  text-align: left;
  border-radius: 4px;
  color: var(--text);
  border: none;
  background: transparent;
  cursor: pointer;
}
.pomo-popover__row:hover {
  background: var(--bg-hover, var(--bg-active));
  color: var(--accent);
}
.pomo-popover__row-name { flex: 1; }
.pomo-popover__row-min {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 11px;
}
.pomo-popover__custom {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
}
.pomo-popover__num {
  width: 56px;
  padding: 3px 6px;
  font: inherit;
  font-size: 12px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 4px;
}
.pomo-popover__custom-suffix {
  color: var(--text-faint);
  font-size: 11px;
}
.pomo-popover__start {
  margin-left: auto;
  font-size: 11px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
}
.pomo-popover__start:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.pomo-popover__sep {
  height: 1px;
  background: var(--border);
  margin: 4px 6px;
}
.pomo-popover__toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
}
.pomo-popover__toggle input { margin: 0; }
.pomo-popover__hint {
  padding: 4px 10px 6px;
  font-size: 10px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  line-height: 1.5;
}
</style>
