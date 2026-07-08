<script setup lang="ts">
import { DsModal, DsButton } from '../ui';
import { useI18n } from '../i18n';
const { t } = useI18n();

defineProps<{
  open: boolean;
  fileName: string;
}>();
const emit = defineEmits<{
  (e: 'reload'): void;
  (e: 'overwrite'): void;
  (e: 'cancel'): void;
}>();
</script>

<template>
  <DsModal
    :model-value="open"
    :title="t('fileChanged.title')"
    width="400px"
    @update:model-value="emit('cancel')"
  >
    <div class="fc-body">
      <div class="fc-body__icon" aria-hidden="true">📄</div>
      <p class="fc-body__msg">
        <strong>{{ fileName }}</strong> {{ t('fileChanged.message') }}
      </p>
    </div>
    <template #footer>
      <DsButton variant="ghost" @click="emit('cancel')">{{ t('fileChanged.dismiss') }}</DsButton>
      <DsButton variant="danger" @click="emit('reload')">{{ t('fileChanged.reload') }}</DsButton>
      <DsButton variant="primary" @click="emit('overwrite')">{{ t('fileChanged.overwrite') }}</DsButton>
    </template>
  </DsModal>
</template>

<style scoped>
.fc-body {
  text-align: center;
}
.fc-body__icon {
  font-size: 32px;
  margin-bottom: var(--sp-2);
}
.fc-body__msg {
  font-size: 13px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.5;
}
.fc-body__msg strong {
  color: var(--text);
}
</style>
