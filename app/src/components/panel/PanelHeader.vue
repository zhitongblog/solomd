<script setup lang="ts">
/**
 * 5.0 right-sidebar panel header (docs/v5-ui-spec.md, panel anatomy):
 * 36 px, section-label title on the left, 24 px icon buttons on the right.
 * Put extra buttons in the default slot (use `.rp-icon-btn` + <Icons>); the
 * close button is appended unless `closable` is false.
 */
import Icons from '../Icons.vue';
import { useI18n } from '../../i18n';
import '../../styles/panels.css';

withDefaults(
  defineProps<{
    title: string;
    /** Optional count shown next to the title in --text-3. */
    count?: number | string | null;
    closable?: boolean;
  }>(),
  { count: null, closable: true },
);
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
</script>

<template>
  <header class="rp-head">
    <span class="rp-title">
      {{ title }}<span v-if="count !== null && count !== undefined && count !== ''" class="rp-title__count">{{ count }}</span>
    </span>
    <slot />
    <button
      v-if="closable"
      class="rp-icon-btn"
      type="button"
      :title="t('rightSidebar.hidePane')"
      :aria-label="t('rightSidebar.hidePane')"
      @click="emit('close')"
    >
      <Icons name="close" :size="14" />
    </button>
  </header>
</template>
