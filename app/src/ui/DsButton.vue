<script setup lang="ts">
import { computed } from 'vue';

/** `secondary` is the 5.0 name; `subtle` is kept as an alias for existing callers. */
type Variant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger';
type Size = 'sm' | 'md';

const props = withDefaults(
  defineProps<{
    variant?: Variant;
    size?: Size;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    loading?: boolean;
    block?: boolean;
  }>(),
  {
    variant: 'subtle',
    size: 'md',
    type: 'button',
    disabled: false,
    loading: false,
    block: false,
  },
);

const emit = defineEmits<{ click: [MouseEvent] }>();

const isInert = computed(() => props.disabled || props.loading);

function onClick(e: MouseEvent) {
  if (isInert.value) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  emit('click', e);
}
</script>

<template>
  <button
    class="ds-btn"
    :class="[`ds-btn--${variant}`, `ds-btn--${size}`, { 'ds-btn--block': block, 'ds-btn--loading': loading }]"
    :type="type"
    :disabled="isInert"
    :aria-busy="loading || undefined"
    @click="onClick"
  >
    <span v-if="loading" class="ds-btn__spinner" aria-hidden="true" />
    <span class="ds-btn__content"><slot /></span>
  </button>
</template>

<style scoped>
/* 5.0 (spec §6): 32px / radius 8 / 13px 560. primary = --accent-strong with a
   white label; secondary = --fill-1; ghost = transparent; danger = --danger.
   Focus is the shared --ring. */
.ds-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-family: var(--font-ui, inherit);
  font-weight: 560;
  line-height: 1;
  letter-spacing: -0.003em;
  white-space: nowrap;
  border: 0;
  border-radius: var(--r-md);
  cursor: default;
  user-select: none;
  -webkit-user-select: none;
  transition: background-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    filter var(--dur-fast) var(--ease);
}
.ds-btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.ds-btn:disabled {
  opacity: 0.45;
}
.ds-btn--block {
  width: 100%;
}

.ds-btn--sm {
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
  border-radius: var(--r-sm);
}
.ds-btn--md {
  height: 32px;
  padding: 0 14px;
  font-size: 13px;
}

.ds-btn--primary {
  background: var(--accent-strong);
  color: var(--accent-strong-fg);
}
.ds-btn--primary:not(:disabled):hover {
  background: var(--accent-strong);
  filter: brightness(1.06);
}
.ds-btn--primary:not(:disabled):active {
  filter: brightness(0.94);
}
.ds-btn--secondary,
.ds-btn--subtle {
  background: var(--fill-1);
  color: var(--text);
}
.ds-btn--secondary:not(:disabled):hover,
.ds-btn--subtle:not(:disabled):hover {
  background: var(--fill-2);
}
.ds-btn--secondary:not(:disabled):active,
.ds-btn--subtle:not(:disabled):active {
  background: var(--fill-2);
  filter: brightness(0.97);
}
.ds-btn--ghost {
  background: transparent;
  color: var(--text-2);
}
.ds-btn--ghost:not(:disabled):hover {
  background: var(--fill-1);
  color: var(--text);
}
.ds-btn--ghost:not(:disabled):active {
  background: var(--fill-2);
}
.ds-btn--danger {
  background: var(--danger);
  color: var(--danger-fg);
}
.ds-btn--danger:not(:disabled):hover {
  background: var(--danger);
  filter: brightness(1.06);
}
.ds-btn--danger:not(:disabled):active {
  filter: brightness(0.94);
}

.ds-btn__content {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ds-btn--loading .ds-btn__content {
  opacity: 0.7;
}
.ds-btn__spinner {
  width: 13px;
  height: 13px;
  border-radius: var(--r-full);
  border: 1.6px solid currentColor;
  border-top-color: transparent;
  animation: ds-spin 0.6s linear infinite;
}
@keyframes ds-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
