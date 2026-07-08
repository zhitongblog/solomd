<script setup lang="ts">
/**
 * v4.0 — First-run agent setup wizard.
 *
 * Modal that shows once on a fresh install (after the existing welcome
 * tour) and routes the user into the BYOK / Ollama choice. Re-openable
 * from Settings → AI ("Run setup again"). The wizard is opt-out (close
 * button + "I'll set this up later"); it never blocks the editor.
 *
 * Steps:
 *   1. Choice: Cloud BYOK · Local Ollama · Skip
 *   2a. Cloud:  pick provider (Anthropic / OpenAI / Gemini default), paste key, verify
 *   2b. Ollama: detect → "Install Ollama" link if missing, "Pull qwen2.5:1.5b" if no model
 *   3. Done — closes wizard, marks `agentWizardSeen` so it doesn't re-fire.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useSettingsStore } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import { providerById } from '../lib/ai-providers';
import { useI18n } from '../i18n';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { t } = useI18n();
const settings = useSettingsStore();
const toasts = useToastsStore();

type Step = 'choose' | 'cloud' | 'ollama' | 'done';
const step = ref<Step>('choose');

// ---- Cloud branch ----------------------------------------------------------
type CloudProvider = 'anthropic' | 'openai' | 'gemini' | 'deepseek';
const cloudProvider = ref<CloudProvider>('anthropic');
const cloudKey = ref('');
const verifying = ref(false);
const verifyResult = ref<'ok' | 'fail' | null>(null);
const verifyMessage = ref('');

const cloudModels: Record<CloudProvider, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
  deepseek: 'deepseek-chat',
};

async function saveCloudKey() {
  if (!cloudKey.value.trim()) {
    toasts.error(t('wizard.errKeyEmpty'));
    return;
  }
  verifying.value = true;
  verifyResult.value = null;
  verifyMessage.value = '';
  try {
    await invoke('ai_set_key', {
      provider: cloudProvider.value,
      key: cloudKey.value.trim(),
    });
    // Quick verify — same command (and SAME ARGS) the AI Settings panel
    // uses. `ai_verify_key` switches on the wire format, not the brand id:
    // without `apiFormat` it falls back to the provider id ("deepseek",
    // "gemini", …) and errors `unknown api_format: <id>` for every provider
    // whose id isn't literally "openai"/"anthropic"/"ollama". Pass the
    // provider config's apiFormat + defaultBaseUrl (and the key directly,
    // avoiding a keystore read race) so DeepSeek/Gemini/etc. verify cleanly.
    const cfg = providerById(cloudProvider.value);
    try {
      await invoke('ai_verify_key', {
        provider: cloudProvider.value,
        key: cloudKey.value.trim(),
        apiFormat: cfg?.apiFormat || 'openai',
        baseUrl: cfg?.defaultBaseUrl || null,
      });
      verifyResult.value = 'ok';
      verifyMessage.value = t('wizard.verifyOk');
    } catch (e: any) {
      verifyResult.value = 'fail';
      verifyMessage.value = String(e);
      // Key was saved anyway; the user can fix the model later.
    }
    settings.setAiProvider(cloudProvider.value);
    settings.setAiModel(cloudModels[cloudProvider.value]);
    if (!settings.aiEnabled) settings.toggleAiEnabled();
    if (verifyResult.value === 'ok') {
      step.value = 'done';
    }
  } catch (e: any) {
    verifyResult.value = 'fail';
    verifyMessage.value = String(e);
  } finally {
    verifying.value = false;
  }
}

// ---- Ollama branch ---------------------------------------------------------
//
// The Tauri command shape mirrors `app/src-tauri/src/ollama.rs`:
//   - `ollama_detect()` → `{ ok, version?, models }`
//   - `ollama_pull({ model, request_id })` resolves when done; progress is
//     pushed as `solomd://ollama-pull` events tagged with our `request_id`.
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

interface OllamaDetect {
  ok: boolean;
  version?: string | null;
  models: string[];
}
const ollama = ref<OllamaDetect>({ ok: false, version: null, models: [] });
const detecting = ref(false);
const pulling = ref(false);
const pullPct = ref(0);
const pullStatus = ref('');
// Hoisted to component scope so onBeforeUnmount can clean them up even if
// the user closes the wizard mid-pull. Otherwise we leak the listener and
// the multi-GB pull keeps running with no UI to cancel it.
let pullUnlisten: UnlistenFn | null = null;
let pullRequestId: string | null = null;

async function detectOllama() {
  detecting.value = true;
  try {
    ollama.value = await invoke<OllamaDetect>('ollama_detect');
  } catch (e) {
    toasts.error(`Ollama detect: ${e}`);
  } finally {
    detecting.value = false;
  }
}

async function openOllamaInstall() {
  try {
    await invoke('open_ollama_install_page');
  } catch {
    await openUrl('https://ollama.com/download');
  }
}

async function pullRecommended() {
  if (pulling.value) return;
  pulling.value = true;
  pullPct.value = 0;
  pullStatus.value = '';
  pullRequestId = `wiz-pull-${Date.now()}`;

  // Subscribe BEFORE invoking to avoid missing the first events.
  if (pullUnlisten) {
    pullUnlisten();
    pullUnlisten = null;
  }
  pullUnlisten = await listen<{
    request_id: string;
    status: string;
    completed?: number;
    total?: number;
    done: boolean;
  }>('solomd://ollama-pull', (e) => {
    if (e.payload.request_id !== pullRequestId) return;
    pullStatus.value = e.payload.status;
    if (
      typeof e.payload.completed === 'number' &&
      typeof e.payload.total === 'number' &&
      e.payload.total > 0
    ) {
      pullPct.value = (e.payload.completed / e.payload.total) * 100;
    }
  });

  try {
    await invoke('ollama_pull', { model: 'qwen2.5:1.5b', requestId: pullRequestId });
    toasts.success(t('wizard.ollamaPullDone'));
    await detectOllama();
  } catch (e) {
    toasts.error(`Pull: ${e}`);
  } finally {
    pulling.value = false;
    pullRequestId = null;
    if (pullUnlisten) {
      pullUnlisten();
      pullUnlisten = null;
    }
  }
}

function adoptOllama() {
  settings.setAiProvider('ollama');
  // Pick the first installed model, or fall back to the recommended.
  const m = ollama.value.models[0] ?? 'qwen2.5:1.5b';
  settings.setAiModel(m);
  if (!settings.aiEnabled) settings.toggleAiEnabled();
  step.value = 'done';
}

// ---- Step navigation -------------------------------------------------------

function pickCloud() {
  step.value = 'cloud';
}

async function pickOllama() {
  step.value = 'ollama';
  await detectOllama();
}

function skip() {
  finish();
}

function finish() {
  settings.markAgentWizardSeen();
  emit('close');
  // Reset internal state so re-opening starts fresh.
  setTimeout(() => {
    step.value = 'choose';
    cloudKey.value = '';
    verifyResult.value = null;
    verifyMessage.value = '';
  }, 300);
}

const ollamaCanAdopt = computed(
  () => ollama.value.ok && ollama.value.models.length > 0,
);
// Default Ollama base — Settings.aiBaseUrl can override at the AI layer,
// but the wizard just shows the canonical one for the success messages.
const ollamaUrl = 'http://localhost:11434';

onMounted(() => {
  // Pre-detect ollama in the background so the choice card can highlight
  // the local option if it's already installed (subtle dot, no claim).
  invoke<OllamaDetect>('ollama_detect')
    .then((s) => {
      ollama.value = s;
    })
    .catch(() => {});
});

// Cleanup: if the user closes the wizard (or HMR remounts) while a multi-GB
// model pull is in flight, we must unlisten the `solomd://ollama-pull`
// subscription AND best-effort cancel the pull so it doesn't keep churning
// disk + bandwidth in the background with no UI to stop it.
onBeforeUnmount(() => {
  if (pulling.value && pullRequestId) {
    invoke('ollama_cancel_pull', { requestId: pullRequestId }).catch(() => {});
  }
  if (pullUnlisten) {
    pullUnlisten();
    pullUnlisten = null;
  }
  pullRequestId = null;
});

// CJK / IME guard for the cloud-key input. Same anti-pattern fix as
// AgentPanel.vue::onKeydown — pinyin commit Enter must not be treated as
// "submit". On a clean Enter press we fire saveCloudKey() so users don't
// have to reach for the mouse.
function onCloudKeyKey(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!verifying.value) void saveCloudKey();
  }
}
</script>

<template>
  <Teleport to="body">
  <div v-if="props.open" class="wiz-backdrop" @click.self="finish">
    <div class="wiz" role="dialog" aria-modal="true">
      <button class="wiz__close" @click="finish" :title="t('wizard.close')">×</button>

      <!-- Step: Choose ---------------------------------------------------- -->
      <div v-if="step === 'choose'" class="wiz__step">
        <h2 class="wiz__title">{{ t('wizard.chooseTitle') }}</h2>
        <p class="wiz__sub">{{ t('wizard.chooseSub') }}</p>

        <div class="wiz__cards">
          <button class="wiz-card" @click="pickCloud">
            <div class="wiz-card__head">
              <span class="wiz-card__emoji">☁️</span>
              <span class="wiz-card__title">{{ t('wizard.cloudTitle') }}</span>
            </div>
            <p class="wiz-card__body">{{ t('wizard.cloudBody') }}</p>
            <p class="wiz-card__meta">{{ t('wizard.cloudMeta') }}</p>
          </button>

          <button class="wiz-card" @click="pickOllama">
            <div class="wiz-card__head">
              <span class="wiz-card__emoji">🖥️</span>
              <span class="wiz-card__title">{{ t('wizard.localTitle') }}</span>
              <span
                v-if="ollama.ok"
                class="wiz-card__badge wiz-card__badge--ok"
                :title="t('wizard.localDetected')"
              >●</span>
            </div>
            <p class="wiz-card__body">{{ t('wizard.localBody') }}</p>
            <p class="wiz-card__meta">{{ t('wizard.localMeta') }}</p>
          </button>
        </div>

        <button class="wiz__skip" @click="skip">{{ t('wizard.skip') }}</button>
      </div>

      <!-- Step: Cloud ----------------------------------------------------- -->
      <div v-else-if="step === 'cloud'" class="wiz__step">
        <h2 class="wiz__title">{{ t('wizard.cloudTitle') }}</h2>
        <p class="wiz__sub">{{ t('wizard.cloudSub') }}</p>

        <div class="wiz__row">
          <label>{{ t('wizard.providerLabel') }}</label>
          <select v-model="cloudProvider" class="wiz__sel">
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (ChatGPT)</option>
            <option value="gemini">Google Gemini</option>
            <option value="deepseek">DeepSeek</option>
          </select>
        </div>

        <div class="wiz__row">
          <label>{{ t('wizard.keyLabel') }}</label>
          <input
            v-model="cloudKey"
            type="password"
            class="wiz__inp"
            :placeholder="t('wizard.keyPlaceholder')"
            spellcheck="false"
            @keydown="onCloudKeyKey"
          />
        </div>

        <p
          v-if="verifyResult === 'fail'"
          class="wiz__err"
        >{{ verifyMessage }}</p>
        <p
          v-else-if="verifyResult === 'ok'"
          class="wiz__ok"
        >{{ verifyMessage }}</p>
        <p v-else class="wiz__hint">{{ t('wizard.cloudHint') }}</p>

        <div class="wiz__buttons">
          <button class="wiz__btn wiz__btn--ghost" @click="step = 'choose'">
            {{ t('wizard.back') }}
          </button>
          <button
            class="wiz__btn wiz__btn--primary"
            :disabled="verifying"
            @click="saveCloudKey"
          >
            {{ verifying ? t('wizard.verifying') : t('wizard.saveAndContinue') }}
          </button>
        </div>
      </div>

      <!-- Step: Ollama ---------------------------------------------------- -->
      <div v-else-if="step === 'ollama'" class="wiz__step">
        <h2 class="wiz__title">{{ t('wizard.localTitle') }}</h2>

        <div v-if="detecting" class="wiz__hint">{{ t('wizard.localDetecting') }}</div>

        <div v-else-if="!ollama.ok" class="wiz__block">
          <p class="wiz__err">{{ t('wizard.localNotRunning') }}</p>
          <p class="wiz__hint">{{ t('wizard.localNotRunningHint') }}</p>
          <div class="wiz__buttons">
            <button class="wiz__btn wiz__btn--ghost" @click="step = 'choose'">
              {{ t('wizard.back') }}
            </button>
            <button class="wiz__btn" @click="openOllamaInstall">
              {{ t('wizard.localInstallBtn') }}
            </button>
            <button class="wiz__btn wiz__btn--primary" @click="detectOllama">
              {{ t('wizard.localRetryBtn') }}
            </button>
          </div>
        </div>

        <div v-else-if="ollama.models.length === 0" class="wiz__block">
          <p class="wiz__ok">
            {{ t('wizard.localRunningNoModel', { url: ollamaUrl }) }}
          </p>
          <p class="wiz__hint">{{ t('wizard.localPullHint') }}</p>
          <div class="wiz__pull">
            <button
              class="wiz__btn wiz__btn--primary"
              :disabled="pulling"
              @click="pullRecommended"
            >
              {{ pulling
                ? t('wizard.localPullingPct', { pct: String(Math.round(pullPct)) })
                : t('wizard.localPullBtn') }}
            </button>
          </div>
          <div class="wiz__buttons">
            <button class="wiz__btn wiz__btn--ghost" @click="step = 'choose'">
              {{ t('wizard.back') }}
            </button>
          </div>
        </div>

        <div v-else class="wiz__block">
          <p class="wiz__ok">
            {{ t('wizard.localReady', {
              n: String(ollama.models.length),
              url: ollamaUrl,
            }) }}
          </p>
          <ul class="wiz__models">
            <li v-for="m in ollama.models" :key="m"><code>{{ m }}</code></li>
          </ul>
          <div class="wiz__buttons">
            <button class="wiz__btn wiz__btn--ghost" @click="step = 'choose'">
              {{ t('wizard.back') }}
            </button>
            <button
              class="wiz__btn wiz__btn--primary"
              :disabled="!ollamaCanAdopt"
              @click="adoptOllama"
            >
              {{ t('wizard.localUseFirst') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Step: Done ------------------------------------------------------ -->
      <div v-else-if="step === 'done'" class="wiz__step">
        <h2 class="wiz__title">{{ t('wizard.doneTitle') }}</h2>
        <p class="wiz__sub">{{ t('wizard.doneSub') }}</p>
        <ul class="wiz__next">
          <li>{{ t('wizard.doneNext1') }}</li>
          <li>{{ t('wizard.doneNext2') }}</li>
          <li>{{ t('wizard.doneNext3') }}</li>
        </ul>
        <div class="wiz__buttons">
          <button class="wiz__btn wiz__btn--primary" @click="finish">
            {{ t('wizard.doneClose') }}
          </button>
        </div>
      </div>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.wiz-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-modal);
  backdrop-filter: blur(2px);
}
.wiz {
  position: relative;
  width: min(560px, 92vw);
  max-height: 90vh;
  overflow-y: auto;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  padding: 24px 28px;
}
.wiz__close {
  position: absolute;
  top: 8px;
  right: 12px;
  background: none;
  border: none;
  font-size: 22px;
  line-height: 1;
  color: var(--text-muted);
  cursor: pointer;
}
.wiz__close:hover {
  color: var(--text);
}
.wiz__step {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.wiz__title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.wiz__sub {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}
.wiz__hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}
.wiz__err {
  margin: 0;
  font-size: 12px;
  color: var(--danger, #c0413a);
}
.wiz__ok {
  margin: 0;
  font-size: 12px;
  color: var(--accent, #2da44e);
}

.wiz__cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 8px;
}
.wiz-card {
  text-align: left;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-secondary, transparent);
  cursor: pointer;
  transition: border-color 0.1s, transform 0.1s;
}
.wiz-card:hover {
  border-color: var(--accent, #4078c0);
  transform: translateY(-1px);
}
.wiz-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.wiz-card__emoji {
  font-size: 18px;
}
.wiz-card__title {
  font-size: 14px;
  font-weight: 600;
}
.wiz-card__body {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text);
}
.wiz-card__meta {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--text-muted);
}
.wiz-card__badge {
  margin-left: auto;
  font-size: 10px;
}
.wiz-card__badge--ok {
  color: var(--accent, #2da44e);
}

.wiz__skip {
  align-self: center;
  margin-top: 8px;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}
.wiz__skip:hover {
  color: var(--text);
}

.wiz__row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.wiz__row label {
  color: var(--text-muted);
}
.wiz__sel,
.wiz__inp {
  font: inherit;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
}

.wiz__buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.wiz__btn {
  font: inherit;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  cursor: pointer;
}
.wiz__btn:hover:not(:disabled) {
  background: var(--bg-secondary);
}
.wiz__btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.wiz__btn--primary {
  background: var(--accent, #4078c0);
  color: white;
  border-color: var(--accent, #4078c0);
}
.wiz__btn--primary:hover:not(:disabled) {
  background: var(--accent-strong, #305d99);
}
.wiz__btn--ghost {
  background: transparent;
}

.wiz__models {
  margin: 4px 0;
  padding-left: 18px;
  font-size: 12px;
}
.wiz__models li {
  margin: 2px 0;
}
.wiz__pull {
  display: flex;
  justify-content: center;
  margin: 8px 0;
}

.wiz__next {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
}
.wiz__block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
