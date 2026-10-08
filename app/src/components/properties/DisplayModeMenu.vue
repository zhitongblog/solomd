<script setup lang="ts">
/** v4.6 F1 — display-mode menu. A dropdown on a property's label that lets the
 *  user re-cast how the value is rendered/edited (text → status → date …). The
 *  chosen mode is an out-of-band override (persisted to `.solomd/properties.json`
 *  via the properties store) — it is NEVER written into the note. When the new
 *  mode implies a different JS shape (e.g. text → tags), we also coerce + write
 *  the value so the persisted frontmatter matches the new mode. */
import { computed } from 'vue';
import { DsDropdown, type DsDropdownItem } from '../../ui';
import { useI18n } from '../../i18n';
import Icons from '../Icons.vue';
import {
  DISPLAY_MODES,
  coerceForMode,
  type DisplayMode,
} from '../../lib/property-types';

const { t } = useI18n();

const props = defineProps<{ effectiveMode: DisplayMode; value: unknown }>();
const emit = defineEmits<{ recast: [DisplayMode] }>();

const items = computed<DsDropdownItem[]>(() =>
  DISPLAY_MODES.map((m) => ({ value: m, label: t(`inspector.modes.${m}`) })),
);

function onSelect(mode: string) {
  const m = mode as DisplayMode;
  if (m === props.effectiveMode) return;
  emit('recast', m);
}

// Exposed for callers that want to coerce the value at the same call site.
defineExpose({ coerceForMode });
</script>

<template>
  <DsDropdown :items="items" align="start" @select="onSelect">
    <template #trigger>
      <button type="button" class="prop-mode-btn" :title="t('inspector.changeType')" :aria-label="t('inspector.changeType')">
        <span class="prop-mode-btn__label">{{ t(`inspector.modes.${effectiveMode}`) }}</span>
        <Icons class="prop-mode-btn__chevron" name="chevron-down" :size="10" />
      </button>
    </template>
    <template #item="{ item }">
      <span class="prop-mode-item" :class="{ 'prop-mode-item--active': item.value === effectiveMode }">
        {{ item.label }}
      </span>
    </template>
  </DsDropdown>
</template>

<style scoped>
.prop-mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 18px;
  padding: 0 4px;
  border: 0;
  border-radius: var(--r-xs);
  background: transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.prop-mode-btn:hover {
  background: var(--fill-1);
  color: var(--text);
}
.prop-mode-btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.prop-mode-btn__chevron {
  flex: 0 0 auto;
}
.prop-mode-item {
  display: block;
}
.prop-mode-item--active {
  color: var(--accent-text);
  font-weight: 600;
}
</style>
