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
import { ref, computed, watch } from 'vue';
import { createTypeRequested } from '../lib/create-type-request';
import Icons from './Icons.vue';
import CreateTypeDialog from './CreateTypeDialog.vue';
import TypeCustomizePopover from './TypeCustomizePopover.vue';
import PanelHeader from './panel/PanelHeader.vue';
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
// The Types: New Type… command (see lib/create-type-request.ts).
watch(
  createTypeRequested,
  (asked) => {
    if (!asked) return;
    createTypeRequested.value = false;
    createOpen.value = true;
  },
  { immediate: true },
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
  <div class="types-panel rp">
    <PanelHeader :title="t('types.heading')" @close="$emit('close')">
      <button
        type="button"
        class="rp-icon-btn"
        :title="t('types.newTypeTooltip')"
        :aria-label="t('types.newTypeTooltip')"
        @click="createOpen = true"
      >
        <Icons name="plus" :size="14" />
      </button>
    </PanelHeader>

    <div v-if="!hasFolder" class="rp-empty">
      {{ t('types.openFolder') }}
    </div>
    <div v-else-if="sections.length === 0" class="rp-empty">
      {{ t('types.empty') }}
    </div>

    <div v-else class="types-panel__list rp-body">
      <section
        v-for="sec in sections"
        :key="sec.name"
        class="types-panel__section"
        :style="{ '--type-accent': `var(--type-${sec.color})` }"
      >
        <div
          class="rp-row types-panel__section-head"
          role="button"
          tabindex="0"
          :aria-expanded="!isCollapsed(sec.name)"
          @click="toggle(sec.name)"
          @keydown.enter.self.prevent="toggle(sec.name)"
          @keydown.space.self.prevent="toggle(sec.name)"
        >
          <Icons
            class="types-panel__caret"
            :class="{ 'types-panel__caret--collapsed': isCollapsed(sec.name) }"
            name="chevron-down"
            :size="12"
          />
          <span class="types-panel__icon">
            <Icons :name="sec.icon" :size="15" />
          </span>
          <span class="rp-row__label types-panel__label">{{ sec.label }}</span>
          <span class="rp-row__actions">
            <button
              class="rp-icon-btn types-panel__act"
              type="button"
              :title="t('types.openLensTooltip')"
              :aria-label="t('types.openLensTooltip')"
              @click="openLens(sec, $event)"
            ><Icons name="external" :size="13" /></button>
            <button
              class="rp-icon-btn types-panel__act"
              type="button"
              :title="t('types.customizeTooltip')"
              :aria-label="t('types.customizeTooltip')"
              @click="openCustomize(sec, $event)"
            ><Icons name="settings" :size="13" /></button>
          </span>
          <span class="rp-count types-panel__count">{{ sec.members.length }}</span>
        </div>

        <ul v-if="!isCollapsed(sec.name)" class="rp-list types-panel__members">
          <li v-if="sec.members.length === 0" class="rp-sub types-panel__member-empty">
            {{ t('types.sectionEmpty') }}
          </li>
          <li
            v-for="m in sec.members"
            :key="m.path"
          >
            <button
              type="button"
              class="rp-row types-panel__member"
              :class="{ 'rp-row--tall': memberPinned(m, sec.pinned).length > 0 }"
              @click="openMember(m)"
            >
              <span class="rp-row__label types-panel__member-title">{{ m.title }}</span>
              <span
                v-if="memberPinned(m, sec.pinned).length"
                class="rp-chips types-panel__chips"
              >
                <span
                  v-for="chip in memberPinned(m, sec.pinned)"
                  :key="chip.key"
                  class="rp-chip types-panel__chip"
                  :title="`${chip.key}: ${chip.value}`"
                >{{ chip.value }}</span>
              </span>
            </button>
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
  </div>
</template>

<style scoped>
.types-panel__section {
  margin-bottom: 2px;
}
.types-panel__section-head {
  font-weight: 500;
}
.types-panel__caret {
  flex: 0 0 auto;
  margin-right: -2px;
  color: var(--text-3);
  transition: transform var(--dur-fast) var(--ease);
}
.types-panel__caret--collapsed {
  transform: rotate(-90deg);
}
.types-panel__icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--type-accent, var(--accent));
}
.types-panel__section-head .rp-row__actions {
  margin-left: 0;
}
.types-panel__section-head .rp-count {
  margin-left: 0;
  min-width: 14px;
  text-align: right;
}
.types-panel__act {
  width: 22px;
  height: 22px;
}
.types-panel__members {
  padding: 0 0 4px 20px;
}
.types-panel__member-empty {
  padding: 4px 8px;
}
.types-panel__member-title {
  width: 100%;
}
.types-panel__chips {
  gap: 4px;
  padding-bottom: 2px;
}
.types-panel__chip {
  height: 18px;
  padding: 0 6px;
  font-size: 11px;
  cursor: inherit;
}
</style>
