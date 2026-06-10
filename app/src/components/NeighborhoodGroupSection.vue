<script setup lang="ts">
/**
 * v4.6 F4 — one collapsible relationship group inside the Neighborhood pane
 * (port of Tolaria's RelationshipGroupSection.tsx). Header shows humanized
 * label + count + caret; each row emits `navigate` (plain click) or `pivot`
 * (cmd/ctrl-click). Styling mirrors BacklinksPanel raw CSS-var markup.
 */
import { ref } from 'vue';
import type { NeighborGroup, NeighborRef } from '../composables/useNeighborhood';

defineProps<{ group: NeighborGroup }>();
const emit = defineEmits<{ navigate: [NeighborRef]; pivot: [NeighborRef] }>();

const collapsed = ref(false);

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
    <button class="nbgroup__head" type="button" @click="collapsed = !collapsed">
      <span class="nbgroup__caret" :class="{ 'nbgroup__caret--collapsed': collapsed }">▾</span>
      <span class="nbgroup__label">{{ group.label }}</span>
      <span class="nbgroup__count">{{ group.refs.length }}</span>
    </button>
    <ul v-if="!collapsed" class="nbgroup__list">
      <li v-for="r in group.refs" :key="r.path" class="nbgroup__item">
        <button class="nbgroup__row" type="button" @click="onRowClick($event, r)">
          <span class="nbgroup__title">{{ r.title }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.nbgroup {
  margin: 2px 0;
}
.nbgroup__head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  padding: 5px 8px;
  cursor: pointer;
  border-radius: 6px;
  color: var(--text-muted);
}
.nbgroup__head:hover {
  background: var(--bg-hover);
}
.nbgroup__caret {
  font-size: 10px;
  color: var(--text-faint);
  transition: transform 0.12s;
}
.nbgroup__caret--collapsed {
  transform: rotate(-90deg);
}
.nbgroup__label {
  flex: 1;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nbgroup__count {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 7px;
  font-size: 10px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.nbgroup__list {
  list-style: none;
  margin: 0;
  padding: 0 0 0 8px;
}
.nbgroup__row {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.nbgroup__row:hover {
  background: var(--bg-hover);
  border-color: var(--border);
}
.nbgroup__title {
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
}
</style>
