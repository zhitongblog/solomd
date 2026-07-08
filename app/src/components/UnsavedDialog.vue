<script setup lang="ts">
import { DsModal, DsButton } from '../ui';
import { useI18n } from '../i18n';
const { t } = useI18n();

defineProps<{
  open: boolean;
  fileName: string;
  /** 'tab' = closing a single tab, 'window' = closing the entire window */
  mode: 'tab' | 'window';
  count?: number;
}>();
const emit = defineEmits<{
  (e: 'save'): void;
  (e: 'discard'): void;
  (e: 'cancel'): void;
}>();
</script>

<template>
  <DsModal
    :model-value="open"
    :title="t('unsaved.title')"
    width="400px"
    @update:model-value="emit('cancel')"
  >
    <div class="ud-body">
      <div class="ud-body__icon" aria-hidden="true">⚠️</div>
      <p class="ud-body__msg">
        <strong>{{ fileName }}</strong>: {{ t('unsaved.message', { file: fileName }).replace(fileName + ' ', '').replace(fileName, '') }}
      </p>
    </div>
    <template #footer>
      <DsButton variant="ghost" @click="emit('cancel')">{{ t('unsaved.cancel') }}</DsButton>
      <DsButton variant="danger" @click="emit('discard')">{{ t('unsaved.dontSave') }}</DsButton>
      <DsButton variant="primary" @click="emit('save')">{{ t('unsaved.save') }}</DsButton>
    </template>
  </DsModal>
</template>

<style scoped>
.ud-body {
  text-align: center;
}
.ud-body__icon {
  font-size: 32px;
  margin-bottom: var(--sp-2);
}
.ud-body__msg {
  font-size: 13px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.5;
}
.ud-body__msg strong {
  color: var(--text);
}
</style>
