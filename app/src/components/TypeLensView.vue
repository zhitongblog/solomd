<script setup lang="ts">
/**
 * v4.6.1 F2 — Type lens (center-pane filtered view of one type's members).
 *
 * The deepening of types-as-lenses: clicking a type section header (or its
 * "view all" affordance) in TypesPanel opens this full-pane view, listing
 * every member of that type with its pinned-property columns. Mirrors the
 * InboxView / BasesView / ViewNoteList content-swap convention exactly:
 *
 *   - opened by the `solomd:open-type-lens` window CustomEvent (detail.typeName);
 *     App.vue captures the name and mounts this view `v-else-if="typeLensOpen"`
 *     inside `.content`, passing the focused type down as the `typeName` prop
 *   - the editor / Bases / Inbox swaps are untouched
 *
 * Surface (all design-system tokens, no raw hex):
 *   - sticky header: Back button, tinted type icon, label + live member count,
 *     a "Customize" button that re-uses TypeCustomizePopover
 *   - a table whose columns are the type's pinned properties (resolved through
 *     bases column inference so values format exactly like Bases / Inbox), plus
 *     a leading Name column
 *   - a per-row inline type-reassignment select (writes via the store's
 *     frontmatter splice → body bytes preserved)
 *   - a 0-member empty state
 *
 * Reads everything live off the `types` store, so a `solomd://index-updated`
 * event (after any member write) re-derives the section and the table updates
 * for free. Value formatting is a READ-ONLY import from `lib/bases.ts`.
 */
import { computed, ref } from 'vue';
import Icons from './Icons.vue';
import TypeCustomizePopover from './TypeCustomizePopover.vue';
import { DsButton, DsChip, DsSelect } from '../ui';
import type { DsSelectOption } from '../ui';
import { useTypesStore } from '../stores/types';
import { useWorkspaceIndexStore, type IndexEntry } from '../stores/workspaceIndex';
import { useFiles } from '../composables/useFiles';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';
import { inferColumns, getCellValue, type ColumnDef } from '../lib/bases';
import { TYPE_LENS_CLOSE_EVENT } from '../composables/useTypeLens';
import type { TypeMember } from '../lib/types-registry';

const props = defineProps<{ typeName: string }>();

const types = useTypesStore();
const idx = useWorkspaceIndexStore();
const files = useFiles();
const toasts = useToastsStore();
const { t } = useI18n();

/** The type this lens is focused on (driven by App.vue from the open event). */
const typeName = computed(() => props.typeName);

/** Live section for the focused type (re-derives on index-updated). */
const section = computed(() => types.sectionOf(typeName.value));
const members = computed<TypeMember[]>(() => section.value?.members ?? []);
const pinned = computed<string[]>(() => section.value?.pinned ?? []);

const sectionStyle = computed(() => ({
  '--type-accent': `var(--type-${section.value?.color ?? 'orange'})`,
}));

/**
 * Resolve each pinned key to a bases ColumnDef so values format identically to
 * Bases / Inbox (dates, arrays, booleans, numbers). If the key isn't among the
 * inferred frontmatter columns (e.g. sparsely populated), fall back to a plain
 * text frontmatter column so it still renders.
 */
const pinnedColumns = computed<ColumnDef[]>(() => {
  const inferred = inferColumns(idx.entries).filter(
    (c) => c.source === 'frontmatter',
  );
  return pinned.value.map((key) => {
    const hit = inferred.find((c) => c.fmKey === key);
    return (
      hit ?? {
        id: `fm:${key}`,
        label: key,
        kind: 'text' as const,
        source: 'frontmatter' as const,
        fmKey: key,
      }
    );
  });
});

/** All type names available for the per-row reassignment dropdown. */
const typeOptions = computed<DsSelectOption[]>(() => {
  const opts: DsSelectOption[] = [{ value: '', label: t('typeLens.unassigned') }];
  for (const sec of types.sections) {
    opts.push({ value: sec.name, label: sec.name });
  }
  // Ensure the current type is present even if it had only this member.
  if (typeName.value && !opts.some((o) => o.value === typeName.value)) {
    opts.push({ value: typeName.value, label: typeName.value });
  }
  return opts;
});

function cellValue(m: TypeMember, col: ColumnDef): string {
  const entry = idx.byPath.get(m.path);
  const source: IndexEntry =
    entry ??
    // Synthesize a minimal IndexEntry from the member when the path isn't in
    // the cached index yet (e.g. a just-created note mid-rescan).
    ({
      path: m.path,
      stem: m.stem,
      name: m.stem,
      title: m.title,
      frontmatter: m.frontmatter,
    } as unknown as IndexEntry);
  const v = getCellValue(source, col);
  return v == null ? '' : String(v);
}

async function openMember(m: TypeMember) {
  await files.openPath(m.path, { bypassNewWindow: true });
  // Opening a member returns to the editor — same intent as clicking a row in
  // a saved view. Dismiss the lens so the note is visible.
  close();
}

/** Pending reassignment per path so the row can show a busy state. */
const reassigning = ref<Record<string, boolean>>({});

