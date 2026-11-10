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

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  OLLAMA_RECOMMENDED_MODEL,
  PROVIDERS,
  providerById,
  type ProviderId,
} from '../lib/ai-providers';
import { useSettingsStore } from '../stores/settings';
import { useWorkspaceStore } from '../stores/workspace';
import { useTabsStore } from '../stores/tabs';
import { useI18n } from '../i18n';

const settingsStore = useSettingsStore();
const workspaceStore = useWorkspaceStore();
const tabsStore = useTabsStore();

// ---------------------------------------------------------------------------
// Ollama detect / pull state (v4.0 Pillar 5)
// ---------------------------------------------------------------------------

interface OllamaDetection {
  ok: boolean;
  version?: string | null;
  models: string[];
}

interface OllamaPullEvent {
  request_id: string;
  status: string;
  completed?: number | null;
  total?: number | null;
  done: boolean;
}

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

/**
 * Parse the provider's modelHint into a flat list of model ids for the
 * <datalist> dropdown. Hints look like:
 *   "旗舰: deepseek-v4-pro · 通用: deepseek-v4-flash · (旧版即将下线: deepseek-chat / deepseek-reasoner)"
 * — split by both `·` and `/`, drop the category labels (anything before `:`),
 * trim parens / whitespace, dedupe, and front-load the defaultModel.
 */
const modelChoices = computed<string[]>(() => {
  const cfg = currentProviderConfig.value;
  if (!cfg) return [];
  // A self-hosted server has no canonical model list — the only truthful
  // source is what it just told us via /v1/models.
  if (props.provider === 'openai-compat') return probe.value?.models ?? [];
  const out = new Set<string>();
  if (cfg.defaultModel) out.add(cfg.defaultModel);
  const hint = cfg.modelHint || '';
  for (const segment of hint.split('·')) {
    let s = segment.trim().replace(/^\(/, '').replace(/\)$/, '');
    // Drop the "标准:" / "推理:" / "Coding:" label.
    const colonIdx = s.indexOf(':');
    if (colonIdx >= 0) s = s.slice(colonIdx + 1);
    for (const m of s.split('/')) {
      const id = m.trim();
      if (id && !id.includes(' ') && !id.includes('…') && !id.includes('（')) {
        out.add(id);
      }
    }
  }
  // #299 — Merge live models fetched from GET {base}/models when available
  if (probe.value?.ok && probe.value.models.length > 0) {
    for (const m of probe.value.models) {
      if (m) out.add(m);
    }
  }
  return Array.from(out);
});

// A key is required for hosted providers only. Local runtimes (Ollama, a
// self-hosted OpenAI-compatible server) may have one — some people front
// theirs with a reverse-proxy token — but must never be blocked without.
const needsKey = computed(() => !currentProviderConfig.value?.keyless);
/** The self-hosted OpenAI-compatible branch (llama.cpp / LM Studio / vLLM). */
const isCompat = computed(() => props.provider === 'openai-compat');
/** #299 — Hosted OpenAI-compatible providers that expose GET {base}/models. */
const canProbeModels = computed(
  () => currentProviderConfig.value?.apiFormat === 'openai' && props.provider !== 'ollama',
);

// ---------------------------------------------------------------------------
// Ollama detection cache (v4.0 Pillar 5)
//
// We keep the last result + timestamp in module scope so flipping the
// provider dropdown back to Ollama within 30s reuses the cached probe
// rather than re-hitting the server. AISettings is mounted/unmounted as the
// user opens / closes the Settings panel, but the cache outlives that.
//
// v4.11.18: the cache is keyed by base URL. Detection used to ignore the
// Base URL field entirely and always probe localhost, so anyone running
// Ollama on another machine got a permanent "not detected" even though
// chat itself worked against their LAN address.
// ---------------------------------------------------------------------------

let cachedDetection: OllamaDetection | null = null;
let cachedDetectionAt = 0;
let cachedDetectionUrl = '';
const DETECT_TTL_MS = 30_000;

/** The address we're probing, for the status pill and the error hint. */
const probeUrl = computed(
  () => (props.baseUrl || '').trim()
    || currentProviderConfig.value?.defaultBaseUrl
    || 'http://localhost:11434',
);

/** A remote server can't be fixed by installing Ollama locally, so the
 *  not-detected branch offers a reachability hint instead of that CTA. */
const probeIsRemote = computed(() => {
  const host = probeUrl.value.replace(/^[a-z]+:\/\//i, '').split('/')[0];
  const bare = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0];
  return !['localhost', '127.0.0.1', '::1', '0.0.0.0', ''].includes(bare);
});

