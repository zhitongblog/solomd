<script setup lang="ts">
/**
 * v4.0 pillar 1 — Inline Agent Panel.
 *
 * Right-side first-class panel: chat-with-vault routed through the existing
 * 14-provider AI stack via the `ai_chat` Tauri command. This commit lights
 * up the multi-turn chat loop (input → streamed reply → history). MCP tool
 * calls, [[citation]] parsing, and per-run persistence land in subsequent
 * commits on `feat/v4-panel`.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useWorkspaceStore } from '../stores/workspace';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';
import { useAgentPanelStore } from '../stores/agentPanel';
import { providerById, type ProviderId } from '../lib/ai-providers';
import { useI18n } from '../i18n';

const emit = defineEmits<{
  (e: 'open-settings', section?: string): void;
}>();

const workspace = useWorkspaceStore();
const settings = useSettingsStore();
const tabs = useTabsStore();
const workspaceIndex = useWorkspaceIndexStore();
const agent = useAgentPanelStore();
const { t } = useI18n();

const draft = ref('');
const errorMsg = ref<string | null>(null);
const messagesRef = ref<HTMLUListElement | null>(null);
const inputRef = ref<HTMLTextAreaElement | null>(null);

/** Toggle: include the active note's content as additional context on each
 *  send. Persisted across sessions in localStorage. Off by default — costs
 *  tokens, and not every chat is about the active doc. */
const INCLUDE_ACTIVE_NOTE_KEY = 'solomd:agent-include-active-note';
const includeActiveNote = ref(false);
try {
  includeActiveNote.value = localStorage.getItem(INCLUDE_ACTIVE_NOTE_KEY) === '1';
} catch {
  /* localStorage unavailable — defaults to false */
}
watch(includeActiveNote, (v) => {
  try {
    localStorage.setItem(INCLUDE_ACTIVE_NOTE_KEY, v ? '1' : '0');
  } catch {
    /* best-effort */
  }
});

/** Per-message ceiling for active-note injection. 8 KB ≈ ~2k tokens, which
 *  keeps the prompt reasonable on small-context models. */
const ACTIVE_NOTE_CHAR_LIMIT = 8192;

/**
 * Default system prompt the panel injects before each chat. Kept generic
 * here; the next commit on `feat/v4-panel` adds vault-aware context (RAG
 * snippets + active note path) before the user's message.
 */
const SYSTEM_PROMPT =
  'You are a helpful writing and research assistant inside SoloMD, a local-first markdown editor. The user is chatting with you about their notes. Be concise and accurate. Use markdown formatting in replies when helpful. If the user asks about specific notes you have not been shown, ask which note they mean rather than fabricating content.';

/**
 * Build a workspace-context system message describing where the user is.
 * The agent gets vault path, active file, total note count — enough to
 * answer "what file am I editing?" without yet having tool calls. The next
 * commit on `feat/v4-panel` adds an explicit "include active note content"
 * toggle and the commit after that adds proper MCP tool calls.
 */
function buildVaultContext(): string {
  const folder = workspace.currentFolder;
  if (!folder) return '';
  const activeFile = tabs.activeTab?.filePath || '(no active file)';
  const noteCount = workspaceIndex.entries.length;
  const lines = [
    `User's vault is at: ${folder}`,
    `Active file: ${activeFile}`,
  ];
  if (noteCount > 0) {
    lines.push(`Workspace contains ${noteCount} indexed note${noteCount === 1 ? '' : 's'}.`);
  }
  return lines.join('\n');
}

/**
 * Active-note context block — opt-in via the panel header toggle. Returns an
 * empty string if the toggle is off, no folder is open, no active markdown
 * tab, or the tab is unsaved/empty. Truncates to ACTIVE_NOTE_CHAR_LIMIT to
 * keep prompts bounded.
 */
