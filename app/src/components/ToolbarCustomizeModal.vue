<script setup lang="ts">
import { computed, ref } from 'vue';
import DsModal from '../ui/DsModal.vue';
import DsButton from '../ui/DsButton.vue';
import Icon from './Icons.vue';
import { useSettingsStore } from '../stores/settings';
import { useCommands } from '../composables/useCommands';
import {
  ALL_TOOLBAR_ITEMS,
  TOOLBAR_EMOJI_ICON_OPTIONS,
  TOOLBAR_ICON_OPTIONS,
  commandCategoryOf,
  defaultIconForCommand,
  isCustomGlyphIcon,
  normalizeToolbarItems,
  type ToolbarItemId,
} from '../lib/toolbar-items';
import { winTitleBar } from '../lib/chrome';
import { useI18n } from '../i18n';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

const settings = useSettingsStore();
const commands = computed(() => useCommands());
const { t } = useI18n();

interface AvailableEntry {
  id: ToolbarItemId;
  label: string;
  category: string;
  defaultIcon: string;
}

const categoryFilter = ref<string>('all');
const searchQuery = ref('');
const selectedAvailId = ref<ToolbarItemId | null>(null);
const selectedActiveId = ref<ToolbarItemId | null>(null);
const iconTab = ref<'mono' | 'color'>('mono');
const customGlyphInput = ref('');

const activeItems = computed<ToolbarItemId[]>(() => normalizeToolbarItems(settings.toolbarItems));
const activeSet = computed(() => new Set<string>(activeItems.value));

const allAvailable = computed<AvailableEntry[]>(() => {
  const builtins: AvailableEntry[] = ALL_TOOLBAR_ITEMS.map((item) => ({
    id: item.id,
    label: t(item.labelKey),
    category: item.group === 'git' ? 'sync' : item.group === 'writing' ? 'edit' : 'core',
    defaultIcon: item.icon,
  }));
  const cmdEntries: AvailableEntry[] = commands.value.map((c) => {
    const localized = t(`cmd.${c.id}`);
    const label = localized && localized !== `cmd.${c.id}` ? localized : c.title;
    return {
      id: `cmd:${c.id}` as ToolbarItemId,
      label,
      category: commandCategoryOf(c.id),
      defaultIcon: defaultIconForCommand(c.id),
    };
  });
  return [...builtins, ...cmdEntries];
});

const entryById = computed(() => {
  const map = new Map<string, AvailableEntry>();
  for (const e of allAvailable.value) map.set(e.id, e);
  return map;
});

const filteredAvailable = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  return allAvailable.value.filter((entry) => {
    if (categoryFilter.value !== 'all' && entry.category !== categoryFilter.value) return false;
    if (q && !entry.label.toLowerCase().includes(q) && !entry.id.toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });
});

function iconFor(id: ToolbarItemId): string {
  const custom = settings.toolbarItemIcons?.[id];
  if (custom) return custom;
  const entry = entryById.value.get(id);
  if (entry) return entry.defaultIcon;
  if (id.startsWith('cmd:')) return defaultIconForCommand(id.slice(4));
  return 'sparkles';
}

function labelFor(id: ToolbarItemId): string {
  const entry = entryById.value.get(id);
  if (entry) return entry.label;
  if (id.startsWith('cmd:')) return id.slice(4);
  return id;
}

function addSelected() {
  if (!selectedAvailId.value) return;
  if (activeSet.value.has(selectedAvailId.value)) return;
  settings.setToolbarItems([...activeItems.value, selectedAvailId.value]);
  selectedActiveId.value = selectedAvailId.value;
}

function removeSelected() {
  if (!selectedActiveId.value) return;
  const next = activeItems.value.filter((id) => id !== selectedActiveId.value);
  settings.setToolbarItems(next);
  selectedActiveId.value = next[0] ?? null;
}

function moveSelected(delta: -1 | 1) {
  if (!selectedActiveId.value) return;
  const list = [...activeItems.value];
  const idx = list.indexOf(selectedActiveId.value);
  const target = idx + delta;
  if (idx < 0 || target < 0 || target >= list.length) return;
  const [item] = list.splice(idx, 1);
  list.splice(target, 0, item);
  settings.setToolbarItems(list);
}

function pickIcon(icon: string) {
  if (!selectedActiveId.value) return;
  const trimmed = icon.trim();
  if (!trimmed) return;
  settings.setToolbarItemIcon(selectedActiveId.value, trimmed);
}

function applyCustomGlyph() {
  const val = customGlyphInput.value.trim();
  if (!val || !selectedActiveId.value) return;
  // Take up to 2 grapheme units (handles surrogate-pair emojis cleanly).
  const chars = Array.from(val).slice(0, 2).join('');
  pickIcon(chars);
  customGlyphInput.value = '';
}

