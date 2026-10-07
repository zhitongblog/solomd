<script setup lang="ts">
/**
 * 5.0 phone bottom navigation (docs/v5-ui-spec.md §8): 笔记 · 搜索 · 收件箱 ·
 * 设置. Shown on the home and search screens; the editor hides it so the
 * keyboard bar has the bottom edge to itself, as in Apple Notes.
 */
import { computed } from 'vue';
import Icon from './Icons.vue';
import { usePhoneStore } from '../stores/phone';
import { useSettingsStore } from '../stores/settings';
import { useWorkspaceStore } from '../stores/workspace';
import { useInboxView } from '../composables/useInboxView';
import { useI18n } from '../i18n';

const emit = defineEmits<{ (e: 'open-settings'): void }>();

const phone = usePhoneStore();
const settings = useSettingsStore();
const workspace = useWorkspaceStore();
const inboxView = useInboxView();
const { t } = useI18n();

const showInbox = computed(() => !!workspace.currentFolder && settings.inboxWorkflowEnabled);

function openInbox() {
  inboxView.openInbox();
  phone.show('editor');
}
</script>

<template>
  <nav class="ptab" :aria-label="t('phone.navLabel')">
    <button
      class="ptab__btn"
      :class="{ 'is-on': phone.view === 'home' }"
      type="button"
      :aria-current="phone.view === 'home' ? 'page' : undefined"
      @click="phone.show('home')"
    >
      <Icon name="home" :size="22" />
      <span>{{ t('phone.notes') }}</span>
    </button>
    <button
      class="ptab__btn"
      :class="{ 'is-on': phone.view === 'search' }"
      type="button"
      :aria-current="phone.view === 'search' ? 'page' : undefined"
      @click="phone.show('search')"
    >
      <Icon name="search" :size="22" />
      <span>{{ t('phone.search') }}</span>
    </button>
    <button v-if="showInbox" class="ptab__btn" type="button" @click="openInbox">
      <Icon name="inbox" :size="22" />
      <span>{{ t('sidebar.inbox') }}</span>
    </button>
    <button class="ptab__btn" type="button" @click="emit('open-settings')">
      <Icon name="settings" :size="22" />
      <span>{{ t('sidebar.settings') }}</span>
    </button>
  </nav>
</template>

<style scoped>
.ptab {
  flex: none;
  display: flex;
  padding-top: 6px;
  min-height: 56px;
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  -webkit-backdrop-filter: blur(16px);
  backdrop-filter: blur(16px);
  border-top: var(--bd-hair);
}
.ptab__btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-height: 48px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 10px;
  -webkit-tap-highlight-color: transparent;
}
.ptab__btn.is-on {
  color: var(--accent-text);
}
.ptab__btn:active {
  opacity: 0.6;
}
</style>
