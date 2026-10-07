<script setup lang="ts">
import { useSettingsStore } from '../stores/settings';
import { useI18n } from '../i18n';
import { IS_APP_STORE_BUILD } from '../lib/app-build';

const settings = useSettingsStore();
const { t } = useI18n();

function onOk() {
  settings.ackTelemetryNotice();
}
function onDisable() {
  settings.toggleTelemetry();
  settings.ackTelemetryNotice();
}
</script>

<template>
  <!-- App Store builds send no usage data, so there is nothing to announce. -->
  <div v-if="!IS_APP_STORE_BUILD && !settings.telemetryNoticeAck" class="telemetry-banner">
    <div class="telemetry-banner__text">{{ t('settings.telemetryNotice') }}</div>
    <div class="telemetry-banner__actions">
      <button class="telemetry-banner__btn" @click="onDisable">
        {{ t('settings.telemetryNoticeDisable') }}
      </button>
      <button class="telemetry-banner__btn telemetry-banner__btn--primary" @click="onOk">
        {{ t('settings.telemetryNoticeOk') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 5.0: a quiet one-line bar — --bg-sidebar, 12px --text-2, a ghost and a
   small primary button. The wording itself is required (no "zero telemetry"
   claims), so only the look changes. */
.telemetry-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 36px;
  box-sizing: border-box;
  padding: 4px 8px 4px 16px;
  background: var(--bg-sidebar);
  border-bottom: var(--bd-hair);
  font-size: 12px;
  color: var(--text-2);
}
.telemetry-banner__text {
  flex: 1;
  min-width: 0;
  line-height: 1.4;
}
.telemetry-banner__actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.telemetry-banner__btn {
  height: 24px;
  padding: 0 10px;
  font: inherit;
  font-size: 12px;
  font-weight: 560;
  border: 0;
  background: transparent;
  color: var(--text-2);
  border-radius: var(--r-sm);
  cursor: default;
}
.telemetry-banner__btn:hover {
  background: var(--fill-1);
  color: var(--text);
}
.telemetry-banner__btn:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.telemetry-banner__btn--primary,
.telemetry-banner__btn--primary:hover {
  background: var(--accent-strong);
  color: var(--accent-strong-fg);
}
.telemetry-banner__btn--primary:hover {
  filter: brightness(1.06);
}
</style>
