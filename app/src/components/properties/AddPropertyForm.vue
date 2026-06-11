<script setup lang="ts">
/** v4.6 F1 — inline "add property" form. A name input + a display-mode select +
 *  a mode-appropriate value input. On confirm it emits `{ key, mode, value }`
 *  where `value` is already coerced to the JS shape the mode persists (number,
 *  boolean, string[] for tags/relation, string otherwise). Enter submits, Esc
 *  cancels. The parent owns the write + the (optional) mode override. */
import { ref, computed, nextTick, onMounted } from 'vue';
import { DsInput, DsSelect, DsButton, type DsSelectOption } from '../../ui';
import { useI18n } from '../../i18n';
import {
  DISPLAY_MODES,
  DISPLAY_MODE_LABELS,
  coerceForMode,
  type DisplayMode,
} from '../../lib/property-types';

const emit = defineEmits<{
  confirm: [{ key: string; mode: DisplayMode; value: unknown }];
  cancel: [];
}>();

const { t } = useI18n();

const key = ref('');
const mode = ref<DisplayMode>('text');
const rawValue = ref('');
const boolValue = ref(false);
const nameRef = ref<InstanceType<typeof DsInput> | null>(null);

const modeOptions = computed<DsSelectOption[]>(() =>
  DISPLAY_MODES.map((m) => ({ value: m, label: DISPLAY_MODE_LABELS[m] })),
);

onMounted(async () => {
  await nextTick();
  const el = (nameRef.value?.$el as HTMLElement | undefined)?.querySelector?.('input');
  el?.focus();
});

function placeholderFor(m: DisplayMode): string {
  switch (m) {
    case 'number':
      return '0';
    case 'date':
      return 'YYYY-MM-DD';
    case 'url':
      return 'https://…';
    case 'tags':
      return 'a, b, c';
    case 'relation':
      return '[[Note]]';
    case 'status':
      return 'todo';
    default:
      return t('inspector.valuePlaceholder');
  }
}

function canConfirm(): boolean {
  return key.value.trim() !== '';
}

function confirm() {
  if (!canConfirm()) return;
  const m = mode.value;
  const value = m === 'boolean' ? boolValue.value : coerceForMode(m, rawValue.value);
  emit('confirm', { key: key.value.trim(), mode: m, value });
}
</script>

<template>
  <div class="prop-add" @keydown.esc.prevent="emit('cancel')">
    <div class="prop-add__row">
      <DsInput
        ref="nameRef"
        v-model="key"
        size="sm"
        :placeholder="t('inspector.propertyName')"
        @keydown.enter.prevent="confirm"
      />
      <DsSelect v-model="mode" size="sm" :options="modeOptions" />
    </div>

    <div class="prop-add__row">
      <button
        v-if="mode === 'boolean'"
        type="button"
        class="prop-add__bool"
        role="switch"
        :aria-checked="boolValue"
        :class="{ 'prop-add__bool--on': boolValue }"
        @click="boolValue = !boolValue"
      >
        <span class="prop-add__bool-track"><span class="prop-add__bool-thumb" /></span>
        <span>{{ boolValue ? 'true' : 'false' }}</span>
      </button>
      <DsInput
        v-else
        v-model="rawValue"
        size="sm"
        :placeholder="placeholderFor(mode)"
        @keydown.enter.prevent="confirm"
      />
    </div>

    <div class="prop-add__actions">
      <DsButton size="sm" variant="ghost" @click="emit('cancel')">{{ t('inspector.cancel') }}</DsButton>
      <DsButton size="sm" variant="primary" :disabled="!canConfirm()" @click="confirm">{{ t('inspector.add') }}</DsButton>
    </div>
  </div>
</template>

<style scoped>
.prop-add {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg-elev);
}
.prop-add__row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--sp-2);
}
.prop-add__row:nth-child(2) {
  grid-template-columns: 1fr;
}
.prop-add__bool {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: 12px;
  color: var(--text-muted);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: var(--sp-1) 0;
}
.prop-add__bool-track {
  width: 30px;
  height: 18px;
  border-radius: var(--r-full);
  background: var(--bg-hover);
  border: 1px solid var(--border);
  position: relative;
  flex-shrink: 0;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.prop-add__bool-thumb {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 14px;
  height: 14px;
  border-radius: var(--r-full);
  background: var(--text-muted);
  transition: transform var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.prop-add__bool--on .prop-add__bool-track {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.prop-add__bool--on .prop-add__bool-thumb {
  transform: translateX(12px);
  background: var(--accent);
}
.prop-add__bool--on span:last-child {
  color: var(--text);
}
.prop-add__bool:focus-visible {
  outline: none;
}
.prop-add__bool:focus-visible .prop-add__bool-track {
  box-shadow: var(--ring);
}
.prop-add__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
</style>
