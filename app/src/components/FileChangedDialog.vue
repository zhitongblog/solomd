<script setup lang="ts">
import { DsModal, DsButton } from '../ui';
import Icons from './Icons.vue';
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
      <div class="fc-body__icon" aria-hidden="true"><Icons name="file-changed" :size="22" /></div>
      <p class="fc-body__msg">
        <strong>{{ fileName }}</strong> {{ t('fileChanged.message') }}
      </p>
    </div>
    <template #footer>
      <DsButton variant="secondary" @click="emit('cancel')">{{ t('fileChanged.dismiss') }}</DsButton>
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin-bottom: var(--sp-3);
  border-radius: var(--r-full);
  background: var(--accent-soft);
  color: var(--accent-text);
}
.fc-body__msg {
  font-size: 13px;
  color: var(--text-2);
  margin: 0;
  line-height: 1.5;
}
.fc-body__msg strong {
  color: var(--text);
}
</style>
