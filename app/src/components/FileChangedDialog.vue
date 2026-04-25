<script setup lang="ts">
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
  <div v-if="open" class="ud__backdrop" @click.self="emit('cancel')">
    <div class="ud" role="dialog">
      <button class="ud__close" @click="emit('cancel')" aria-label="Cancel">×</button>

      <div class="ud__icon">📄</div>

      <h3 class="ud__title">
        {{ t('fileChanged.title') }}
      </h3>

      <p class="ud__msg">
        <strong>{{ fileName }}</strong> {{ t('fileChanged.message') }}
      </p>

      <div class="ud__actions">
        <button class="ud__btn ud__btn--cancel" @click="emit('cancel')">{{ t('fileChanged.dismiss') }}</button>
        <button class="ud__btn ud__btn--discard" @click="emit('reload')">{{ t('fileChanged.reload') }}</button>
        <button class="ud__btn ud__btn--save" @click="emit('overwrite')">{{ t('fileChanged.overwrite') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ud__backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 2000;
  backdrop-filter: blur(2px);
}
.ud {
  background: var(--bg-elev);
  width: min(400px, 90vw);
  border-radius: 12px;
  border: 1px solid var(--border);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  padding: 24px;
  position: relative;
  text-align: center;
}
.ud__close {
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
.ud__close:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.ud__icon {
  font-size: 32px;
  margin-bottom: 8px;
}
.ud__title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
  margin: 0 0 8px;
}
.ud__msg {
  font-size: 13px;
  color: var(--text-muted);
  margin: 0 0 20px;
  line-height: 1.5;
}
.ud__msg strong {
  color: var(--text);
}
.ud__actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.ud__btn {
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid var(--border);
  cursor: pointer;
  transition: all 0.15s;
}
.ud__btn--cancel {
  background: transparent;
  color: var(--text-muted);
}
.ud__btn--cancel:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.ud__btn--discard {
  background: transparent;
  color: var(--danger);
  border-color: var(--danger);
}
.ud__btn--discard:hover {
  background: var(--danger);
  color: white;
}
.ud__btn--save {
  background: var(--accent);
  color: var(--accent-fg);
  border-color: var(--accent);
}
.ud__btn--save:hover {
  opacity: 0.9;
}
</style>
