<script setup lang="ts">
/**
 * AIRewriteOverlay — v2.0 F4 inline AI rewrite floating panel.
 *
 * Triggered by the `solomd:ai-rewrite-open` custom event (dispatched from
 * `cm-ai-rewrite.ts` on Cmd-J). Lets the user pick an action (rewrite /
 * shorten / expand / translate / explain / custom prompt), streams the
 * proposed text from the chosen provider, and emits accept / cancel events
 * back to App.vue.
 *
 * Streaming flow:
 *   1. User opens overlay (selection captured in `range`).
 *   2. User picks an action; we call `ai_rewrite` (returns request_id).
 *   3. We listen for `solomd://ai-chunk` / `-done` / `-error` events,
 *      filtering by request_id, and append chunks to `proposed`.
 *   4. Accept (Cmd+Enter) → dispatch `solomd:ai-rewrite-accept`.
 *      Reject (Esc) → dispatch `solomd:ai-rewrite-cancel`.
 *      Re-roll → cancel + restart with same action.
 *
 * Provider config (provider id, model, base URL, key-presence) is supplied
 * by the parent so this component never reaches into the settings store
 * directly.
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ACTIONS, providerById, type AIAction, type ProviderId } from '../lib/ai-providers';
import {
  AI_REWRITE_OPEN_EVENT,
  AI_REWRITE_ACCEPT_EVENT,
  AI_REWRITE_CANCEL_EVENT,
  type AIRewriteOpenDetail,
  type AIRewriteAcceptDetail,
} from '../lib/cm-ai-rewrite';
import { useI18n } from '../i18n';

const { t } = useI18n();

const props = defineProps<{
  /** Whether AI rewrite is enabled in settings. If false, we silently ignore opens. */
  enabled: boolean;
  /** Current provider id (openai / anthropic / ollama). */
  provider: ProviderId;
  /** Selected model. */
  model: string;
  /** Optional base URL override. */
  baseUrl?: string;
  /** Whether the user has stored a key for the current provider. */
  hasKey: boolean;
}>();

const emit = defineEmits<{
  (e: 'open-settings'): void;
}>();

// --- State ----------------------------------------------------------------

interface Range {
  selection: string;
  from: number;
  to: number;
}

const open = ref(false);
const range = ref<Range | null>(null);
const action = ref<AIAction | null>(null);
const customPrompt = ref('');
const proposed = ref('');
const streaming = ref(false);
const streamingError = ref<string | null>(null);
const requestId = ref<string | null>(null);
const sentBanner = ref(false);

const proposedRef = ref<HTMLDivElement | null>(null);

/**
 * Local mirror of "does this provider have a key in keychain?". The
 * `hasKey` prop is set in App.vue by a watchEffect that only fires on
 * aiEnabled / aiProvider change, so it goes stale right after a save
 * in Settings (the keychain has the key, but the prop is still false
 * — and the action buttons stay gated). We refresh this every time
 * the overlay opens, which is cheap and authoritative.
 */
const liveHasKey = ref(false);

const providerLabel = computed(
  () => providerById(props.provider)?.label || props.provider,
);

const needsKey = computed(
  () => props.provider !== 'ollama' && !liveHasKey.value,
);

async function refreshLiveHasKey(): Promise<void> {
  try {
    liveHasKey.value = await invoke<boolean>('ai_has_key', {
      provider: props.provider,
    });
  } catch {
    liveHasKey.value = false;
  }
}

// --- Open / close ----------------------------------------------------------

function reset(): void {
  proposed.value = '';
  streamingError.value = null;
  sentBanner.value = false;
}

function close(): void {
  cancelStream();
  open.value = false;
  range.value = null;
  action.value = null;
  customPrompt.value = '';
  reset();
}

function onOpenEvent(ev: Event): void {
  const ce = ev as CustomEvent<AIRewriteOpenDetail>;
  if (!ce.detail || !ce.detail.selection) return;
  if (!props.enabled) return;
  range.value = { ...ce.detail };
  action.value = null;
  customPrompt.value = '';
  reset();
  open.value = true;
  // Authoritative key check now, in case the prop is stale.
  void refreshLiveHasKey();
}

