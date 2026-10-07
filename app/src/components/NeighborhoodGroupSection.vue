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
import Icons from './Icons.vue';
import '../styles/panels.css';
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
    <button
      type="button"
      class="rp-row nbgroup__head"
      :aria-expanded="!collapsed"
      @click="collapsed = !collapsed"
    >
      <Icons
        class="nbgroup__caret"
        :class="{ 'nbgroup__caret--collapsed': collapsed }"
        name="chevron-down"
        :size="12"
      />
      <span class="rp-row__label nbgroup__label">{{ group.label }}</span>
      <span class="rp-count">{{ group.refs.length }}</span>
    </button>

    <div v-if="!collapsed" class="nbgroup__list" role="list">
      <button
        v-for="r in visibleRefs"
        :key="r.path"
        type="button"
        class="rp-row nbgroup__row"
        :class="{ 'is-active': r.path === focalPath }"
        :title="r.path"
        @click="onRowClick($event, r)"
      >
        <Icons class="rp-row__icon" name="file" :size="14" />
        <span class="rp-row__label nbgroup__title">{{ r.title }}</span>
      </button>

      <button
        v-if="hiddenCount > 0 && !expanded"
        class="rp-row nbgroup__more"
        type="button"
        @click="expanded = true"
      >{{ t('neighborhood.showMore', { n: hiddenCount }) }}</button>
    </div>
  </section>
</template>

<style scoped>
.nbgroup {
  margin: 2px 0;
}
.nbgroup__head {
  color: var(--text-2);
}
.nbgroup__caret {
  flex: 0 0 auto;
  color: var(--text-3);
  transition: transform var(--dur-fast) var(--ease);
}
.nbgroup__caret--collapsed {
  transform: rotate(-90deg);
}
.nbgroup__label {
  font-size: 12px;
  font-weight: 500;
}
.nbgroup__list {
  /* Cap tall groups so a large fan-out scrolls instead of pushing the panel. */
  max-height: 320px;
  overflow-y: auto;
  padding-left: 12px;
}
.nbgroup__more {
  padding-left: 30px;
  font-size: 12px;
  color: var(--accent-text);
}
</style>
