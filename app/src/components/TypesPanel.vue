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
 * Structure mirrors TagsPanel.vue (same chrome + design tokens):
 *   - uppercase muted header with a `+` (create type) and the rs-pane × close
 *   - one collapsible section per type: icon (tinted by `--type-<color>`),
 *     label (sidebar_label || pluralized name), tabular-nums count chip,
 *     hover gear → TypeCustomizePopover
 *   - member rows; clicking opens the note via files.openPath
 *   - pinned-property chips per member (read-only value formatting)
 *
 * i18n keys (en.ts): types.heading, types.empty, types.openFolder,
 *   types.newTypeTooltip, types.customizeTooltip
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icons from './Icons.vue';
import CreateTypeDialog from './CreateTypeDialog.vue';
import TypeCustomizePopover from './TypeCustomizePopover.vue';
import { useTypesStore } from '../stores/types';
import { useFiles } from '../composables/useFiles';
import { useI18n } from '../i18n';
import type { TypeMember, TypeSection } from '../lib/types-registry';

const types = useTypesStore();
const files = useFiles();
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

function openMember(m: TypeMember) {
  files.openPath(m.path);
}

/**
 * Read-only value formatting for a pinned-property chip. Kept local + tiny —
 * arrays join, everything else stringifies. (Bases' richer ColumnDef
 * formatting needs a column descriptor per key; not worth it for chips.)
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
  <div class="types-panel">
    <header class="types-panel__head">
      <span class="types-panel__title">{{ t('types.heading') }}</span>
      <div class="types-panel__actions">
        <button
          class="types-panel__btn"
          :title="t('types.newTypeTooltip')"
          @click="createOpen = true"
        >+</button>
      </div>
      <button
        class="rs-pane-close"
        type="button"
        :title="t('rightSidebar.hidePane')"
        @click="$emit('close')"
      >×</button>
    </header>

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
          <span class="types-panel__count">{{ sec.members.length }}</span>
          <button
            class="types-panel__gear"
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
            class="types-panel__member"
          >
            <button class="types-panel__member-row" @click="openMember(m)">
              <span class="types-panel__member-title">{{ m.title }}</span>
              <span
                v-if="memberPinned(m, sec.pinned).length"
                class="types-panel__chips"
              >
                <span
                  v-for="chip in memberPinned(m, sec.pinned)"
                  :key="chip.key"
                  class="types-panel__chip"
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
.types-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  overflow: hidden;
}
.types-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
  gap: 8px;
}
.types-panel__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.types-panel__actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
}
.types-panel__btn {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text-muted);
  border-radius: 4px;
  padding: 0 8px;
  font-size: 14px;
  line-height: 18px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.types-panel__btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.types-panel__empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
}
.types-panel__list {
  overflow-y: auto;
  flex: 1;
  padding: 4px;
}
.types-panel__section {
  margin-bottom: 2px;
}
.types-panel__section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s;
}
.types-panel__section-head:hover {
  background: var(--bg-hover);
}
.types-panel__caret {
  font-size: 9px;
  color: var(--text-faint);
  transition: transform 0.12s;
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
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.types-panel__gear {
  background: transparent;
  border: none;
  color: var(--text-faint);
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
  opacity: 0;
  flex-shrink: 0;
  transition: opacity 0.12s, color 0.12s;
}
.types-panel__section-head:hover .types-panel__gear {
  opacity: 1;
}
.types-panel__gear:hover {
  color: var(--text);
}
.types-panel__members {
  list-style: none;
  margin: 0;
  padding: 2px 0 4px 18px;
}
.types-panel__member-empty {
  font-size: 11px;
  color: var(--text-faint);
  font-style: italic;
  padding: 4px 10px;
}
.types-panel__member-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  width: 100%;
  background: transparent;
  border: 1px solid transparent;
  padding: 5px 10px;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s, border-color 0.12s;
}
.types-panel__member-row:hover {
  background: var(--bg-hover);
  border-color: var(--border);
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
  gap: 4px;
}
.types-panel__chip {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text-muted);
  max-width: 120px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