function onKeydown(ev: KeyboardEvent): void {
  if (!open.value) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    onReject();
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
    if (proposed.value && !streaming.value && !streamingError.value) {
      ev.preventDefault();
      onAccept();
    }
  }
}

// --- Streaming -------------------------------------------------------------

let unlistenChunk: UnlistenFn | null = null;
let unlistenDone: UnlistenFn | null = null;
let unlistenError: UnlistenFn | null = null;

async function ensureListeners(): Promise<void> {
  if (unlistenChunk) return;
  unlistenChunk = await listen<{ request_id: string; chunk: string }>(
    'solomd://ai-chunk',
    (e) => {
      console.log('[ai] chunk', e.payload.request_id, JSON.stringify(e.payload.chunk).slice(0, 80));
      if (!requestId.value || e.payload.request_id !== requestId.value) return;
      proposed.value += e.payload.chunk;
      autoscroll();
    },
  );
  unlistenDone = await listen<{ request_id: string; full_text: string }>(
    'solomd://ai-done',
    (e) => {
      console.log('[ai] done', e.payload.request_id, 'full length=', e.payload.full_text?.length);
      if (!requestId.value || e.payload.request_id !== requestId.value) return;
      if (e.payload.full_text && e.payload.full_text.length >= proposed.value.length) {
        proposed.value = e.payload.full_text;
      }
      streaming.value = false;
      requestId.value = null;
    },
  );
  unlistenError = await listen<{ request_id: string; error: string }>(
    'solomd://ai-error',
    (e) => {
      console.warn('[ai] error event', e.payload);
      if (!requestId.value || e.payload.request_id !== requestId.value) return;
      if (e.payload.error !== 'cancelled') {
        streamingError.value = e.payload.error;
      }
      streaming.value = false;
      requestId.value = null;
    },
  );
}

