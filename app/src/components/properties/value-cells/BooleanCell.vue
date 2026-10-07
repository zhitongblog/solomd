<script setup lang="ts">
/** v4.6 F1 — boolean value cell. A toggle that emits a real JS boolean so the
 *  Rust side writes a bare `true` / `false` in YAML. */
import { computed } from 'vue';

const props = defineProps<{ value: unknown }>();
const emit = defineEmits<{ update: [boolean] }>();

const on = computed<boolean>(() => {
  const v = props.value;
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1' || s === 'on';
});

function toggle() {
  emit('update', !on.value);
}
</script>

<template>
  <button
    type="button"
    class="prop-bool"
    role="switch"
    :aria-checked="on"
    :class="{ 'prop-bool--on': on }"
    @click="toggle"
  >
    <span class="prop-bool__track"><span class="prop-bool__thumb" /></span>
    <span class="prop-bool__label">{{ on ? 'true' : 'false' }}</span>
  </button>
</template>

<style scoped>
.prop-bool {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 2px 0;
  color: var(--text-3);
  font: inherit;
  font-size: 12px;
}
.prop-bool__track {
  width: 28px;
  height: 16px;
  border-radius: var(--r-full);
  background: var(--fill-2);
  position: relative;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
  flex-shrink: 0;
}
.prop-bool__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: var(--r-full);
  background: var(--bg);
  box-shadow: var(--sh-thumb);
  transition: transform var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.prop-bool--on .prop-bool__track {
  background: var(--accent);
}
.prop-bool--on .prop-bool__thumb {
  transform: translateX(12px);
}
.prop-bool--on .prop-bool__label {
  color: var(--text);
}
.prop-bool:focus-visible {
  outline: none;
}
.prop-bool:focus-visible .prop-bool__track {
  box-shadow: var(--ring);
}
</style>
