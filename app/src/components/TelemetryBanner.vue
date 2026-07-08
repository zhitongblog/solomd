<script setup lang="ts">
import { useSettingsStore } from '../stores/settings';
import { useI18n } from '../i18n';

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
  <div v-if="!settings.telemetryNoticeAck" class="telemetry-banner">
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
.telemetry-banner {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-muted);
}
.telemetry-banner__text {
  flex: 1;
  line-height: 1.5;
}
.telemetry-banner__actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.telemetry-banner__btn {
  padding: 5px 12px;
  font-size: 12px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 4px;
  cursor: pointer;
}
.telemetry-banner__btn:hover {
  background: var(--bg-hover);
}
.telemetry-banner__btn--primary {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.telemetry-banner__btn--primary:hover {
  filter: brightness(1.08);
}
</style>
