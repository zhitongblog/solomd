<script setup lang="ts">
/**
 * F2 — Types sidebar panel (types-as-lenses).
 *
 * First-class sidebar sections derived from the workspace index: every note
 * with `type: <Name>` is grouped under a collapsible section; a type-
 * definition note (`type: Type`) supplies the section's icon / color / order
 * / label / pinned properties. Built on the pure registry in
 * `lib/types-registry.ts` via the `types` store, so it refreshes for free on
 * every `solomd://index-updated` event.
 *
 * v4.6.1 — migrated to the `ui/` design system (DsPanel / DsButton / DsListRow
 * / DsChip), and a type section can now be expanded into a full-pane lens
 * (TypeLensView) by clicking the section's "view all" affordance.
 *
 * Structure (design-system tokens only, no raw hex):
 *   - DsPanel shell: uppercase title, `+` create action, host × close
 *   - one collapsible section per type: caret, icon (tinted by `--type-<color>`),
 *     label (sidebar_label || pluralized name), tabular-nums count chip,
 *     "open lens" + gear actions on hover
 *   - member rows (DsListRow); clicking opens the note via files.openPath
 *   - pinned-property chips per member (DsChip; read-only bases value formatting)
 *
 * i18n keys (en.ts): types.heading, types.empty, types.openFolder,
 *   types.newTypeTooltip, types.customizeTooltip, types.openLensTooltip
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icons from './Icons.vue';
import CreateTypeDialog from './CreateTypeDialog.vue';
import TypeCustomizePopover from './TypeCustomizePopover.vue';
import { DsPanel, DsButton, DsChip, DsListRow } from '../ui';
import { useTypesStore } from '../stores/types';
import { useFiles } from '../composables/useFiles';
import { useTypeLens } from '../composables/useTypeLens';
import { useI18n } from '../i18n';
import type { TypeMember, TypeSection } from '../lib/types-registry';

const types = useTypesStore();
const files = useFiles();
const lens = useTypeLens();
const { t } = useI18n();

defineEmits<{ (e: 'close'): void }>();

const sections = computed<TypeSection[]>(() => types.sections);
const hasFolder = computed(() => types.hasFolder);

/** Collapsed state per type name (default expanded). */
const collapsed = ref<Record<string, boolean>>({});
function toggle(name: string) {
  collapsed.value[name] = !collapsed.value[name];
}
function isCollapsed(name: string): boolean {
  return collapsed.value[name] === true;
}

// Create dialog ------------------------------------------------------------
const createOpen = ref(false);
// The `type.create` command (command palette) dispatches this so a new type
// can be created without having to click the panel's `+`.
function onCreateTypeEvent() {
  createOpen.value = true;
}
onMounted(() => window.addEventListener('solomd:create-type', onCreateTypeEvent));
onBeforeUnmount(() =>
  window.removeEventListener('solomd:create-type', onCreateTypeEvent),
);

// Customize popover --------------------------------------------------------
const customizeOpen = ref(false);
const customizeName = ref('');
const customizeAnchor = ref<{ x: number; y: number } | null>(null);
function openCustomize(section: TypeSection, ev: MouseEvent) {
  ev.stopPropagation();
  customizeName.value = section.name;
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  customizeAnchor.value = { x: rect.left, y: rect.bottom + 4 };
  customizeOpen.value = true;
}

/** Expand a type into the full-pane lens (TypeLensView). */
function openLens(section: TypeSection, ev: MouseEvent) {
  ev.stopPropagation();
  lens.openTypeLens(section.name);
}

function openMember(m: TypeMember) {
  files.openPath(m.path);
}

/**
 * Read-only value formatting for a pinned-property chip. Kept local + tiny —
 * arrays join, everything else stringifies. (Bases' richer ColumnDef
 * formatting needs a column descriptor per key; the lens view uses that, but
 * for compact sidebar chips this is enough.)
 */
function pinnedValue(m: TypeMember, key: string): string {
  const v = m.frontmatter[key];
  if (v == null || v === '') return '';
  if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

function memberPinned(
  m: TypeMember,
  pinned: string[],
): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const key of pinned) {
    const value = pinnedValue(m, key);
    if (value) out.push({ key, value });
  }
  return out;
}
</script>