async function reassign(m: TypeMember, next: string) {
  if (reassigning.value[m.path]) return;
  reassigning.value = { ...reassigning.value, [m.path]: true };
  try {
    await types.setMemberType(m.path, next === '' ? null : next);
  } catch (e) {
    toasts.error(t('typeLens.reassignFailed', { error: String(e) }));
  } finally {
    const { [m.path]: _drop, ...rest } = reassigning.value;
    reassigning.value = rest;
  }
}

// Customize popover (re-use the panel's editor) -----------------------------
const customizeOpen = ref(false);
const customizeAnchor = ref<{ x: number; y: number } | null>(null);
function openCustomize(ev: MouseEvent) {
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  customizeAnchor.value = { x: rect.left, y: rect.bottom + 4 };
  customizeOpen.value = true;
}

function close() {
  window.dispatchEvent(new CustomEvent(TYPE_LENS_CLOSE_EVENT));
}
</script>

<template>
  <div class="type-lens" :style="sectionStyle">
    <header class="type-lens__head">
      <div class="type-lens__head-left">
        <DsButton size="sm" variant="ghost" @click="close">
          {{ t('typeLens.back') }}
        </DsButton>
        <span class="type-lens__icon">
          <Icons :name="section?.icon ?? 'type-generic'" :size="18" />
        </span>
        <strong class="type-lens__title">{{ section?.label ?? typeName }}</strong>
        <DsChip size="sm">{{ members.length }}</DsChip>
      </div>
      <div class="type-lens__head-actions">
        <DsButton size="sm" variant="subtle" @click="openCustomize">
          {{ t('typeLens.customize') }}
        </DsButton>
      </div>
    </header>

    <div v-if="members.length === 0" class="type-lens__zero">
      <span class="type-lens__zero-icon">
        <Icons :name="section?.icon ?? 'type-generic'" :size="28" />
      </span>
      <p class="type-lens__zero-title">{{ t('typeLens.zeroTitle') }}</p>
      <p class="type-lens__zero-sub">
        {{ t('typeLens.zeroSub', { type: typeName }) }}
      </p>
    </div>

    <div v-else class="type-lens__scroll">
      <table class="type-lens__table">
        <thead>
          <tr>
            <th class="type-lens__th type-lens__th--name">{{ t('typeLens.name') }}</th>
            <th
              v-for="col in pinnedColumns"
              :key="col.id"
              class="type-lens__th"
            >{{ col.label }}</th>
            <th class="type-lens__th type-lens__th--type">{{ t('typeLens.type') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="m in members"
            :key="m.path"
            class="type-lens__row"
          >
            <td class="type-lens__td type-lens__td--name">
              <button class="type-lens__name-btn" @click="openMember(m)">
                {{ m.title }}
              </button>
            </td>
            <td
              v-for="col in pinnedColumns"
              :key="col.id"
              class="type-lens__td"
            >
              <span v-if="cellValue(m, col)" class="type-lens__cell">
                {{ cellValue(m, col) }}
              </span>
              <span v-else class="type-lens__cell-empty">—</span>
            </td>
            <td class="type-lens__td type-lens__td--type">
              <DsSelect
                size="sm"
                :options="typeOptions"
                :model-value="typeName"
                :disabled="reassigning[m.path]"
                @update:model-value="(v) => reassign(m, v)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <TypeCustomizePopover
      :open="customizeOpen"
      :type-name="typeName"
      :anchor="customizeAnchor"
      @close="customizeOpen = false"
    />
  </div>
</template>

<style scoped>
.type-lens {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}
.type-lens__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: var(--bd);
  background: var(--bg-elev);
  flex-wrap: wrap;
}
.type-lens__head-left {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}
.type-lens__icon {
  display: inline-flex;
  align-items: center;
  color: var(--type-accent, var(--accent));
  flex-shrink: 0;
}
.type-lens__title {
  font-size: 14px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.type-lens__head-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
}
.type-lens__scroll {
  flex: 1;
  overflow: auto;
  min-height: 0;
}
.type-lens__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.type-lens__th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  background: var(--bg-elev);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: var(--bd);
  white-space: nowrap;
}
.type-lens__th--type {
  width: 168px;
}
.type-lens__row {
  border-bottom: 1px solid var(--border);
  transition: background var(--dur-fast) var(--ease);
}
.type-lens__row:hover {
  background: var(--bg-hover);
}
.type-lens__td {
  padding: var(--sp-1) var(--sp-3);
  color: var(--text);
  vertical-align: middle;
  max-width: 280px;
}
.type-lens__td--type {
  width: 168px;
}
.type-lens__name-btn {
  background: transparent;
  border: none;
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  padding: var(--sp-2) 0;
  border-radius: var(--r-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.type-lens__name-btn:hover {
  color: var(--accent);
  text-decoration: underline;
}
.type-lens__name-btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.type-lens__cell {
  display: inline-block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
  color: var(--text-muted);
}
.type-lens__cell-empty {
  color: var(--text-faint);
}
.type-lens__zero {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-6);
  text-align: center;
}
.type-lens__zero-icon {
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-full);
  background: var(--bg-hover);
  color: var(--type-accent, var(--accent));
}
.type-lens__zero-title {
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}
.type-lens__zero-sub {
  color: var(--text-muted);
  font-size: 13px;
  margin: 0;
  max-width: 360px;
}
</style>
