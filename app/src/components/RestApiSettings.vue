<script setup lang="ts">
/**
 * v4.0 REST API — Settings → Integrations subsection.
 *
 * Localhost HTTP surface that exposes the in-process `agent_tools` registry
 * to non-MCP clients (Alfred / Raycast / n8n / shell scripts / iOS Shortcuts).
 *
 * Mirrors CaptureEndpointSettings.vue: token + port + on-disk drop, plus a
 * dedicated "Allow write" toggle gating the two writer tools.
 */
import { computed, onMounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useToastsStore } from '../stores/toasts';
import { useWorkspaceStore } from '../stores/workspace';
import { useI18n } from '../i18n';

interface RestState {
  enabled: boolean;
  running: boolean;
  port: number;
  token: string;
  allow_write: boolean;
}

const { t } = useI18n();
const toasts = useToastsStore();
const workspace = useWorkspaceStore();

const state = ref<RestState>({
  enabled: false,
  running: false,
  port: 7878,
  token: '',
  allow_write: false,
});

const showToken = ref(false);

async function refresh() {
  try {
    state.value = await invoke<RestState>('rest_get_state');
  } catch (e) {
    console.warn('rest_get_state failed', e);
  }
}

async function onToggleEnabled() {
  const next = !state.value.enabled;
  try {
    state.value = await invoke<RestState>('rest_set_enabled', {
      enabled: next,
      port: state.value.port,
    });
    if (next) {
      // Push the active workspace immediately so the first request after
      // enable doesn't hit a 503.
      await invoke('rest_set_workspace', {
        folder: workspace.currentFolder ?? null,
      });
      toasts.success(t('rest.endpointEnabled', { port: String(state.value.port) }));
    } else {
      toasts.info(t('rest.endpointDisabled'));
    }
  } catch (e) {
    toasts.error(`REST API: ${e}`);
  }
}

async function onToggleAllowWrite() {
  const next = !state.value.allow_write;
  try {
    state.value = await invoke<RestState>('rest_set_allow_write', { allow: next });
    toasts.info(next ? t('rest.allowWriteOn') : t('rest.allowWriteOff'));
  } catch (e) {
    toasts.error(`REST API: ${e}`);
  }
}

async function onRegenerateToken() {
  try {
    state.value = await invoke<RestState>('rest_regenerate_token');
    showToken.value = true;
    toasts.success(t('rest.tokenRegenerated'));
  } catch (e) {
    toasts.error(`Regenerate: ${e}`);
  }
}

async function copyToken() {
  if (!state.value.token) return;
  try {
    await navigator.clipboard.writeText(state.value.token);
    toasts.success(t('rest.tokenCopied'));
  } catch (e) {
    toasts.error(String(e));
  }
}

async function copyCurl() {
  try {
    await navigator.clipboard.writeText(curlSnippet.value);
    toasts.success(t('rest.curlCopied'));
  } catch (e) {
    toasts.error(String(e));
  }
}

const tokenDisplay = computed(() => {
  if (!state.value.token) return t('rest.tokenMissing');
  if (showToken.value) return state.value.token;
  const t0 = state.value.token;
  if (t0.length <= 12) return '•'.repeat(t0.length);
  return `${t0.slice(0, 4)}${'•'.repeat(t0.length - 8)}${t0.slice(-4)}`;
});

const curlSnippet = computed(() => {
  const port = state.value.port || 7878;
  const tok = state.value.token || '<TOKEN>';
  return [
    `curl -s -H "Authorization: Bearer ${tok}" \\`,
    `  http://127.0.0.1:${port}/tools | jq`,
    '',
    `# Read a note:`,
    `curl -s -X POST http://127.0.0.1:${port}/tools/read_note \\`,
    `  -H "Authorization: Bearer ${tok}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"path":"daily/today.md"}' | jq`,
  ].join('\n');
});

onMounted(refresh);
</script>

<template>
  <section class="rest">
    <h3 class="rest__heading">{{ t('rest.heading') }}</h3>
    <p class="rest__intro">{{ t('rest.intro') }}</p>

    <label class="rest__toggle">
      <input
        type="checkbox"
        :checked="state.enabled"
        @change="onToggleEnabled"
      />
      {{ t('rest.enable') }}
    </label>
    <p class="rest__hint">{{ t('rest.enableHint') }}</p>

    <div v-if="state.enabled" class="rest__body">
      <div class="rest__row">
        <span class="rest__label">{{ t('rest.endpoint') }}</span>
        <code class="rest__url">http://127.0.0.1:{{ state.port }}</code>
        <span
          class="rest__status"
          :class="{ 'rest__status--up': state.running, 'rest__status--down': !state.running }"
        >
          {{ state.running ? t('rest.statusRunning') : t('rest.statusStarting') }}
        </span>
      </div>

      <div class="rest__row">
        <span class="rest__label">{{ t('rest.token') }}</span>
        <code class="rest__token" :title="state.token">{{ tokenDisplay }}</code>
        <button class="rest__btn" @click="showToken = !showToken">
          {{ showToken ? t('rest.tokenHide') : t('rest.tokenShow') }}
        </button>
        <button class="rest__btn" :disabled="!state.token" @click="copyToken">
          {{ t('rest.tokenCopy') }}
        </button>
        <button class="rest__btn" @click="onRegenerateToken">
          {{ t('rest.tokenRegenerate') }}
        </button>
      </div>

      <label class="rest__toggle rest__toggle--inline">
        <input
          type="checkbox"
          :checked="state.allow_write"
          @change="onToggleAllowWrite"
        />
        {{ t('rest.allowWrite') }}
      </label>
      <p class="rest__hint">{{ t('rest.allowWriteHint') }}</p>

      <div class="rest__curl">
        <div class="rest__curl-head">
          <span class="rest__label">{{ t('rest.curlExample') }}</span>
          <button class="rest__btn" @click="copyCurl">
            {{ t('rest.curlCopy') }}
          </button>
        </div>
        <pre class="rest__pre"><code>{{ curlSnippet }}</code></pre>
      </div>
    </div>
  </section>
</template>

<style scoped>
.rest {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary, transparent);
}
.rest__heading {
  margin: 0 0 2px 0;
  font-size: 13px;
  font-weight: 600;
}
.rest__intro,
.rest__hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
}
.rest__toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.rest__toggle--inline {
  margin-top: 4px;
}
.rest__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}
.rest__row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
}
.rest__label {
  color: var(--text-muted);
  min-width: 64px;
}
.rest__url,
.rest__token {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  background: var(--bg-tertiary, rgba(0, 0, 0, 0.04));
  padding: 2px 6px;
  border-radius: 4px;
  user-select: text;
}
.rest__status {
  font-size: 11px;
  margin-left: 4px;
}
.rest__status--up {
  color: var(--accent, #2da44e);
}
.rest__status--down {
  color: var(--text-muted);
}
.rest__btn {
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  cursor: pointer;
}
.rest__btn:hover {
  background: var(--bg-secondary);
}
.rest__btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.rest__curl {
  margin-top: 4px;
}
.rest__curl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.rest__pre {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  background: var(--bg-tertiary, rgba(0, 0, 0, 0.04));
  padding: 8px;
  border-radius: 4px;
  margin: 0;
  overflow-x: auto;
  white-space: pre;
}
</style>