const categories = computed(() => [
  { id: 'all', label: t('toolbarCustom.catAll') },
  { id: 'core', label: t('toolbarCustom.groupCore') },
  { id: 'file', label: t('toolbarCustom.catFile') },
  { id: 'edit', label: t('toolbarCustom.catEdit') },
  { id: 'view', label: t('toolbarCustom.catView') },
  { id: 'sync', label: t('toolbarCustom.catSync') },
  { id: 'export', label: t('toolbarCustom.catExport') },
  { id: 'ai', label: t('toolbarCustom.catAi') },
  { id: 'tools', label: t('toolbarCustom.catTools') },
]);
</script>

<template>
  <DsModal
    :model-value="props.modelValue"
    :title="t('toolbarCustom.title')"
    width="840px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="tcm">
      <p class="tcm__hint">{{ t('toolbarCustom.hint') }}</p>

      <label v-if="winTitleBar" class="tcm__dock">
        <input
          type="checkbox"
          :checked="settings.toolbarInTitlebar"
          @change="settings.toggleToolbarInTitlebar()"
        />
        <span>{{ t('toolbarCustom.dockInTitlebar') }}</span>
      </label>

      <div class="tcm__split">
        <!-- Left column: categorized + searchable commands -->
        <div class="tcm__col">
          <div class="tcm__col-head">{{ t('toolbarCustom.availableCommands') }}</div>
          <div class="tcm__filters">
            <select v-model="categoryFilter" class="tcm__select">
              <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.label }}</option>
            </select>
            <input
              v-model="searchQuery"
              type="search"
              class="tcm__search"
              :placeholder="t('toolbarCustom.searchPlaceholder')"
            />
          </div>
          <div class="tcm__listbox">
            <button
              v-for="entry in filteredAvailable"
              :key="entry.id"
              type="button"
              class="tcm__row"
              :class="{
                'is-selected': selectedAvailId === entry.id,
                'is-added': activeSet.has(entry.id),
              }"
              @click="selectedAvailId = entry.id"
              @dblclick="selectedAvailId = entry.id; addSelected()"
            >
              <Icon :name="entry.defaultIcon" :size="14" />
              <span class="tcm__row-label">{{ entry.label }}</span>
              <span v-if="activeSet.has(entry.id)" class="tcm__badge">✓</span>
            </button>
          </div>
        </div>

        <!-- Middle controls -->
        <div class="tcm__mid">
          <DsButton
            variant="secondary"
            :disabled="!selectedAvailId || activeSet.has(selectedAvailId)"
            @click="addSelected"
          >
            {{ t('toolbarCustom.addBtn') }}
          </DsButton>
          <DsButton
            variant="secondary"
            :disabled="!selectedActiveId"
            @click="removeSelected"
          >
            {{ t('toolbarCustom.removeBtn') }}
          </DsButton>
        </div>

        <!-- Right column: current toolbar buttons + icon picker -->
        <div class="tcm__col">
          <div class="tcm__col-head">
            <span>{{ t('toolbarCustom.currentButtons') }}</span>
            <span class="tcm__order-btns">
              <button type="button" :disabled="!selectedActiveId" title="↑" @click="moveSelected(-1)">↑</button>
              <button type="button" :disabled="!selectedActiveId" title="↓" @click="moveSelected(1)">↓</button>
            </span>
          </div>
          <div class="tcm__listbox">
            <button
              v-for="id in activeItems"
              :key="id"
              type="button"
              class="tcm__row"
              :class="{ 'is-selected': selectedActiveId === id }"
              @click="selectedActiveId = id"
            >
              <span v-if="isCustomGlyphIcon(iconFor(id))" class="tcm__row-glyph">{{ iconFor(id) }}</span>
              <Icon v-else :name="iconFor(id)" :size="15" />
              <span class="tcm__row-label">{{ labelFor(id) }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- #696 — Full-width enlarged icon picker with monochrome + colorful icons + custom emoji -->
      <div v-if="selectedActiveId" class="tcm__icons">
        <div class="tcm__icons-head">
          <span class="tcm__icons-label">
            {{ t('toolbarCustom.pickIcon') }} · <strong>{{ labelFor(selectedActiveId) }}</strong>
          </span>
          <div class="tcm__icons-tabs">
            <button
              type="button"
              class="tcm__tab"
              :class="{ 'is-on': iconTab === 'mono' }"
              @click="iconTab = 'mono'"
            >
              {{ settings.language === 'zh' ? '单色图标' : 'Monochrome' }}
            </button>
            <button
              type="button"
              class="tcm__tab"
              :class="{ 'is-on': iconTab === 'color' }"
              @click="iconTab = 'color'"
            >
              {{ settings.language === 'zh' ? '彩色图标' : 'Colorful' }}
            </button>
            <form class="tcm__custom-glyph" @submit.prevent="applyCustomGlyph">
              <input
                v-model="customGlyphInput"
                type="text"
                maxlength="4"
                class="tcm__glyph-input"
                :placeholder="settings.language === 'zh' ? '自定义 Emoji…' : 'Custom emoji…'"
              />
              <button
                type="submit"
                class="tcm__glyph-apply"
                :disabled="!customGlyphInput.trim()"
              >
                {{ settings.language === 'zh' ? '应用' : 'Apply' }}
              </button>
            </form>
          </div>
        </div>
        <div v-if="iconTab === 'mono'" class="tcm__icon-grid">
          <button
            v-for="ic in TOOLBAR_ICON_OPTIONS"
            :key="ic"
            type="button"
            class="tcm__icon-btn"
            :class="{ 'is-on': iconFor(selectedActiveId) === ic }"
            :title="ic"
            @click="pickIcon(ic)"
          >
            <Icon :name="ic" :size="18" />
          </button>
        </div>
        <div v-else class="tcm__icon-grid">
          <button
            v-for="em in TOOLBAR_EMOJI_ICON_OPTIONS"
            :key="em"
            type="button"
            class="tcm__icon-btn tcm__icon-btn--emoji"
            :class="{ 'is-on': iconFor(selectedActiveId) === em }"
            :title="em"
            @click="pickIcon(em)"
          >
            <span>{{ em }}</span>
          </button>
        </div>
      </div>
    </div>

    <template #footer>
      <DsButton variant="ghost" @click="settings.resetToolbarItems()">
        {{ t('toolbarCustom.reset') }}
      </DsButton>
      <DsButton variant="primary" @click="emit('update:modelValue', false)">
        {{ t('toolbarCustom.done') }}
      </DsButton>
    </template>
  </DsModal>
</template>

<style scoped>
.tcm {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.tcm__hint {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.5;
}
.tcm__dock {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--fill-1);
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
}
.tcm__split {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) auto minmax(0, 1fr);
  gap: 12px;
  align-items: stretch;
}
.tcm__col {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.tcm__col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.tcm__order-btns {
  display: flex;
  gap: 4px;
}
.tcm__order-btns button {
  border: 1px solid var(--hairline);
  background: var(--bg);
  color: var(--text);
  border-radius: 4px;
  width: 22px;
  height: 22px;
  cursor: pointer;
  font-size: 12px;
}
.tcm__filters {
  display: flex;
  gap: 6px;
}
.tcm__select,
.tcm__search {
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  padding: 5px 8px;
}
.tcm__search {
  flex: 1;
  min-width: 0;
}
.tcm__listbox {
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: var(--bg);
  height: 280px;
  overflow-y: auto;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tcm__row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.tcm__row:hover {
  background: var(--fill-1);
}
.tcm__row.is-selected {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
}
.tcm__row.is-added {
  opacity: 0.72;
}
.tcm__row-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tcm__badge {
  font-size: 11px;
  color: var(--accent);
}
.tcm__mid {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
}
.tcm__row-glyph {
  width: 15px;
  text-align: center;
  font-size: 13px;
  line-height: 1;
  flex-shrink: 0;
}
.tcm__icons {
  border: 1px solid var(--hairline);
  border-radius: 10px;
  padding: 12px;
  background: var(--fill-1);
}
.tcm__icons-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.tcm__icons-label {
  font-size: 12.5px;
  color: var(--text-2);
}
.tcm__icons-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tcm__tab {
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text-2);
  font-size: 12px;
  padding: 4px 10px;
  cursor: pointer;
}
.tcm__tab.is-on {
  border-color: var(--accent);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--bg));
  font-weight: 500;
}
.tcm__custom-glyph {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 4px;
}
.tcm__glyph-input {
  width: 106px;
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  padding: 4px 7px;
}
.tcm__glyph-apply {
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  padding: 4px 8px;
  cursor: pointer;
}
.tcm__glyph-apply:disabled {
  opacity: 0.45;
  cursor: default;
}
.tcm__icon-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(38px, 1fr));
  gap: 6px;
  max-height: 156px;
  overflow-y: auto;
  padding: 2px;
}
.tcm__icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  border: 1px solid var(--hairline);
  border-radius: 7px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease, transform 120ms ease;
}
.tcm__icon-btn:hover {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--hairline));
  background: color-mix(in srgb, var(--accent) 8%, var(--bg));
}
.tcm__icon-btn--emoji {
  font-size: 19px;
  line-height: 1;
}
.tcm__icon-btn.is-on {
  border-color: var(--accent);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, var(--bg));
}
</style>
