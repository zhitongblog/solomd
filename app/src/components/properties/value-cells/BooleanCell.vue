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
  padding: var(--sp-1) 0;
  color: var(--text-muted);
  font-size: 12px;
}
.prop-bool__track {
  width: 30px;
  height: 18px;
  border-radius: var(--r-full);
  background: var(--bg-hover);
  border: 1px solid var(--border);
  position: relative;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
  flex-shrink: 0;
}
.prop-bool__thumb {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 14px;
  height: 14px;
  border-radius: var(--r-full);
  background: var(--text-muted);
  transition: transform var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.prop-bool--on .prop-bool__track {
  background: var(--accent-soft);
  border-color: var(--accent);
}
.prop-bool--on .prop-bool__thumb {
  transform: translateX(12px);
  background: var(--accent);
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
