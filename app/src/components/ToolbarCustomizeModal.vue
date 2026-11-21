<script setup lang="ts">
import { computed } from 'vue';
import DsModal from '../ui/DsModal.vue';
import DsButton from '../ui/DsButton.vue';
import Icon from './Icons.vue';
import { useSettingsStore } from '../stores/settings';
import { ALL_TOOLBAR_ITEMS, normalizeToolbarItems, type ToolbarItemId } from '../lib/toolbar-items';
import { winTitleBar } from '../lib/chrome';
import { useI18n } from '../i18n';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

const settings = useSettingsStore();
const { t } = useI18n();

const activeSet = computed(() => new Set(normalizeToolbarItems(settings.toolbarItems)));

const groups = computed(() => [
  {
    key: 'core',
    title: t('toolbarCustom.groupCore'),
    items: ALL_TOOLBAR_ITEMS.filter((i) => i.group === 'core'),
  },
  {
    key: 'writing',
    title: t('toolbarCustom.groupWriting'),
    items: ALL_TOOLBAR_ITEMS.filter((i) => i.group === 'writing'),
  },
  {
    key: 'git',
    title: t('toolbarCustom.groupGit'),
    items: ALL_TOOLBAR_ITEMS.filter((i) => i.group === 'git'),
  },
]);

function toggle(id: ToolbarItemId) {
  settings.toggleToolbarItem(id);
}
</script>

<template>
  <DsModal
    :model-value="props.modelValue"
    :title="t('toolbarCustom.title')"
    width="500px"
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

      <div v-for="g in groups" :key="g.key" class="tcm__group">
        <div class="tcm__group-title">{{ g.title }}</div>
        <div class="tcm__grid">
          <label
            v-for="item in g.items"
            :key="item.id"
            class="tcm__item"
            :class="{ 'is-on': activeSet.has(item.id) }"
          >
            <input
              type="checkbox"
              :checked="activeSet.has(item.id)"
              @change="toggle(item.id)"
            />
            <Icon :name="item.icon" :size="14" />
            <span>{{ t(item.labelKey) }}</span>
          </label>
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
.tcm__group-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-3);
  margin-bottom: 6px;
}
.tcm__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.tcm__item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 9px;
  border-radius: 7px;
  border: 1px solid var(--hairline);
  background: var(--bg);
  color: var(--text-2);
  font-size: 12.5px;
  cursor: pointer;
  user-select: none;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}
.tcm__item:hover {
  background: var(--fill-1);
  color: var(--text);
}
.tcm__item.is-on {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--hairline));
  background: color-mix(in srgb, var(--accent) 8%, var(--bg));
  color: var(--text);
}
</style>
