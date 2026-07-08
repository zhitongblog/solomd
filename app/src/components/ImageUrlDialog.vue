<script setup lang="ts">
/**
 * "Image from URL" dialog — insert a markdown image link for an external URL
 * (图床 already-hosted image or any web image) without uploading or copying.
 * Mirrors Typora's insert-image-by-URL. Driven by App.vue via a `solomd:open-
 * image-url-dialog` event; emits `confirm` with the URL + alt text.
 */
import { ref, watch, nextTick } from 'vue';
import { DsModal, DsButton, DsInput } from '../ui';
import { useI18n } from '../i18n';

const { t } = useI18n();

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: 'confirm', url: string, alt: string): void;
  (e: 'cancel'): void;
}>();

const url = ref('');
const alt = ref('');
const urlRef = ref<InstanceType<typeof DsInput> | null>(null);

watch(
  () => props.open,
  (o) => {
    if (o) {
      url.value = '';
      alt.value = '';
      nextTick(() => {
        // Focus the URL field; DsInput forwards to its <input>.
        (urlRef.value?.$el?.querySelector?.('input') as HTMLInputElement | undefined)?.focus();
      });
    }
  },
);

function onConfirm() {
  const u = url.value.trim();
  if (!u) return;
  emit('confirm', u, alt.value.trim());
}
</script>

<template>
  <DsModal
    :model-value="open"
    :title="t('imageUrlDialog.title')"
    width="440px"
    @update:model-value="emit('cancel')"
  >
    <div class="iud-body">
      <label class="iud-label">{{ t('imageUrlDialog.urlLabel') }}</label>
      <DsInput
        ref="urlRef"
        v-model="url"
        :placeholder="t('imageUrlDialog.urlPlaceholder')"
        @keydown.enter="onConfirm"
      />
      <label class="iud-label">{{ t('imageUrlDialog.altLabel') }}</label>
      <DsInput v-model="alt" @keydown.enter="onConfirm" />
    </div>
    <template #footer>
      <DsButton variant="ghost" @click="emit('cancel')">{{ t('imageUrlDialog.cancel') }}</DsButton>
      <DsButton variant="primary" :disabled="!url.trim()" @click="onConfirm">
        {{ t('imageUrlDialog.insert') }}
      </DsButton>
    </template>
  </DsModal>
</template>

<style scoped>
.iud-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.iud-label {
  font-size: 12px;
  color: var(--text-muted, var(--text));
  margin-top: 6px;
}
.iud-label:first-child {
  margin-top: 0;
}
</style>