function autoscroll(): void {
  void nextTick(() => {
    const el = proposedRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

async function startAction(a: AIAction): Promise<void> {
  console.log('[ai] startAction', a.id, {
    hasRange: !!range.value,
    needsKey: needsKey.value,
    liveHasKey: liveHasKey.value,
    provider: props.provider,
    model: props.model,
    baseUrl: props.baseUrl,
  });
  if (!range.value) {
    streamingError.value = 'No selection captured — close and re-select text.';
    streaming.value = true;
    sentBanner.value = false;
    action.value = a;
    return;
  }
  if (needsKey.value) {
    streamingError.value =
      `No API key found in keychain for "${props.provider}". Open AI Settings, paste your key, click Save & verify.`;
    streaming.value = true;
    sentBanner.value = false;
    action.value = a;
    return;
  }
  if (a.custom && !customPrompt.value.trim()) {
    action.value = a;
    return;
  }
  action.value = a;
  reset();
  streaming.value = true;
  sentBanner.value = true;
  await ensureListeners();
  try {
    const userPrompt = a.custom ? customPrompt.value.trim() : a.user;
    const cfg = providerById(props.provider);
    const payload = {
      provider: props.provider,
      api_format: cfg?.apiFormat || 'openai',
      model: props.model || cfg?.defaultModel || '',
      system: a.system,
      user: userPrompt,
      selection: range.value.selection,
      base_url: props.baseUrl || cfg?.defaultBaseUrl || null,
    };
    console.log('[ai] invoke ai_rewrite', payload);
    const id = await invoke<string>('ai_rewrite', { request: payload });
    console.log('[ai] ai_rewrite returned request_id', id);
    requestId.value = id;
  } catch (err) {
    console.error('[ai] ai_rewrite invoke threw', err);
    streaming.value = false;
    streamingError.value = String(err);
  }
}

async function cancelStream(): Promise<void> {
  const id = requestId.value;
  if (id) {
    try {
      await invoke('ai_cancel', { requestId: id });
    } catch {
      /* best-effort */
    }
  }
  streaming.value = false;
  requestId.value = null;
}

async function onReroll(): Promise<void> {
  if (!action.value) return;
  await cancelStream();
  await startAction(action.value);
}

function onAccept(): void {
  if (!range.value || !proposed.value) return;
  const detail: AIRewriteAcceptDetail = {
    from: range.value.from,
    to: range.value.to,
    replacement: proposed.value,
  };
  window.dispatchEvent(new CustomEvent(AI_REWRITE_ACCEPT_EVENT, { detail }));
  close();
}

function onReject(): void {
  window.dispatchEvent(new CustomEvent(AI_REWRITE_CANCEL_EVENT));
  close();
}

function onSetKey(): void {
  // Close the overlay before opening Settings — otherwise the overlay
  // sits on top of the Settings dialog and the user has to dismiss it
  // manually before they can configure anything.
  close();
  emit('open-settings');
}

watch(
  () => props.provider,
  () => {
    // Provider changed mid-overlay; clear any in-flight stream.
    if (streaming.value) cancelStream();
  },
);

onMounted(() => {
  window.addEventListener(AI_REWRITE_OPEN_EVENT, onOpenEvent as EventListener);
  window.addEventListener('keydown', onKeydown);
  // Initial sync — keeps the gate truthful even before the first open.
  void refreshLiveHasKey();
});

onBeforeUnmount(() => {
  window.removeEventListener(AI_REWRITE_OPEN_EVENT, onOpenEvent as EventListener);
  window.removeEventListener('keydown', onKeydown);
  cancelStream();
  unlistenChunk?.();
  unlistenDone?.();
  unlistenError?.();
  unlistenChunk = unlistenDone = unlistenError = null;
});
</script>

<template>
  <div v-if="open" class="ai-overlay__backdrop" @click.self="onReject">
    <div class="ai-overlay" role="dialog" aria-label="AI rewrite">
      <header class="ai-overlay__head">
        <span class="ai-overlay__title">{{ t('ai.rewrite') }}</span>
        <button class="ai-overlay__close" @click="onReject" aria-label="Close">×</button>
      </header>

      <!-- No-key CTA --------------------------------------------------- -->
      <div v-if="needsKey" class="ai-overlay__nokey">
        <p>{{ t('ai.noKey') }}</p>
        <button class="ai-overlay__btn ai-overlay__btn--primary" @click="onSetKey">
          {{ t('ai.setKey') }}
        </button>
      </div>

      <!-- Action picker ------------------------------------------------ -->
      <div v-else-if="!action || (action.custom && !customPrompt && !proposed)" class="ai-overlay__picker">
        <button
          v-for="a in ACTIONS"
          :key="a.id"
          class="ai-overlay__action"
          :class="{ 'ai-overlay__action--active': action?.id === a.id }"
          @click="startAction(a)"
        >
          {{ t(a.labelKey) }}
        </button>
        <div v-if="action?.custom" class="ai-overlay__custom">
          <label class="ai-overlay__label">{{ t('ai.customPrompt') }}</label>
          <textarea
            v-model="customPrompt"
            class="ai-overlay__textarea"
            rows="3"
            :placeholder="t('ai.customPrompt')"
            @keydown.meta.enter.prevent="action && startAction(action)"
            @keydown.ctrl.enter.prevent="action && startAction(action)"
          ></textarea>
          <button
            class="ai-overlay__btn ai-overlay__btn--primary"
            :disabled="!customPrompt.trim()"
            @click="action && startAction(action)"
          >
            {{ t('ai.rewrite') }}
          </button>
        </div>
      </div>

      <!-- Streaming view ----------------------------------------------- -->
      <div v-else class="ai-overlay__diff">
        <div v-if="sentBanner && !streamingError" class="ai-overlay__banner">
          {{ t('ai.sending', { provider: providerLabel }) }}
        </div>
        <div v-if="streamingError" class="ai-overlay__error">
          {{ streamingError }}
        </div>
        <div class="ai-overlay__columns">
          <div class="ai-overlay__col">
            <div class="ai-overlay__col-head">{{ t('ai.original') }}</div>
            <div class="ai-overlay__col-body ai-overlay__col-body--orig">
              {{ range?.selection }}
            </div>
          </div>
          <div class="ai-overlay__col">
            <div class="ai-overlay__col-head">{{ t('ai.proposed') }}</div>
            <div ref="proposedRef" class="ai-overlay__col-body ai-overlay__col-body--prop">
              <span v-if="proposed">{{ proposed }}</span>
              <span v-else-if="streaming" class="ai-overlay__placeholder">…</span>
              <span v-else class="ai-overlay__placeholder">{{ t('ai.empty') }}</span>
              <span v-if="streaming" class="ai-overlay__cursor">▌</span>
            </div>
          </div>
        </div>

        <div class="ai-overlay__buttons">
          <button class="ai-overlay__btn" @click="onReject">
            {{ t('ai.reject') }}
            <span class="ai-overlay__kbd">Esc</span>
          </button>
          <button
            class="ai-overlay__btn"
            :disabled="streaming"
            @click="onReroll"
          >
            {{ t('ai.reroll') }}
          </button>
          <button
            class="ai-overlay__btn ai-overlay__btn--primary"
            :disabled="streaming || !proposed || !!streamingError"
            @click="onAccept"
          >
            {{ t('ai.accept') }}
            <span class="ai-overlay__kbd">⌘↵</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-overlay__backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
  z-index: 1100;
  backdrop-filter: blur(3px);
}
.ai-overlay {
  background: var(--bg-elev);
  width: min(720px, 92vw);
  max-height: 76vh;
  border-radius: 12px;
  border: 1px solid var(--border);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ai-overlay__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.ai-overlay__title {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
}
.ai-overlay__close {
  background: transparent;
  border: none;
  font-size: 20px;
  color: var(--text-faint);
  cursor: pointer;
  padding: 0 6px;
  line-height: 1;
}
.ai-overlay__close:hover { color: var(--text); }

.ai-overlay__nokey {
  padding: 24px;
  text-align: center;
}
.ai-overlay__nokey p {
  color: var(--text-muted);
  font-size: 13px;
  margin: 0 0 14px;
}

.ai-overlay__picker {
  padding: 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.ai-overlay__action {
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}
.ai-overlay__action:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
}
.ai-overlay__action--active {
  border-color: var(--accent);
  background: var(--bg-hover);
}
.ai-overlay__custom {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
}
.ai-overlay__label {
  font-size: 11px;
  color: var(--text-muted);
}
.ai-overlay__textarea {
  width: 100%;
  resize: vertical;
  font: inherit;
  font-size: 12px;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
}

.ai-overlay__diff {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
  min-height: 0;
}
.ai-overlay__banner {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
}
.ai-overlay__error {
  font-size: 12px;
  color: #dc2626;
  background: rgba(220, 38, 38, 0.08);
  border: 1px solid rgba(220, 38, 38, 0.3);
  border-radius: 6px;
  padding: 8px 10px;
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-overlay__columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  flex: 1;
  min-height: 160px;
  overflow: hidden;
}
.ai-overlay__col {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  min-width: 0;
}
.ai-overlay__col-head {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.ai-overlay__col-body {
  flex: 1;
  overflow: auto;
  padding: 10px;
  font-family: var(--font-mono, monospace);
  font-size: 12.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.ai-overlay__col-body--orig {
  text-decoration: line-through;
  color: var(--text-muted);
}
.ai-overlay__col-body--prop {
  color: var(--text);
}
.ai-overlay__placeholder {
  color: var(--text-faint);
  font-style: italic;
}
.ai-overlay__cursor {
  display: inline-block;
  margin-left: 1px;
  animation: ai-overlay-blink 1s steps(2, start) infinite;
  color: var(--accent);
}
@keyframes ai-overlay-blink {
  to { visibility: hidden; }
}

.ai-overlay__buttons {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding-top: 4px;
}
.ai-overlay__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}
.ai-overlay__btn:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--bg-hover);
}
.ai-overlay__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ai-overlay__btn--primary {
  background: var(--accent, #6366f1);
  border-color: var(--accent, #6366f1);
  color: #fff;
}
.ai-overlay__btn--primary:hover:not(:disabled) {
  filter: brightness(1.05);
}
.ai-overlay__kbd {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  opacity: 0.75;
}
</style>
