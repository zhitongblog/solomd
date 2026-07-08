<script setup lang="ts">
/**
 * v4.6.1 F4 — one collapsible relationship group inside the Neighborhood pane
 * (port of Tolaria's RelationshipGroupSection.tsx). Header shows humanized
 * label + count + caret; each row emits `navigate` (plain click) or `pivot`
 * (cmd/ctrl-click).
 *
 * Migrated to the design system: header is a DsListRow, count is a DsChip,
 * rows are DsListRows. Large fan-out groups are capped with a "Show N more"
 * affordance and the list scrolls past a height cap so a 200-edge group can't
 * blow out the panel.
 */
import { computed, ref } from 'vue';
import { DsChip, DsListRow } from '../ui';
import { useI18n } from '../i18n';
import type { NeighborGroup, NeighborRef } from '../composables/useNeighborhood';

const props = defineProps<{
  group: NeighborGroup;
  /** Path of the currently focal note — rendered with a subtle marker if it
   *  appears inside the group (cyclical relationship). */
  focalPath?: string | null;
}>();
const emit = defineEmits<{ navigate: [NeighborRef]; pivot: [NeighborRef] }>();

const { t } = useI18n();

const collapsed = ref(false);

/** Initial visible cap for large fan-out groups; "Show more" reveals the rest. */
const VISIBLE_CAP = 25;
const expanded = ref(false);

const visibleRefs = computed(() =>
  expanded.value ? props.group.refs : props.group.refs.slice(0, VISIBLE_CAP),
);
const hiddenCount = computed(() =>
  Math.max(0, props.group.refs.length - VISIBLE_CAP),
);

function onRowClick(e: MouseEvent, r: NeighborRef) {
  // cmd (mac) / ctrl (win/linux)-click pivots the panel's focal note without
  // opening the file; a plain click navigates/opens it.
  if (e.metaKey || e.ctrlKey) {
    emit('pivot', r);
  } else {
    emit('navigate', r);
  }
}
</script>

<template>
  <section class="nbgroup">
    <DsListRow class="nbgroup__head" @click="collapsed = !collapsed">
      <template #leading>
        <span
          class="nbgroup__caret"
          :class="{ 'nbgroup__caret--collapsed': collapsed }"
          aria-hidden="true"
        >▾</span>
      </template>
      <span class="nbgroup__label">{{ group.label }}</span>
      <template #trailing>
        <DsChip size="sm">{{ group.refs.length }}</DsChip>
      </template>
    </DsListRow>

    <div v-if="!collapsed" class="nbgroup__list" role="list">
      <DsListRow
        v-for="r in visibleRefs"
        :key="r.path"
        class="nbgroup__row"
        :title="r.path"
        :selected="r.path === focalPath"
        @click="onRowClick($event, r)"
      >
        <span class="nbgroup__title">{{ r.title }}</span>
      </DsListRow>

      <button
        v-if="hiddenCount > 0 && !expanded"
        class="nbgroup__more"
        type="button"
        @click="expanded = true"
      >{{ t('neighborhood.showMore', { n: hiddenCount }) }}</button>
    </div>
  </section>
</template>

<style scoped>
.nbgroup {
  margin: var(--sp-1) 0;
}
.nbgroup__head {
  color: var(--text-muted);
}
.nbgroup__caret {
  font-size: 10px;
  color: var(--text-faint);
  transition: transform var(--dur-fast) var(--ease);
  display: inline-block;
}
.nbgroup__caret--collapsed {
  transform: rotate(-90deg);
}
.nbgroup__label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nbgroup__list {
  /* Cap tall groups so a large fan-out scrolls instead of pushing the panel. */
  max-height: 320px;
  overflow-y: auto;
  padding-left: var(--sp-2);
}
.nbgroup__row {
  font-size: 12px;
}
.nbgroup__title {
  font-weight: 500;
}
.nbgroup__more {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  padding: var(--sp-1) var(--sp-3);
  margin-top: var(--sp-1);
  font-size: 11px;
  font-weight: 500;
  color: var(--accent);
  cursor: pointer;
  border-radius: var(--r-sm);
}
.nbgroup__more:hover {
  background: var(--bg-hover);
}
.nbgroup__more:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
</style>