const detection = ref<OllamaDetection | null>(null);
const detecting = ref(false);
// Pull progress state. `pullStatus` mirrors the Ollama status string
// ("pulling abc123" / "verifying sha256 digest" / "success") so the user
// sees what stage we're in; `pullPct` is 0–1 derived from completed/total.
const pulling = ref(false);
const pullStatus = ref('');
const pullPct = ref<number | null>(null);
const pullError = ref<string | null>(null);
const pullDone = ref(false);
let pullRequestId = '';
let pullUnlisten: UnlistenFn | null = null;

async function detectOllama(force = false): Promise<void> {
  const url = probeUrl.value;
  // Hot-path: the same panel opening twice within TTL skips the IPC — but
  // only while the address is unchanged.
  if (
    !force
    && cachedDetection
    && cachedDetectionUrl === url
    && Date.now() - cachedDetectionAt < DETECT_TTL_MS
  ) {
    detection.value = cachedDetection;
    return;
  }
  detecting.value = true;
  try {
    const d = await invoke<OllamaDetection>('ollama_detect', { baseUrl: url });
    // A slow remote probe can land after the user has typed a new address;
    // drop the stale answer instead of flashing it.
    if (probeUrl.value !== url) return;
    detection.value = d;
    cachedDetection = d;
    cachedDetectionUrl = url;
    cachedDetectionAt = Date.now();
  } catch {
    if (probeUrl.value !== url) return;
    const fallback: OllamaDetection = { ok: false, models: [] };
    detection.value = fallback;
    cachedDetection = fallback;
    cachedDetectionUrl = url;
    cachedDetectionAt = Date.now();
  } finally {
    detecting.value = false;
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible server probe (v4.11.18)
//
// Same idea as the Ollama detection pill, one endpoint over: GET
// {base}/models. It answers the two questions a self-hosted setup actually
// fails on — "is anything listening at this address" and "what model names
// does it want" — and when it fails it shows the server's own words
// (HTTP 404 / connection refused) rather than a mute red dot.
// ---------------------------------------------------------------------------

interface ModelProbe {
  ok: boolean;
  models: string[];
  url: string;
  error?: string | null;
}

const probe = ref<ModelProbe | null>(null);
const probing = ref(false);
let probeDebounce: number | null = null;

async function probeCompat(): Promise<void> {
  const url = probeUrl.value;
  probing.value = true;
  try {
    const p = await invoke<ModelProbe>('ai_list_models', {
      provider: props.provider,
      baseUrl: url,
    });
    if (probeUrl.value !== url) return;
    probe.value = p;
    // A self-hosted server names its own models; when the field is still
    // empty (fresh switch to this provider) adopt the first one it lists,
    // so "connected" and "usable" aren't two separate steps. A model the
    // user typed themselves is never overwritten — it may be an alias the
    // server accepts but doesn't advertise.
    if (p.ok && p.models.length > 0 && !props.model.trim()) {
      emit('update:model', p.models[0]);
    }
  } catch (e) {
    if (probeUrl.value !== url) return;
    probe.value = { ok: false, models: [], url, error: String(e) };
  } finally {
    probing.value = false;
  }
}

function scheduleCompatProbe(delay = 700): void {
  if (probeDebounce != null) window.clearTimeout(probeDebounce);
  probeDebounce = window.setTimeout(() => {
    probeDebounce = null;
    void probeCompat();
  }, delay);
}

async function openInstallPage(): Promise<void> {
  try {
    await invoke('open_ollama_install_page');
  } catch (e) {
    status.value = { kind: 'err', msg: String(e) };
  }
}

async function ensurePullListener(): Promise<void> {
  if (pullUnlisten) return;
  pullUnlisten = await listen<OllamaPullEvent>('solomd://ollama-pull', (ev) => {
    if (ev.payload.request_id !== pullRequestId) return;
    pullStatus.value = ev.payload.status;
    const c = ev.payload.completed ?? null;
    const t = ev.payload.total ?? null;
    pullPct.value = c != null && t != null && t > 0 ? Math.min(1, c / t) : null;
    if (ev.payload.done) {
      pullDone.value = true;
    }
  });
}

async function pullRecommended(): Promise<void> {
  if (pulling.value) return;
  await ensurePullListener();
  pulling.value = true;
  pullDone.value = false;
  pullError.value = null;
  pullStatus.value = '';
  pullPct.value = null;
  pullRequestId = `pull-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await invoke('ollama_pull', {
      model: OLLAMA_RECOMMENDED_MODEL,
      requestId: pullRequestId,
      baseUrl: probeUrl.value,
    });
    // After the pull resolves, re-detect so the model dropdown picks up
    // the new entry without the user having to hit Refresh.
    await detectOllama(true);
  } catch (e) {
    pullError.value = String(e);
  } finally {
    pulling.value = false;
  }
}

async function cancelPull(): Promise<void> {
  if (!pulling.value || !pullRequestId) return;
  try {
    await invoke('ollama_cancel_pull', { requestId: pullRequestId });
  } catch {
    /* idempotent — surface nothing */
  }
}

/** Curated presets first, then any other locally-installed model the user
 *  pulled themselves (e.g. `llama3.2`). De-duped against the preset list. */
const ollamaModelOptions = computed(() => {
  const cfg = currentProviderConfig.value;
  const presets = cfg?.presets ?? [];
  const installed = detection.value?.models ?? [];
  const presetModels = new Set(presets.map((p) => p.model));
  const others = installed.filter((m) => !presetModels.has(m));
  return { presets, others };
});

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
  async (p) => {
    keyInput.value = '';
    status.value = null;
    probe.value = null;
    await refreshHasKey(p);
    // Re-probe Ollama on every switch INTO ollama (force = false uses
    // the 30s cache so back-and-forth flips don't spam the server).
    if (p === 'ollama') void detectOllama(false);
    if (
      p === 'openai-compat' ||
      (canProbeModels.value && (hasKey.value[p] || p === 'openrouter'))
    ) {
      scheduleCompatProbe(0);
    }
  },
);

// v4.11.18 — re-probe when the user edits the Base URL. Debounced so a
// typed-out LAN address doesn't fire a request per keystroke.
let baseUrlDebounce: number | null = null;
watch(
  () => props.baseUrl,
  () => {
    if (
      isCompat.value ||
      (canProbeModels.value && (hasKey.value[props.provider] || props.provider === 'openrouter'))
    ) {
      scheduleCompatProbe();
      return;
    }
    if (props.provider !== 'ollama') return;
    if (baseUrlDebounce != null) window.clearTimeout(baseUrlDebounce);
    baseUrlDebounce = window.setTimeout(() => {
      baseUrlDebounce = null;
      void detectOllama(true);
    }, 700);
  },
);

onMounted(async () => {
  await refreshAll();
  if (props.provider === 'ollama') void detectOllama(false);
  if (
    isCompat.value ||
    (canProbeModels.value && (hasKey.value[props.provider] || props.provider === 'openrouter'))
  ) {
    scheduleCompatProbe(0);
  }
});

onUnmounted(() => {
  if (probeDebounce != null) {
    window.clearTimeout(probeDebounce);
    probeDebounce = null;
  }
  if (baseUrlDebounce != null) {
    window.clearTimeout(baseUrlDebounce);
    baseUrlDebounce = null;
  }
  if (pullUnlisten) {
    pullUnlisten();
    pullUnlisten = null;
  }
});

async function saveKey(): Promise<void> {
  const key = keyInput.value.trim();
  if (!key) return;
  saving.value = true;
  status.value = { kind: 'ok', msg: t('ai.verifying') };
  try {
    // Verify FIRST with the key the user just typed, before storing it
    // in keychain. If verification fails, the user keeps their old key
    // (if any) untouched, and we surface the exact provider error.
    const cfg = currentProviderConfig.value;
    let verifiedMsg: string;
    try {
      verifiedMsg = await invoke<string>('ai_verify_key', {
        provider: props.provider,
        key,
        apiFormat: cfg?.apiFormat || 'openai',
        baseUrl: props.baseUrl || cfg?.defaultBaseUrl || null,
        // Endpoints without a GET /models list verify by chat ping instead
        // (#261); that needs a model name to send.
        model: props.model?.trim() || cfg?.defaultModel || null,
      });
    } catch (verifyErr) {
      status.value = {
        kind: 'err',
        msg: t('ai.verifyFailed') + ': ' + String(verifyErr),
      };
      return;
    }
    // Verification passed — now save to keychain.
    await invoke('ai_set_key', { provider: props.provider, key });
    keyInput.value = '';
    await refreshHasKey(props.provider);
    status.value = { kind: 'ok', msg: t('ai.verified') + ' · ' + verifiedMsg };
    if (canProbeModels.value) scheduleCompatProbe(0);
  } catch (e) {
    status.value = { kind: 'err', msg: String(e) };
  } finally {
    saving.value = false;
  }
}

/** Manual re-verify button — uses the key already in keychain. */
async function verifyExisting(): Promise<void> {
  // A keyless provider (local Ollama / self-hosted OpenAI-compatible
  // server) verifies against the endpoint itself, no key involved.
  if (needsKey.value && !hasKey.value[props.provider]) {
    status.value = { kind: 'err', msg: t('ai.noKey') };
    return;
  }
  saving.value = true;
  status.value = { kind: 'ok', msg: t('ai.verifying') };
  try {
    const cfg = currentProviderConfig.value;
    const ok = await invoke<string>('ai_verify_key', {
      provider: props.provider,
      key: null,
      apiFormat: cfg?.apiFormat || 'openai',
      baseUrl: props.baseUrl || cfg?.defaultBaseUrl || null,
      model: props.model?.trim() || cfg?.defaultModel || null,
    });
    status.value = { kind: 'ok', msg: t('ai.verified') + ' · ' + ok };
  } catch (e) {
    status.value = { kind: 'err', msg: t('ai.verifyFailed') + ': ' + String(e) };
  } finally {
    saving.value = false;
  }
}

// ---------------------------------------------------------------------------
// v4.0 — Agent settings: allow-write toggle, tool_loop_cap, recent runs.
// ---------------------------------------------------------------------------

interface AgentRunMeta {
  run_id: string;
  kind: 'panel' | 'recipe';
  started_at: number;
  ended_at: number | null;
  status: string;
  workspace?: string;
  provider?: string;
  model?: string;
  recipe?: { name: string } | null;
  // v4.0 — populated by ai_proxy.rs after a run finishes; stays 0 for
  // ollama / unknown (provider, model) pairs and for runs that
  // predate the token-counting fix.
  tokens?: { input?: number; output?: number };
  cost_usd_estimate?: number;
  _dir?: string;
  _run_md?: string;
}

const recentRuns = ref<AgentRunMeta[]>([]);
const runsLoading = ref(false);

/**
 * Re-arm the first-run wizard so App.vue's `agentWizardSeen` watcher
 * pops it open again. Used by the "Run setup wizard again" button.
 * The wizard itself calls `markAgentWizardSeen()` on close so we don't
 * loop.
 */
function reopenWizard(): void {
  settingsStore.resetAgentWizard();
  // Ask the app to open it. App.vue listens to a window-level event so
  // we don't have to thread a prop through the whole settings tree.
  window.dispatchEvent(new CustomEvent('solomd:open-agent-wizard'));
}

async function refreshRuns(): Promise<void> {
  const ws = workspaceStore.currentFolder;
  if (!ws) {
    recentRuns.value = [];
    return;
  }
  runsLoading.value = true;
  try {
    recentRuns.value = await invoke<AgentRunMeta[]>('agent_list_runs', {
      workspace: ws,
    });
  } catch (e) {
    console.warn('failed to load agent runs', e);
    recentRuns.value = [];
  } finally {
    runsLoading.value = false;
  }
}

watch(
  () => workspaceStore.currentFolder,
  () => void refreshRuns(),
);

function fmtRunStartedAt(secs: number): string {
  if (!secs) return '?';
  try {
    const d = new Date(secs * 1000);
    return d.toLocaleString();
  } catch {
    return String(secs);
  }
}

/**
 * Render a compact "1.2k in · 3.4k out · $0.0042" summary for a run row.
 * Returns the empty string when no usage was captured (Ollama runs, runs
 * that predate the token-counting fix, or aborted runs that finish'd
 * with 0/0/0). The settings list stays clean rather than rendering
 * a misleading "$0.0000" badge for every entry.
 */
function fmtRunUsage(r: AgentRunMeta): string {
  const tin = r.tokens?.input ?? 0;
  const tout = r.tokens?.output ?? 0;
  const cost = r.cost_usd_estimate ?? 0;
  if (tin === 0 && tout === 0 && cost === 0) return '';
  const fmtTokens = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const parts: string[] = [];
  if (tin || tout) parts.push(`${fmtTokens(tin)} in · ${fmtTokens(tout)} out`);
  if (cost > 0) parts.push(`$${cost.toFixed(4)}`);
  return parts.join(' · ');
}

async function openRunMd(run: AgentRunMeta): Promise<void> {
  if (!run._run_md) return;
  // Open the run.md as a file tab. Mirror the openPath flow used by
  // QuickSwitcher / FileTree — read_file + tabs.openFromDisk.
  try {
    const result = await invoke<{
      content: string;
      encoding: string;
      language: string;
      had_bom: boolean;
    }>('read_file', { path: run._run_md });
    tabsStore.openFromDisk({
      filePath: run._run_md,
      content: result.content,
      encoding: result.encoding,
      language: 'markdown',
      hadBom: result.had_bom,
    });
  } catch (e) {
    console.error('failed to open run.md', e);
  }
}

onMounted(() => {
  void refreshRuns();
});

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

/**
 * On provider change we ALWAYS reset model + baseUrl to the new provider's
 * defaults — leaving them stale was the source of a verify-against-wrong-
 * provider bug ("API key not valid" when an OpenAI base URL was carried
 * over after switching to Gemini). Power users who set a custom base URL
 * (e.g. self-hosted OpenAI-compat endpoint) just re-edit the field after
 * switching; that's the rare path.
 */
function onProviderChange(ev: Event): void {
  const sel = (ev.target as HTMLSelectElement).value as ProviderId;
  emit('update:provider', sel);
  const cfg = providerById(sel);
  if (cfg) {
    const remembered = settingsStore.aiModels?.[sel]?.trim();
    emit('update:model', remembered || cfg.defaultModel);
    emit('update:baseUrl', cfg.defaultBaseUrl || '');
  }
  // Clear any stale verify status from the previous provider.
  status.value = null;
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
          :list="`ai-model-options-${provider}`"
          autocomplete="off"
          spellcheck="false"
          @input="emit('update:model', ($event.target as HTMLInputElement).value)"
        />
        <datalist :id="`ai-model-options-${provider}`">
          <option v-for="m in modelChoices" :key="m" :value="m" />
        </datalist>
      </div>
      <!-- #299 — Quick model dropdown selector + live /models refresh for hosted providers -->
      <div
        v-if="!isCompat && provider !== 'ollama' && modelChoices.length > 0"
        class="ai-settings__row"
      >
        <span class="ai-settings__label">{{ t('ai.compat.pickModel') }}</span>
        <div class="ai-settings__keyrow">
          <select
            class="ai-settings__input"
            :value="modelChoices.includes(model) ? model : ''"
            @change="emit('update:model', ($event.target as HTMLSelectElement).value)"
          >
            <option value="" disabled>—</option>
            <option v-for="m in modelChoices" :key="m" :value="m">{{ m }}</option>
          </select>
          <button
            v-if="canProbeModels"
            type="button"
            class="ai-settings__btn"
            :disabled="probing"
            :title="t('ai.ollama.refresh')"
            @click="probeCompat()"
          >
            ↻ {{ t('ai.ollama.refresh') }}
          </button>
        </div>
      </div>
      <p v-if="currentProviderConfig?.modelHint" class="ai-settings__hint">
        {{ t('ai.modelHintPrefix') }}: {{ currentProviderConfig.modelHint }}
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
          autocomplete="off"
          spellcheck="false"
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
              :disabled="saving || (!hasKey[provider] && needsKey)"
              @click="verifyExisting"
            >
              {{ t('ai.testConnection') }}
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

      <!-- v4.11.18 — self-hosted OpenAI-compatible server (llama.cpp's
           llama-server, LM Studio, vLLM, an internal gateway…). No account,
           so no key is required; what matters is whether the address
           answers and which model names it wants. -->
      <div v-else-if="isCompat" class="ai-settings__ollama">
        <p class="ai-settings__note">{{ t('ai.compat.note') }}</p>

        <div class="ai-settings__ollama-row">
          <span v-if="!probe || probing" class="ai-settings__pill">
            ◌ {{ t('ai.verifying') }}
          </span>
          <span
            v-else-if="probe.ok && probe.models.length > 0"
            class="ai-settings__pill ai-settings__pill--ok"
          >
            ● {{ t('ai.compat.connected', { n: probe.models.length }) }}
          </span>
          <span
            v-else-if="probe.ok"
            class="ai-settings__pill ai-settings__pill--warn"
          >
            ● {{ t('ai.compat.connectedNoModels') }}
          </span>
          <span v-else class="ai-settings__pill ai-settings__pill--err">
            ● {{ t('ai.compat.failed') }}
          </span>

          <span v-if="probe && !probing" class="ai-settings__hint">
            {{ t('ai.probedAt', { url: probe.url || probeUrl }) }}
          </span>

          <button
            type="button"
            class="ai-settings__btn"
            :disabled="probing"
            @click="probeCompat()"
          >
            {{ t('ai.ollama.refresh') }}
          </button>
        </div>

        <!-- The server's own words. A self-hosted endpoint that "doesn't
             work" is nearly always a wrong path or port, and this line is
             what tells the two apart. -->
        <p
          v-if="probe && !probe.ok && probe.error && !probing"
          class="ai-settings__msg ai-settings__msg--err"
        >
          {{ probe.error }}
        </p>
        <p v-if="probe && !probe.ok && !probing" class="ai-settings__hint">
          {{ t('ai.compat.hint') }}
        </p>

        <!-- Model picker straight from GET /v1/models — a self-hosted
             server names its own models and typing them by hand is the
             other half of why this setup fails. -->
        <div
          v-if="probe && probe.models.length > 0"
          class="ai-settings__row"
        >
          <!-- Labelled as an action, not a second "Model" field — the
               freeform model input above stays the source of truth. -->
          <span class="ai-settings__label">{{ t('ai.compat.pickModel') }}</span>
          <select
            class="ai-settings__input"
            :value="probe.models.includes(model) ? model : ''"
            @change="emit('update:model', ($event.target as HTMLSelectElement).value)"
          >
            <option value="" disabled>—</option>
            <option v-for="m in probe.models" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>

        <!-- Optional token, for a server behind a reverse proxy. -->
        <div class="ai-settings__row">
          <label class="ai-settings__label" for="ai-key-compat">
            {{ t('ai.compat.keyOptional') }}
          </label>
          <div class="ai-settings__keyrow">
            <input
              id="ai-key-compat"
              v-model="keyInput"
              type="password"
              class="ai-settings__input"
              :placeholder="hasKey[provider] ? t('ai.keyStored') : t('ai.compat.keyPlaceholder')"
              autocomplete="off"
              spellcheck="false"
            />
            <button
              type="button"
              class="ai-settings__btn"
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
        <span v-if="status" :class="['ai-settings__msg', `ai-settings__msg--${status.kind}`]">
          {{ status.msg }}
        </span>
      </div>

      <!-- Ollama-specific block: detection pill, install / refresh / pull
           buttons, and a model picker (presets + other-detected). v4.0 P5. -->
      <div v-else class="ai-settings__ollama">
        <p class="ai-settings__note">{{ t('ai.ollamaNote') }}</p>

        <div class="ai-settings__ollama-row">
          <span
            v-if="!detection || detecting"
            class="ai-settings__pill"
          >
            ◌ {{ t('ai.verifying') }}
          </span>
          <span
            v-else-if="detection.ok && detection.models.length > 0"
            class="ai-settings__pill ai-settings__pill--ok"
          >
            ● {{ t('ai.ollama.detected', { n: detection.models.length }) }}
          </span>
          <span
            v-else-if="detection.ok"
            class="ai-settings__pill ai-settings__pill--warn"
          >
            ● {{ t('ai.ollama.detectedNoModels') }}
          </span>
          <span v-else class="ai-settings__pill ai-settings__pill--err">
            ● {{ t('ai.ollama.notDetected') }}
          </span>

          <span v-if="detection?.ok && detection.version" class="ai-settings__hint">
            {{ t('ai.ollama.version', { version: detection.version }) }}
          </span>
          <!-- v4.11.18 — always say WHICH address was probed. A remote
               server that answers on a LAN IP is indistinguishable from a
               missing local one otherwise. -->
          <span v-if="detection && !detecting" class="ai-settings__hint">
            {{ t('ai.probedAt', { url: probeUrl }) }}
          </span>

          <button
            type="button"
            class="ai-settings__btn"
            :disabled="detecting"
            @click="detectOllama(true)"
          >
            {{ t('ai.ollama.refresh') }}
          </button>
          <button
            v-if="detection && !detection.ok && !probeIsRemote"
            type="button"
            class="ai-settings__btn ai-settings__btn--primary"
            @click="openInstallPage"
          >
            {{ t('ai.ollama.install') }}
          </button>
        </div>

        <!-- A remote address that doesn't answer is almost always one of
             two things: the server was started without OLLAMA_HOST, or the
             port is firewalled. Installing Ollama locally fixes neither. -->
        <p
          v-if="detection && !detection.ok && probeIsRemote"
          class="ai-settings__hint"
        >
          {{ t('ai.ollama.remoteHint') }}
        </p>

        <!-- Pull-recommended CTA when Ollama is up but has zero models. -->
        <div
          v-if="detection?.ok && detection.models.length === 0 && !pullDone"
          class="ai-settings__ollama-row"
        >
          <button
            type="button"
            class="ai-settings__btn ai-settings__btn--primary"
            :disabled="pulling"
            @click="pullRecommended"
          >
            {{ pulling
              ? t('ai.ollama.pulling', { model: OLLAMA_RECOMMENDED_MODEL })
              : t('ai.ollama.pullRecommended', { model: OLLAMA_RECOMMENDED_MODEL })
            }}
          </button>
          <button
            v-if="pulling"
            type="button"
            class="ai-settings__btn"
            @click="cancelPull"
          >
            {{ t('ai.ollama.cancelPull') }}
          </button>
        </div>

        <!-- Pull progress bar + status line. Visible during the pull and
             for one render after `pullDone` (so the user sees "Pulled —
             ready" before the model picker block takes over). -->
        <div v-if="pulling || pullDone || pullError" class="ai-settings__ollama-row ai-settings__pull">
          <div class="ai-settings__pullbar" :aria-valuenow="pullPct ?? 0">
            <div
              class="ai-settings__pullbar-fill"
              :style="{ width: pullPct != null ? `${(pullPct * 100).toFixed(1)}%` : '6%' }"
              :class="{ 'ai-settings__pullbar-fill--indeterminate': pullPct == null && pulling }"
            />
          </div>
          <span class="ai-settings__hint">
            <template v-if="pullError">{{ t('ai.ollama.pullFailed') }}: {{ pullError }}</template>
            <template v-else-if="pullDone">{{ t('ai.ollama.pulled') }}</template>
            <template v-else>{{ pullStatus }}</template>
          </span>
        </div>

        <!-- Model picker once we have at least one local model. Presets
             are radio chips (cheap, scannable); "Other:" gives access to
             everything else the user has pulled. -->
        <div
          v-if="detection?.ok && detection.models.length > 0"
          class="ai-settings__ollama-models"
        >
          <span class="ai-settings__label">{{ t('ai.ollama.modelLabel') }}</span>
          <div class="ai-settings__chips">
            <label
              v-for="p in ollamaModelOptions.presets"
              :key="p.id"
              class="ai-settings__chip"
              :class="{
                'ai-settings__chip--selected': model === p.model,
                'ai-settings__chip--missing': !detection.models.includes(p.model),
              }"
            >
              <input
                type="radio"
                name="ollama-preset"
                :value="p.model"
                :checked="model === p.model"
                @change="emit('update:model', p.model)"
              />
              <span>{{ t(p.labelKey) }}</span>
            </label>
          </div>
          <div v-if="ollamaModelOptions.others.length > 0" class="ai-settings__row">
            <span class="ai-settings__label">{{ t('ai.ollama.otherModel') }}</span>
            <select
              class="ai-settings__input"
              :value="ollamaModelOptions.others.includes(model) ? model : ''"
              @change="emit('update:model', ($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled>—</option>
              <option v-for="m in ollamaModelOptions.others" :key="m" :value="m">
                {{ m }}
              </option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <!-- v4.0 pillar 1 — Agent Panel settings. -->
    <h3 class="ai-settings__heading ai-settings__heading--sub">{{ t('agentSettings.heading') }}</h3>
    <div class="ai-settings__group">
      <label class="ai-settings__row ai-settings__row--toggle">
        <input
          type="checkbox"
          :checked="settingsStore.agentAllowWrite"
          @change="settingsStore.toggleAgentAllowWrite()"
        />
        <span>
          <span class="ai-settings__label">{{ t('agentSettings.allowWrite') }}</span>
          <span class="ai-settings__hint">{{ t('agentSettings.allowWriteHint') }}</span>
        </span>
      </label>

      <div class="ai-settings__row">
        <label class="ai-settings__label" for="agent-loop-cap">{{ t('agentSettings.loopCap') }}</label>
        <input
          id="agent-loop-cap"
          type="number"
          min="1"
          max="20"
          step="1"
          :value="settingsStore.agentToolLoopCap"
          class="ai-settings__input ai-settings__input--narrow"
          @change="settingsStore.setAgentToolLoopCap(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="ai-settings__hint">{{ t('agentSettings.loopCapHint') }}</span>
      </div>

      <div class="ai-settings__row ai-settings__row--block">
        <span class="ai-settings__label">{{ t('agentSettings.recentRuns') }}</span>
        <div class="ai-settings__runs">
          <p v-if="!workspaceStore.currentFolder" class="ai-settings__hint">
            {{ t('agentSettings.noWorkspace') }}
          </p>
          <p v-else-if="runsLoading" class="ai-settings__hint">{{ t('agentSettings.loading') }}</p>
          <p v-else-if="!recentRuns.length" class="ai-settings__hint">
            {{ t('agentSettings.noRuns') }}
          </p>
          <ul v-else class="ai-settings__runs-list">
            <li v-for="r in recentRuns" :key="r.run_id" class="ai-settings__run">
              <button class="ai-settings__run-link" type="button" @click="openRunMd(r)">
                <code class="ai-settings__run-id">{{ r.run_id }}</code>
              </button>
              <span class="ai-settings__run-meta">
                <span :class="['ai-settings__run-pill', `ai-settings__run-pill--${r.status}`]">{{ r.status }}</span>
                <span class="ai-settings__run-kind">{{ r.kind }}</span>
                <span class="ai-settings__run-time">{{ fmtRunStartedAt(r.started_at) }}</span>
                <span v-if="fmtRunUsage(r)" class="ai-settings__run-usage">{{ fmtRunUsage(r) }}</span>
              </span>
            </li>
          </ul>
          <button
            v-if="workspaceStore.currentFolder"
            type="button"
            class="ai-settings__btn ai-settings__btn--small"
            @click="refreshRuns"
          >{{ t('agentSettings.refresh') }}</button>
        </div>
      </div>

      <!-- v4.0 first-run wizard re-launch — for users who skipped on day one -->
      <div class="ai-settings__row">
        <button
          type="button"
          class="ai-settings__btn ai-settings__btn--small"
          @click="reopenWizard"
        >
          {{ t('wizard.reopenBtn') }}
        </button>
      </div>
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
  flex: 1 1 0;
  /* #470 — the provider <select>'s intrinsic width is its widest <option>
     ("OpenAI 兼容 / OpenAI-compatible (llama.cpp · LM Studio · vLLM)"), and a
     flex item's default min-width:auto refuses to shrink below that, blowing
     the row past the card edge. Allow shrinking; the closed control then
     matches the model input like every other row. */
  min-width: 0;
  box-sizing: border-box;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
}
select.ai-settings__input {
  flex: 0 1 260px;
  max-width: 260px;
  width: 100%;
  text-overflow: ellipsis;
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
.ai-settings__pill--err {
  color: #dc2626;
  border-color: rgba(220, 38, 38, 0.4);
}
.ai-settings__msg--ok { color: #16a34a; }
.ai-settings__msg--err { color: #dc2626; }
.ai-settings__note {
  font-size: 11px;
  color: var(--text-muted);
  margin: 4px 0 0;
}
.ai-settings__heading--sub {
  margin-top: 14px;
}
.ai-settings__row--block {
  align-items: flex-start;
}
.ai-settings__input--narrow {
  flex: 0 0 80px;
  max-width: 80px;
}
.ai-settings__runs {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ai-settings__runs-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 240px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
}
.ai-settings__run {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
}
.ai-settings__run:last-child {
  border-bottom: none;
}
.ai-settings__run-link {
  background: transparent;
  border: none;
  padding: 0;
  margin: 0;
  cursor: pointer;
  flex-shrink: 0;
}
.ai-settings__run-link:hover code {
  text-decoration: underline;
}
.ai-settings__run-id {
  font-family: "JetBrains Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--accent, #6366f1);
}
.ai-settings__run-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--text-muted);
}
.ai-settings__run-pill {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--bg-soft);
  color: var(--text-muted);
}
.ai-settings__run-pill--ok {
  color: #16a34a;
  background: rgba(22, 163, 74, 0.12);
}
.ai-settings__run-pill--running {
  color: #d97706;
  background: rgba(217, 119, 6, 0.12);
}
.ai-settings__run-pill--error,
.ai-settings__run-pill--cancelled,
.ai-settings__run-pill--rejected {
  color: #dc2626;
  background: rgba(220, 38, 38, 0.12);
}
.ai-settings__run-kind {
  font-style: italic;
}
.ai-settings__run-usage {
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  font-size: 11px;
}
.ai-settings__btn--small {
  padding: 4px 10px;
  font-size: 11px;
  align-self: flex-start;
}

/* v4.0 P5 — Ollama detect / pull / model-picker block */
.ai-settings__ollama {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ai-settings__ollama-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.ai-settings__pull {
  flex-direction: column;
  align-items: stretch;
}
.ai-settings__pullbar {
  width: 100%;
  height: 6px;
  border-radius: 3px;
  background: var(--bg);
  border: 1px solid var(--border);
  overflow: hidden;
}
.ai-settings__pullbar-fill {
  height: 100%;
  background: var(--accent, #6366f1);
  transition: width 120ms ease-out;
}
@keyframes ai-settings-pullbar-indeterminate {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(2000%); }
}
.ai-settings__pullbar-fill--indeterminate {
  width: 6%;
  animation: ai-settings-pullbar-indeterminate 1.4s ease-in-out infinite;
}
.ai-settings__ollama-models {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ai-settings__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ai-settings__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 11px;
  cursor: pointer;
  background: var(--bg);
  color: var(--text);
}
.ai-settings__chip:hover {
  border-color: var(--accent);
}
.ai-settings__chip input {
  /* Radio is the source of truth for a11y; visually we use the chip
     border + background to indicate selection. */
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.ai-settings__chip--selected {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent, #6366f1) 12%, var(--bg));
}
.ai-settings__chip--missing {
  /* Preset model not yet pulled — still selectable so the user can pick
     it before pulling, but visually faded. */
  opacity: 0.55;
}
</style>
