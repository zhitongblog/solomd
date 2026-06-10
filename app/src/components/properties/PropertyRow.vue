<script setup lang="ts">
/** v4.6 F1 — a single property row in the inspector: a 2-col layout of
 *  [ label (+ display-mode menu, pin, delete-on-hover) | mode-specific value
 *  cell ]. The row owns no write logic — it emits semantic events that the
 *  PropertiesInspector wires to the properties store / Rust round-trip. */
import { computed } from 'vue';
import type { DisplayMode } from '../../lib/property-types';
import DisplayModeMenu from './DisplayModeMenu.vue';
import TextCell from './value-cells/TextCell.vue';
import NumberCell from './value-cells/NumberCell.vue';
import BooleanCell from './value-cells/BooleanCell.vue';
import DateCell from './value-cells/DateCell.vue';
import StatusCell from './value-cells/StatusCell.vue';
import UrlCell from './value-cells/UrlCell.vue';
import TagsCell from './value-cells/TagsCell.vue';
import RelationCell from './value-cells/RelationCell.vue';

const props = defineProps<{
  propKey: string;
  value: unknown;
  mode: DisplayMode;
  pinned: boolean;
}>();

const emit = defineEmits<{
  update: [unknown];
  remove: [];
  recast: [DisplayMode];
  togglePin: [];
}>();

const isPlaceholder = computed(() => props.value == null || props.value === '');
</script>

<template>
  <div class="prop-row">
    <div class="prop-row__label">
      <button
        type="button"
        class="prop-row__pin"
        :class="{ 'prop-row__pin--on': pinned }"
        :title="pinned ? 'Unpin' : 'Pin'"
        @click="emit('togglePin')"
      >★</button>
      <span class="prop-row__key" :title="propKey">{{ propKey }}</span>
      <span class="prop-row__meta">
        <DisplayModeMenu :effective-mode="mode" :value="value" @recast="emit('recast', $event)" />
        <button type="button" class="prop-row__del" title="Delete property" @click="emit('remove')">×</button>
      </span>
    </div>

    <div class="prop-row__value" :class="{ 'prop-row__value--placeholder': isPlaceholder }">
      <BooleanCell v-if="mode === 'boolean'" :value="value" @update="emit('update', $event)" />
      <NumberCell v-else-if="mode === 'number'" :value="value" @update="emit('update', $event)" />
      <DateCell v-else-if="mode === 'date'" :value="value" @update="emit('update', $event)" />
      <StatusCell v-else-if="mode === 'status'" :value="value" @update="emit('update', $event)" />
      <UrlCell v-else-if="mode === 'url'" :value="value" @update="emit('update', $event)" />
      <TagsCell v-else-if="mode === 'tags'" :value="value" :prop-key="propKey" @update="emit('update', $event)" />
      <RelationCell v-else-if="mode === 'relation'" :value="value" @update="emit('update', $event)" />
      <TextCell v-else :value="value" @update="emit('update', $event)" />
    </div>
  </div>
</template>

<style scoped>
.prop-row {
  display: grid;
  grid-template-columns: minmax(96px, 38%) 1fr;
  column-gap: var(--sp-3);
  align-items: start;
  border-radius: var(--r-sm);
}
.prop-row:hover {
  background: var(--bg-hover);
}
.prop-row__label {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
  padding: var(--sp-1) 0;
}
.prop-row__pin {
  background: transparent;
  border: none;
  color: var(--border);
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  padding: 0 2px;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.prop-row:hover .prop-row__pin,
.prop-row__pin--on {
  opacity: 1;
}
.prop-row__pin--on {
  color: var(--warning);
}
.prop-row__key {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prop-row__meta {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease);
}
.prop-row:hover .prop-row__meta {
  opacity: 1;
}
.prop-row__del {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  border-radius: var(--r-sm);
}
.prop-row__del:hover {
  color: var(--danger);
}
.prop-row__value {
  display: flex;
  align-items: center;
  min-width: 0;
  padding: var(--sp-1) 0;
  font-size: 13px;
  color: var(--text);
}
</style>
