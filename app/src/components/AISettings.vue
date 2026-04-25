<script setup lang="ts">
/**
 * AISettings — settings sub-section for v2.0 F4 (BYOK AI rewrite).
 *
 * Designed to be embedded inside SettingsPanel.vue (the parent will mount
 * it inline, this file does not modify the panel directly). Exposes:
 *   - "Enable AI features" toggle
 *   - Provider dropdown (OpenAI / Anthropic / Ollama)
 *   - Model + base URL fields
 *   - API key field with "Save to keychain" / "Clear key" buttons
 *
 * Keys are stored in the OS keychain via the `ai_set_key` Tauri command;
 * we only display the presence of a key, never the key itself.
 */

import { computed, onMounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { PROVIDERS, providerById, type ProviderId } from '../lib/ai-providers';
import { useI18n } from '../i18n';

const { t } = useI18n();

const props = defineProps<{
  enabled: boolean;
  provider: ProviderId;
  model: string;
  baseUrl: string;
}>();

const emit = defineEmits<{
  (e: 'update:enabled', v: boolean): void;
  (e: 'update:provider', v: ProviderId): void;
  (e: 'update:model', v: string): void;
  (e: 'update:baseUrl', v: string): void;
}>();

// ---------------------------------------------------------------------------
// Key-presence tracking (queried from the OS keychain).
// ---------------------------------------------------------------------------

const hasKey = ref<Partial<Record<ProviderId, boolean>>>({});
const keyInput = ref('');
const saving = ref(false);
const status = ref<{ kind: 'ok' | 'err'; msg: string } | null>(null);

const currentProviderConfig = computed(() => providerById(props.provider));

const needsKey = computed(() => props.provider !== 'ollama');

async function refreshHasKey(p: ProviderId): Promise<void> {
  try {
    const v = await invoke<boolean>('ai_has_key', { provider: p });
    hasKey.value[p] = v;
  } catch {
    hasKey.value[p] = false;
  }
}

async function refreshAll(): Promise<void> {
  await Promise.all(PROVIDERS.map((p) => refreshHasKey(p.id)));
}

watch(
  () => props.provider,
  (p) => {
    keyInput.value = '';
    status.value = null;
    refreshHasKey(p);
  },
);

onMounted(() => {
  void refreshAll();
});

async function saveKey(): Promise<void> {
  const key = keyInput.value.trim();
  if (!key) return;
  saving.value = true;
  status.value = null;
  try {
    await invoke('ai_set_key', { provider: props.provider, key });
    keyInput.value = '';
    await refreshHasKey(props.provider);
    status.value = { kind: 'ok', msg: t('ai.keySaved') };
  } catch (e) {
    status.value = { kind: 'err', msg: String(e) };
  } finally {
    saving.value = false;
  }
}

async function clearKey(): Promise<void> {
  saving.value = true;
  status.value = null;
  try {
    await invoke('ai_clear_key', { provider: props.provider });
    await refreshHasKey(props.provider);
    status.value = { kind: 'ok', msg: t('ai.keyCleared') };
  } catch (e) {
    status.value = { kind: 'err', msg: String(e) };
  } finally {
    saving.value = false;
  }
}

function onProviderChange(ev: Event): void {
  const sel = (ev.target as HTMLSelectElement).value as ProviderId;
  emit('update:provider', sel);
  // Reset model + base URL to provider defaults when switching, but only
  // if they're empty (keeps user customizations across re-opens).
  const cfg = providerById(sel);
  if (cfg && !props.model) emit('update:model', cfg.defaultModel);
  if (cfg && !props.baseUrl) emit('update:baseUrl', cfg.defaultBaseUrl || '');
}
</script>

<template>
  <section class="ai-settings">
    <h3 class="ai-settings__heading">{{ t('ai.settingsHeading') }}</h3>

    <label class="ai-settings__row ai-settings__row--toggle">
      <input
        type="checkbox"
        :checked="enabled"
        @change="emit('update:enabled', ($event.target as HTMLInputElement).checked)"
      />
      <span>
        <span class="ai-settings__label">{{ t('ai.enable') }}</span>
        <span class="ai-settings__hint">{{ t('ai.enableHint') }}</span>
      </span>
    </label>

    <div class="ai-settings__group">
      <div class="ai-settings__row">
        <label class="ai-settings__label" for="ai-provider">{{ t('ai.provider') }}</label>
        <select
          id="ai-provider"
          :value="provider"
          class="ai-settings__input"
          @change="onProviderChange"
        >
          <option v-for="p in PROVIDERS" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
      </div>

      <div class="ai-settings__row">
        <label class="ai-settings__label" for="ai-model">{{ t('ai.model') }}</label>
        <input
          id="ai-model"
          :value="model"
          class="ai-settings__input"
          :placeholder="currentProviderConfig?.defaultModel"
          @input="emit('update:model', ($event.target as HTMLInputElement).value)"
        />
      </div>
      <p v-if="currentProviderConfig?.modelHint" class="ai-settings__hint">
        {{ currentProviderConfig.modelHint }}
      </p>
      <p v-if="currentProviderConfig?.signupUrl" class="ai-settings__hint">
        <a :href="currentProviderConfig.signupUrl" target="_blank" rel="noopener">
          {{ t('ai.getKey') }} ↗
        </a>
      </p>

      <div class="ai-settings__row">
        <label class="ai-settings__label" for="ai-baseurl">{{ t('ai.baseUrl') }}</label>
        <input
          id="ai-baseurl"
          :value="baseUrl"
          class="ai-settings__input"
          :placeholder="currentProviderConfig?.defaultBaseUrl"
          @input="emit('update:baseUrl', ($event.target as HTMLInputElement).value)"
        />
      </div>

      <div v-if="needsKey" class="ai-settings__keybox">
        <div class="ai-settings__row">
          <label class="ai-settings__label" for="ai-key">{{ t('ai.apiKey') }}</label>
          <div class="ai-settings__keyrow">
            <input
              id="ai-key"
              v-model="keyInput"
              type="password"
              class="ai-settings__input"
              :placeholder="hasKey[provider] ? t('ai.keyStored') : t('ai.keyPlaceholder')"
              autocomplete="off"
              spellcheck="false"
            />
            <button
              type="button"
              class="ai-settings__btn ai-settings__btn--primary"
              :disabled="saving || !keyInput.trim()"
              @click="saveKey"
            >
              {{ t('ai.saveKey') }}
            </button>
            <button
              type="button"
              class="ai-settings__btn"
              :disabled="saving || !hasKey[provider]"
              @click="clearKey"
            >
              {{ t('ai.clearKey') }}
            </button>
          </div>
        </div>
        <div class="ai-settings__keystatus">
          <span v-if="hasKey[provider]" class="ai-settings__pill ai-settings__pill--ok">
            ● {{ t('ai.keyStored') }}
          </span>
          <span v-else class="ai-settings__pill ai-settings__pill--warn">
            ○ {{ t('ai.keyMissing') }}
          </span>
          <span v-if="status" :class="['ai-settings__msg', `ai-settings__msg--${status.kind}`]">
            {{ status.msg }}
          </span>
        </div>
      </div>

      <p v-else class="ai-settings__note">{{ t('ai.ollamaNote') }}</p>
    </div>
  </section>
</template>

<style scoped>
.ai-settings {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
}
.ai-settings__heading {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin: 0 0 4px;
}
.ai-settings__row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--text);
}
.ai-settings__row--toggle {
  align-items: flex-start;
}
.ai-settings__row--toggle > span {
  display: flex;
  flex-direction: column;
}
.ai-settings__label {
  min-width: 110px;
  color: var(--text);
  font-size: 12px;
}
.ai-settings__hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}
.ai-settings__group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-left: 6px;
  border-left: 2px solid var(--border);
  margin-left: 6px;
}
.ai-settings__input {
  flex: 1;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
}
.ai-settings__keybox {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ai-settings__keyrow {
  display: flex;
  flex: 1;
  gap: 6px;
}
.ai-settings__btn {
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.ai-settings__btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--bg-hover);
}
.ai-settings__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ai-settings__btn--primary {
  background: var(--accent, #6366f1);
  border-color: var(--accent, #6366f1);
  color: #fff;
}
.ai-settings__keystatus {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-left: 120px;
  font-size: 11px;
}
.ai-settings__pill {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--bg);
  border: 1px solid var(--border);
}
.ai-settings__pill--ok {
  color: #16a34a;
  border-color: rgba(22, 163, 74, 0.4);
}
.ai-settings__pill--warn {
  color: #d97706;
  border-color: rgba(217, 119, 6, 0.4);
}
.ai-settings__msg--ok { color: #16a34a; }
.ai-settings__msg--err { color: #dc2626; }
.ai-settings__note {
  font-size: 11px;
  color: var(--text-muted);
  margin: 4px 0 0;
}
</style>