function buildActiveNoteContext(): string {
  if (!includeActiveNote.value) return '';
  const tab = tabs.activeTab;
  if (!tab || tab.language !== 'markdown') return '';
  const content = (tab.content || '').trim();
  if (!content) return '';
  const truncated =
    content.length > ACTIVE_NOTE_CHAR_LIMIT
      ? content.slice(0, ACTIVE_NOTE_CHAR_LIMIT) + '\n…(truncated)'
      : content;
  const path = tab.filePath || tab.fileName || '(untitled)';
  return `Active note content (${path}):\n\`\`\`markdown\n${truncated}\n\`\`\``;
}

const hasFolder = computed(() => !!workspace.currentFolder);
const aiConfigured = computed(() => settings.aiEnabled);

type StateKey = 'no-folder' | 'no-ai' | 'ready';
const stateKey = computed<StateKey>(() => {
  if (!hasFolder.value) return 'no-folder';
  if (!aiConfigured.value) return 'no-ai';
  return 'ready';
});

const canSend = computed(() => draft.value.trim().length > 0 && !agent.isStreaming);

function onOpenAiSettings() {
  emit('open-settings', 'integrations');
}

function autoscroll() {
  void nextTick(() => {
    const el = messagesRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

async function send() {
  const prompt = draft.value.trim();
  if (!prompt || agent.isStreaming) return;
  errorMsg.value = null;

  // Push user message + empty assistant placeholder. Chunks stream into the
  // placeholder via the `solomd://ai-chunk` listener below.
  agent.addMessage({ role: 'user', content: prompt });
  agent.addMessage({ role: 'assistant', content: '' });
  draft.value = '';
  autoscroll();

  const cfg = providerById(settings.aiProvider as ProviderId);
  const apiFormat = cfg?.apiFormat || 'openai';
  const model = settings.aiModel || cfg?.defaultModel || '';
  const baseUrl = settings.aiBaseUrl || cfg?.defaultBaseUrl || null;

  // Compose conversation: system + history (excluding the empty placeholder).
  const history = agent.messages
    .slice(0, -1)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  const ctx = buildVaultContext();
  const noteCtx = buildActiveNoteContext();
  const systemParts = [SYSTEM_PROMPT];
  if (ctx) systemParts.push(ctx);
  if (noteCtx) systemParts.push(noteCtx);
  const messages = [
    { role: 'system', content: systemParts.join('\n\n') },
    ...history,
  ];

  agent.isStreaming = true;
  try {
    const requestId = await invoke<string>('ai_chat', {
      request: {
        provider: settings.aiProvider,
        api_format: apiFormat,
        model,
        messages,
        base_url: baseUrl,
      },
    });
    agent.currentRunId = requestId;
  } catch (err) {
    agent.isStreaming = false;
    agent.currentRunId = null;
    errorMsg.value = String(err);
    // Drop the empty placeholder when the request never reached the wire.
    const last = agent.messages[agent.messages.length - 1];
    if (last && last.role === 'assistant' && last.content === '') {
      agent.messages.pop();
    }
  }
}

async function stop() {
  const id = agent.currentRunId;
  if (id) {
    try {
      await invoke('ai_cancel', { requestId: id });
    } catch {
      /* best-effort */
    }
  }
  agent.isStreaming = false;
  agent.currentRunId = null;
}

function onKeydown(e: KeyboardEvent) {
  // Enter sends; Shift+Enter inserts newline. Cmd/Ctrl+Enter also sends
  // (mirrors the AI rewrite overlay convention) for single-key power users.
  if (e.key === 'Enter') {
    const wantsSend = !e.shiftKey || e.metaKey || e.ctrlKey;
    if (wantsSend && canSend.value) {
      e.preventDefault();
      void send();
    }
  }
}

// --- Streaming event listeners ------------------------------------------
let unlistenChunk: UnlistenFn | null = null;
let unlistenDone: UnlistenFn | null = null;
let unlistenError: UnlistenFn | null = null;

onMounted(async () => {
  unlistenChunk = await listen<{ request_id: string; chunk: string }>(
    'solomd://ai-chunk',
    (e) => {
      if (!agent.currentRunId || e.payload.request_id !== agent.currentRunId) return;
      agent.appendToLastAssistant(e.payload.chunk);
      autoscroll();
    },
  );
  unlistenDone = await listen<{ request_id: string; full_text: string }>(
    'solomd://ai-done',
    (e) => {
      if (!agent.currentRunId || e.payload.request_id !== agent.currentRunId) return;
      agent.isStreaming = false;
      agent.currentRunId = null;
    },
  );
  unlistenError = await listen<{ request_id: string; error: string }>(
    'solomd://ai-error',
    (e) => {
      if (!agent.currentRunId || e.payload.request_id !== agent.currentRunId) return;
      agent.isStreaming = false;
      agent.currentRunId = null;
      if (e.payload.error !== 'cancelled') {
        errorMsg.value = e.payload.error;
      }
    },
  );
});

onBeforeUnmount(() => {
  unlistenChunk?.();
  unlistenDone?.();
  unlistenError?.();
  unlistenChunk = unlistenDone = unlistenError = null;
});

// Reset transient error when the panel falls out of `ready` state.
watch(stateKey, (k) => {
  if (k !== 'ready') errorMsg.value = null;
});
</script>

<template>
  <div class="agent-panel">
    <header class="agent-panel__head">
      <span class="agent-panel__title">{{ t('agent.heading') }}</span>
      <span class="agent-panel__beta">BETA</span>
      <span class="agent-panel__spacer" />
      <button
        v-if="stateKey === 'ready'"
        class="agent-panel__chip"
        :class="{ 'agent-panel__chip--on': includeActiveNote }"
        type="button"
        :title="t('agent.includeNoteTitle')"
        @click="includeActiveNote = !includeActiveNote"
      >
        <span class="agent-panel__chip-dot" :class="{ 'agent-panel__chip-dot--on': includeActiveNote }" />
        {{ t('agent.includeNote') }}
      </button>
      <button
        v-if="agent.messages.length"
        class="agent-panel__icon-btn"
        type="button"
        :title="t('agent.clearTitle')"
        @click="agent.clear()"
      >
        ×
      </button>
    </header>

    <div v-if="stateKey === 'no-folder'" class="agent-panel__empty">
      {{ t('agent.empty.noFolder') }}
    </div>

    <div v-else-if="stateKey === 'no-ai'" class="agent-panel__empty">
      <p>{{ t('agent.empty.noAi') }}</p>
      <button class="agent-panel__cta" type="button" @click="onOpenAiSettings">
        {{ t('agent.empty.configureAi') }}
      </button>
    </div>

    <template v-else>
      <ul ref="messagesRef" v-if="agent.messages.length" class="agent-panel__messages">
        <li
          v-for="(m, i) in agent.messages"
          :key="m.id"
          class="agent-panel__msg"
          :class="`agent-panel__msg--${m.role}`"
        >
          <div class="agent-panel__msg-role">{{ m.role }}</div>
          <div class="agent-panel__msg-body">
            <span>{{ m.content }}</span>
            <span
              v-if="m.role === 'assistant' && agent.isStreaming && i === agent.messages.length - 1"
              class="agent-panel__cursor"
              aria-hidden="true"
            >▌</span>
          </div>
        </li>
      </ul>
      <div v-else class="agent-panel__empty">
        {{ t('agent.empty.ready') }}
      </div>

      <div v-if="errorMsg" class="agent-panel__error">{{ errorMsg }}</div>

      <footer class="agent-panel__compose">
        <textarea
          ref="inputRef"
          v-model="draft"
          class="agent-panel__input"
          :placeholder="t('agent.placeholder')"
          rows="2"
          @keydown="onKeydown"
        ></textarea>
        <div class="agent-panel__compose-foot">
          <span class="agent-panel__compose-hint">
            <template v-if="agent.isStreaming">{{ t('agent.streaming') }}</template>
            <template v-else>{{ t('agent.enterToSend') }}</template>
          </span>
          <button
            v-if="agent.isStreaming"
            class="agent-panel__send agent-panel__send--stop"
            type="button"
            @click="stop"
          >
            {{ t('agent.stop') }}
          </button>
          <button
            v-else
            class="agent-panel__send"
            type="button"
            :disabled="!canSend"
            @click="send"
          >
            {{ t('agent.send') }}
          </button>
        </div>
      </footer>
    </template>
  </div>
</template>

<style scoped>
.agent-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  overflow: hidden;
}
.agent-panel__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
}
.agent-panel__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.agent-panel__beta {
  font-size: 9px;
  font-weight: 700;
  background: var(--accent, #ff9f40);
  color: white;
  padding: 1px 6px;
  border-radius: 4px;
  letter-spacing: 0.04em;
  line-height: 1.4;
}
.agent-panel__spacer {
  flex: 1;
}
.agent-panel__icon-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.agent-panel__icon-btn:hover {
  background: var(--bg-elev);
  color: var(--text);
}
.agent-panel__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-muted);
  font: inherit;
  font-size: 10px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 999px;
  cursor: pointer;
  letter-spacing: 0.02em;
}
.agent-panel__chip:hover {
  background: var(--bg-elev);
  color: var(--text);
}
.agent-panel__chip--on {
  background: rgba(255, 159, 64, 0.12);
  border-color: var(--accent, #ff9f40);
  color: var(--accent, #ff9f40);
}
.agent-panel__chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-faint, #888);
  flex-shrink: 0;
}
.agent-panel__chip-dot--on {
  background: var(--accent, #ff9f40);
}
.agent-panel__empty {
  padding: 20px 16px;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.6;
  text-align: center;
}
.agent-panel__empty p {
  margin: 0 0 8px 0;
}
.agent-panel__cta {
  margin-top: 4px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 12px;
  font: inherit;
  cursor: pointer;
}
.agent-panel__cta:hover {
  background: var(--bg-soft);
}
.agent-panel__messages {
  flex: 1;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0;
}
.agent-panel__msg {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.agent-panel__msg--assistant {
  background: var(--bg-soft);
}
.agent-panel__msg-role {
  font-size: 10px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}
.agent-panel__msg-body {
  font-size: 13px;
  color: var(--text);
  white-space: pre-wrap;
  line-height: 1.5;
  word-break: break-word;
}
.agent-panel__compose {
  border-top: 1px solid var(--border);
  background: var(--bg-soft);
  padding: 8px 10px;
}
.agent-panel__input {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  resize: none;
  outline: none;
  box-sizing: border-box;
}
.agent-panel__input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.agent-panel__compose-foot {
  margin-top: 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--text-muted);
}
.agent-panel__compose-hint {
  font-style: italic;
}
.agent-panel__send {
  background: var(--accent, #ff9f40);
  border: 1px solid var(--accent, #ff9f40);
  color: white;
  border-radius: 6px;
  padding: 4px 14px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  line-height: 1.4;
}
.agent-panel__send:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.agent-panel__send:hover:not(:disabled) {
  filter: brightness(1.05);
}
.agent-panel__send--stop {
  background: transparent;
  color: var(--text);
  border-color: var(--border);
}
.agent-panel__send--stop:hover {
  background: var(--bg-elev);
}
.agent-panel__cursor {
  display: inline-block;
  margin-left: 1px;
  color: var(--accent, #ff9f40);
  animation: agent-panel-blink 1s steps(2, start) infinite;
}
@keyframes agent-panel-blink {
  to { visibility: hidden; }
}
.agent-panel__error {
  margin: 0 12px 10px;
  padding: 8px 10px;
  font-size: 12px;
  color: #dc2626;
  background: rgba(220, 38, 38, 0.08);
  border: 1px solid rgba(220, 38, 38, 0.3);
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
