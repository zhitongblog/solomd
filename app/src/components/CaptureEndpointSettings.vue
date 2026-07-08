<script setup lang="ts">
/**
 * v2.4 capture endpoint — Settings → Integrations subsection.
 *
 * Owns the user-facing UI for the localhost HTTP capture server:
 *   - Toggle on/off (binds / unbinds the listener)
 *   - Display the bearer token + Regenerate button
 *   - Edit the inbox folder (relative to the workspace)
 *   - Show a copy-paste-ready curl invocation
 *
 * All state is mirrored from the Rust side via `capture_get_state` so the
 * panel is always coherent with the actually-running listener.
 */
import { computed, onMounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useToastsStore } from '../stores/toasts';
import { useWorkspaceStore } from '../stores/workspace';
import { useI18n } from '../i18n';

interface CaptureState {
  enabled: boolean;
  running: boolean;
  port: number;
  token: string;
  inbox_folder: string;
}

const { t } = useI18n();
const toasts = useToastsStore();
const workspace = useWorkspaceStore();

const state = ref<CaptureState>({
  enabled: false,
  running: false,
  port: 7777,
  token: '',
  inbox_folder: 'inbox',
});

const showToken = ref(false);

async function refresh() {
  try {
    state.value = await invoke<CaptureState>('capture_get_state');
  } catch (e) {
    console.warn('capture_get_state failed', e);
  }
}

async function onToggleEnabled() {
  const next = !state.value.enabled;
  try {
    state.value = await invoke<CaptureState>('capture_set_enabled', {
      enabled: next,
      port: state.value.port,
    });
    if (next) {
      // Push the active workspace folder so the server can write there.
      await invoke('capture_set_workspace', {
        folder: workspace.currentFolder ?? null,
      });
      toasts.success(t('inbox.endpointEnabled', { port: String(state.value.port) }));
    } else {
      toasts.info(t('inbox.endpointDisabled'));
    }
  } catch (e) {
    toasts.error(`Capture endpoint: ${e}`);
  }
}

async function onRegenerateToken() {
  try {
    state.value = await invoke<CaptureState>('capture_regenerate_token');
    showToken.value = true;
    toasts.success(t('inbox.tokenRegenerated'));
  } catch (e) {
    toasts.error(`Regenerate: ${e}`);
  }
}

async function onSetInboxFolder(value: string) {
  try {
    state.value = await invoke<CaptureState>('capture_set_inbox_folder', {
      folder: value,
    });
  } catch (e) {
    toasts.error(`Inbox folder: ${e}`);
  }
}

async function copyToken() {
  if (!state.value.token) return;
  try {
    await navigator.clipboard.writeText(state.value.token);
    toasts.success(t('inbox.tokenCopied'));
  } catch (e) {
    toasts.error(String(e));
  }
}

async function copyCurl() {
  const cmd = curlSnippet.value;
  try {
    await navigator.clipboard.writeText(cmd);
    toasts.success(t('inbox.curlCopied'));
  } catch (e) {
    toasts.error(String(e));
  }
}

const tokenDisplay = computed(() => {
  if (!state.value.token) return t('inbox.tokenMissing');
  if (showToken.value) return state.value.token;
  // Mask all but first/last 4 chars so the user can verify visually
  // without exposing the whole token to bystanders.
  const t0 = state.value.token;
  if (t0.length <= 12) return '•'.repeat(t0.length);
  return `${t0.slice(0, 4)}${'•'.repeat(t0.length - 8)}${t0.slice(-4)}`;
});

const curlSnippet = computed(() => {
  const port = state.value.port || 7777;
  const tok = state.value.token || '<TOKEN>';
  // Multi-line for readability; users can paste as-is into a terminal.
  return [
    `curl -X POST http://127.0.0.1:${port}/capture \\`,
    `  -H "Authorization: Bearer ${tok}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"title":"From curl","content":"# From curl\\n\\nHello\\n","tags":["clipped"]}'`,
  ].join('\n');
});

onMounted(refresh);
</script>

<template>
  <section class="capture">
    <h3 class="capture__heading">{{ t('inbox.captureHeading') }}</h3>

    <label class="capture__toggle">
      <input
        type="checkbox"
        :checked="state.enabled"
        @change="onToggleEnabled"
      />
      {{ t('inbox.enableCapture') }}
    </label>
    <p class="capture__hint">{{ t('inbox.enableCaptureHint') }}</p>

    <div v-if="state.enabled" class="capture__body">
      <div class="capture__row">
        <span class="capture__label">{{ t('inbox.endpoint') }}</span>
        <code class="capture__url">http://127.0.0.1:{{ state.port }}/capture</code>
        <span
          class="capture__status"
          :class="{ 'capture__status--up': state.running, 'capture__status--down': !state.running }"
        >
          {{ state.running ? t('inbox.statusRunning') : t('inbox.statusStarting') }}
        </span>
      </div>

      <div class="capture__row">
        <span class="capture__label">{{ t('inbox.token') }}</span>
        <code class="capture__token" :title="state.token">{{ tokenDisplay }}</code>
        <button class="capture__btn" @click="showToken = !showToken">
          {{ showToken ? t('inbox.tokenHide') : t('inbox.tokenShow') }}
        </button>
        <button class="capture__btn" :disabled="!state.token" @click="copyToken">
          {{ t('inbox.tokenCopy') }}
        </button>
        <button class="capture__btn" @click="onRegenerateToken">
          {{ t('inbox.tokenRegenerate') }}
        </button>
      </div>

      <div class="capture__row">
        <span class="capture__label">{{ t('inbox.folder') }}</span>
        <input
          type="text"
          class="capture__input"
          :value="state.inbox_folder"
          @change="onSetInboxFolder(($event.target as HTMLInputElement).value)"
          :placeholder="t('inbox.folderPlaceholder')"
        />
      </div>

      <div class="capture__curl">
        <div class="capture__curl-head">
          <span class="capture__label">{{ t('inbox.curlExample') }}</span>
          <button class="capture__btn" @click="copyCurl">
            {{ t('inbox.curlCopy') }}
          </button>
        </div>
        <pre class="capture__pre"><code>{{ curlSnippet }}</code></pre>
      </div>
    </div>
  </section>
</template>

<style scoped>
.capture {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.capture__heading {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin: 18px 0 6px;
}
.capture__toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.capture__hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.5;
}
.capture__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.capture__row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}
.capture__label {
  color: var(--text-muted);
  min-width: 80px;
  font-size: 11px;
}
.capture__url,
.capture__token {
  font-family: var(--mono, monospace);
  font-size: 11px;
  background: var(--bg-elev);
  padding: 2px 6px;
  border-radius: 3px;
  color: var(--text);
}
.capture__status {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  font-weight: 500;
}
.capture__status--up {
  background: rgba(80, 200, 120, 0.15);
  color: #4caf50;
}
.capture__status--down {
  background: rgba(255, 196, 0, 0.15);
  color: #c08800;
}
.capture__btn {
  font-size: 11px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  border-radius: 3px;
  cursor: pointer;
}
.capture__btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.capture__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.capture__input {
  flex: 1;
  font-size: 12px;
  padding: 4px 8px;
  background: var(--bg-elev);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 3px;
  font: inherit;
  font-family: var(--mono, monospace);
}
.capture__curl {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.capture__curl-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.capture__pre {
  margin: 0;
  padding: 8px 10px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-family: var(--mono, monospace);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text);
  overflow-x: auto;
  white-space: pre;
}
</style>
