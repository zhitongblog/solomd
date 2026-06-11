<script setup lang="ts">
/**
 * F2 — "Create New Type" dialog.
 *
 * Just a name: on confirm, the types store writes `Types/<Name>.md` with
 * `type: Type` frontmatter. A 0-member type still shows in the sidebar
 * (Tolaria parity), so the new section appears immediately after creation.
 *
 * v4.6.1 — migrated to the `ui/` design system (DsModal / DsInput / DsButton).
 * DsModal owns focus management (it auto-focuses the first focusable on open,
 * which is the name input) and Esc-to-close, so this component only holds the
 * name + busy state.
 *
 * i18n keys (en.ts):
 *   types.newType, types.namePlaceholder, types.create, types.cancel,
 *   types.createFailed
 */
import { ref, watch } from 'vue';
import { DsModal, DsInput, DsButton } from '../ui';
import { useTypesStore } from '../stores/types';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'created', name: string, path: string): void;
}>();

const types = useTypesStore();
const toasts = useToastsStore();
const { t } = useI18n();

const name = ref('');
const busy = ref(false);

watch(
  () => props.open,
  (open) => {
    if (open) {
      name.value = '';
      busy.value = false;
    }
  },
);

function onModel(v: boolean) {
  if (!v) emit('close');
}

async function confirm() {
  const trimmed = name.value.trim();
  if (!trimmed || busy.value) return;
  busy.value = true;
  try {
    const path = await types.createType(trimmed);
    emit('created', trimmed, path);
    emit('close');
  } catch (e) {
    toasts.error(t('types.createFailed', { error: String(e) }));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <DsModal
    :model-value="open"
    :title="t('types.newType')"
    width="380px"
    @update:model-value="onModel"
  >
    <DsInput
      :model-value="name"
      :placeholder="t('types.namePlaceholder')"
      @update:model-value="(v) => (name = v)"
      @keydown.enter.prevent="confirm"
    />

    <template #footer>
      <DsButton variant="ghost" @click="emit('close')">
        {{ t('types.cancel') }}
      </DsButton>
      <DsButton
        variant="primary"
        :disabled="!name.trim()"
        :loading="busy"
        @click="confirm"
      >
        {{ t('types.create') }}
      </DsButton>
    </template>
  </DsModal>
</template>