<template>
  <DsPanel grip :title="t('types.heading')" @close="$emit('close')">
    <template #actions>
      <DsButton
        size="sm"
        variant="ghost"
        :title="t('types.newTypeTooltip')"
        @click="createOpen = true"
      >+</DsButton>
    </template>

    <div v-if="!hasFolder" class="types-panel__empty">
      {{ t('types.openFolder') }}
    </div>
    <div v-else-if="sections.length === 0" class="types-panel__empty">
      {{ t('types.empty') }}
    </div>

    <div v-else class="types-panel__list">
      <section
        v-for="sec in sections"
        :key="sec.name"
        class="types-panel__section"
        :style="{ '--type-accent': `var(--type-${sec.color})` }"
      >
        <div class="types-panel__section-head" @click="toggle(sec.name)">
          <span
            class="types-panel__caret"
            :class="{ 'types-panel__caret--collapsed': isCollapsed(sec.name) }"
          >▾</span>
          <span class="types-panel__icon">
            <Icons :name="sec.icon" :size="15" />
          </span>
          <span class="types-panel__label">{{ sec.label }}</span>
          <DsChip size="sm" class="types-panel__count">{{ sec.members.length }}</DsChip>
          <button
            class="types-panel__act"
            type="button"
            :title="t('types.openLensTooltip')"
            @click="openLens(sec, $event)"
          >⤢</button>
          <button
            class="types-panel__act"
            type="button"
            :title="t('types.customizeTooltip')"
            @click="openCustomize(sec, $event)"
          >⚙</button>
        </div>

        <ul v-if="!isCollapsed(sec.name)" class="types-panel__members">
          <li v-if="sec.members.length === 0" class="types-panel__member-empty">
            {{ t('types.sectionEmpty') }}
          </li>
          <li
            v-for="m in sec.members"
            :key="m.path"
          >
            <DsListRow @click="openMember(m)">
              <span class="types-panel__member-body">
                <span class="types-panel__member-title">{{ m.title }}</span>
                <span
                  v-if="memberPinned(m, sec.pinned).length"
                  class="types-panel__chips"
                >
                  <DsChip
                    v-for="chip in memberPinned(m, sec.pinned)"
                    :key="chip.key"
                    size="sm"
                    :title="`${chip.key}: ${chip.value}`"
                  >{{ chip.value }}</DsChip>
                </span>
              </span>
            </DsListRow>
          </li>
        </ul>
      </section>
    </div>

    <CreateTypeDialog :open="createOpen" @close="createOpen = false" />
    <TypeCustomizePopover
      :open="customizeOpen"
      :type-name="customizeName"
      :anchor="customizeAnchor"
      @close="customizeOpen = false"
    />
  </DsPanel>
</template>

<style scoped>
.types-panel__empty {
  padding: var(--sp-5) var(--sp-4);
  text-align: center;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
}
.types-panel__list {
  padding: var(--sp-1);
}
.types-panel__section {
  margin-bottom: 2px;
}
.types-panel__section-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border-radius: var(--r-md);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.types-panel__section-head:hover {
  background: var(--bg-hover);
}
.types-panel__caret {
  font-size: 9px;
  color: var(--text-faint);
  transition: transform var(--dur-fast) var(--ease);
  flex-shrink: 0;
  width: 10px;
  text-align: center;
}
.types-panel__caret--collapsed {
  transform: rotate(-90deg);
}
.types-panel__icon {
  display: flex;
  align-items: center;
  color: var(--type-accent, var(--accent));
  flex-shrink: 0;
}
.types-panel__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.types-panel__count {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.types-panel__act {
  background: transparent;
  border: none;
  color: var(--text-faint);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 2px 3px;
  border-radius: var(--r-sm);
  opacity: 0;
  flex-shrink: 0;
  transition: opacity var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}
.types-panel__section-head:hover .types-panel__act {
  opacity: 1;
}
.types-panel__act:hover {
  color: var(--text);
  background: var(--bg-elev);
}
.types-panel__members {
  list-style: none;
  margin: 0;
  padding: 2px 0 var(--sp-1) 18px;
}
.types-panel__member-empty {
  font-size: 11px;
  color: var(--text-faint);
  font-style: italic;
  padding: var(--sp-1) var(--sp-3);
}
.types-panel__member-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-width: 0;
  width: 100%;
}
.types-panel__member-title {
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.types-panel__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
}
</style>
