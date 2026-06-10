<script setup lang="ts">
/**
 * F2 — "Create New Type" dialog.
 *
 * Just a name: on confirm, the types store writes `Types/<Name>.md` with
 * `type: Type` frontmatter. A 0-member type still shows in the sidebar
 * (Tolaria parity), so the new section appears immediately after creation.
 *
 * i18n keys (en.ts):
 *   types.newType, types.namePlaceholder, types.create, types.cancel,
 *   types.createFailed
 */
import { ref, watch, nextTick } from 'vue';
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
const inputEl = ref<HTMLInputElement | null>(null);

watch(
  () => props.open,
  async (open) => {
    if (open) {
      name.value = '';
      busy.value = false;
      await nextTick();
      inputEl.value?.focus();
    }
  },
);

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
  <div v-if="open" class="ctd__backdrop" @click.self="emit('close')">
    <div class="ctd" role="dialog" @keydown.esc="emit('close')">
      <button class="ctd__close" @click="emit('close')" aria-label="Cancel">×</button>
      <h3 class="ctd__title">{{ t('types.newType') }}</h3>
      <input
        ref="inputEl"
        v-model="name"
        class="ctd__input"
        type="text"
        :placeholder="t('types.namePlaceholder')"
        @keydown.enter.prevent="confirm"
      />
      <div class="ctd__actions">
        <button class="ctd__btn ctd__btn--cancel" @click="emit('close')">
          {{ t('types.cancel') }}
        </button>
        <button
          class="ctd__btn ctd__btn--create"
          :disabled="!name.trim() || busy"
          @click="confirm"
        >
          {{ t('types.create') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ctd__backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 2000;
  backdrop-filter: blur(2px);
}
.ctd {
  background: var(--bg-elev);
  width: min(360px, 90vw);
  border-radius: 12px;
  border: 1px solid var(--border);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  padding: 22px;
  position: relative;
}
.ctd__close {
  position: absolute;
  top: 10px;
  right: 12px;
  font-size: 20px;
  line-height: 1;
  padding: 4px 8px;
  color: var(--text-faint);
  background: transparent;
  border: none;
  cursor: pointer;
  border-radius: 6px;
}
.ctd__close:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.ctd__title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
  margin: 0 0 14px;
}
.ctd__input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  font-size: 13px;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: none;
  transition: border-color 0.15s;
}
.ctd__input:focus {
  border-color: var(--accent);
}
.ctd__actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 18px;
}
.ctd__btn {
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid var(--border);
  cursor: pointer;
  transition: all 0.15s;
}
.ctd__btn--cancel {
  background: transparent;
  color: var(--text-muted);
}
.ctd__btn--cancel:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.ctd__btn--create {
  background: var(--accent);
  color: var(--accent-fg);
  border-color: var(--accent);
}
.ctd__btn--create:hover:not(:disabled) {
  opacity: 0.9;
}
.ctd__btn--create:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
