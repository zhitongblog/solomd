<script setup lang="ts">
import { computed } from 'vue';

type Variant = 'primary' | 'ghost' | 'subtle' | 'danger';
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
.ds-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  font-family: inherit;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  border: 1px solid transparent;
  border-radius: var(--r-md);
  cursor: pointer;
  user-select: none;
  transition: background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.ds-btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.ds-btn:disabled {
  cursor: default;
  opacity: 0.5;
}
.ds-btn--block {
  width: 100%;
}

/* sizes — Tolaria density: ~32px sm, ~36px md */
.ds-btn--sm {
  height: 32px;
  padding: 0 var(--sp-3);
  font-size: 12px;
}
.ds-btn--md {
  height: 36px;
  padding: 0 var(--sp-4);
  font-size: 13px;
}

/* variants */
.ds-btn--primary {
  background: var(--accent);
  color: var(--accent-fg);
}
.ds-btn--primary:not(:disabled):hover {
  filter: brightness(0.96);
}
.ds-btn--subtle {
  background: var(--bg-elev);
  border-color: var(--border);
  color: var(--text);
}
.ds-btn--subtle:not(:disabled):hover {
  background: var(--bg-hover);
}
.ds-btn--ghost {
  background: transparent;
  color: var(--text);
}
.ds-btn--ghost:not(:disabled):hover {
  background: var(--bg-hover);
}
.ds-btn--danger {
  background: var(--danger);
  color: var(--danger-fg);
}
.ds-btn--danger:not(:disabled):hover {
  filter: brightness(0.94);
}

.ds-btn__content {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
}
.ds-btn--loading .ds-btn__content {
  opacity: 0.7;
}
.ds-btn__spinner {
  width: 14px;
  height: 14px;
  border-radius: var(--r-full);
  border: 2px solid currentColor;
  border-top-color: transparent;
  animation: ds-spin 0.6s linear infinite;
}
@keyframes ds-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
