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
import { useTilesStore } from '../stores/tiles';
import { useToastsStore } from '../stores/toasts';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';
import { useAgentPanelStore } from '../stores/agentPanel';
import { providerById, type ProviderId } from '../lib/ai-providers';
import { parseWithWikilinks, chipLabel } from '../lib/wikilinks';
import { useFiles } from '../composables/useFiles';
import { useI18n } from '../i18n';
import '../styles/panels.css';
import Icons from './Icons.vue';

const emit = defineEmits<{
  (e: 'open-settings', section?: string): void;
  (e: 'close'): void;
}>();

const workspace = useWorkspaceStore();
const settings = useSettingsStore();
const tabs = useTabsStore();
const tiles = useTilesStore();
const toasts = useToastsStore();
const workspaceIndex = useWorkspaceIndexStore();
const agent = useAgentPanelStore();
const files = useFiles();
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

/** Whether the Insert button on an assistant message can do anything —
 *  there must be a focused editor pane and an active markdown tab in it.
 *  Used to grey out the button when the user is on the file tree, in
 *  Settings, or has no note open. */
const canInsertIntoEditor = computed(() => {
  if (!tiles.focusedPaneId) return false;
  return !!tabs.activeTab;
});

/** Copy a finished assistant reply to the clipboard. */
async function copyAssistantMessage(content: string) {
  if (!content) return;
  try {
    await navigator.clipboard.writeText(content);
    toasts.success(t('agent.msgCopied'));
  } catch (e) {
    toasts.error(`copy failed: ${e}`);
  }
}

/** Insert a finished assistant reply into the focused editor pane.
 *  Reuses the existing `solomd:insert-markdown` event that PaneContent
 *  already listens for — replaces the current selection if any, else
 *  inserts at the cursor; the caret lands at the end of the inserted
 *  text. */
function insertAssistantMessage(content: string) {
  if (!content) return;
  const paneId = tiles.focusedPaneId;
  if (!paneId || !tabs.activeTab) {
    toasts.warning(t('agent.msgInsertNoEditor'));
    return;
  }
  window.dispatchEvent(
    new CustomEvent('solomd:insert-markdown', {
      detail: { snippet: content, paneId },
    }),
  );
  toasts.success(t('agent.msgInserted'));
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

  // Generate the request id on the frontend so we can wire `currentRunId`
  // BEFORE invoking the command. Closes a race where a fast backend
  // failure (ollama 404 on a missing model) emits `ai-error` before the
  // `await invoke(...)` resolves — without a pre-set `currentRunId`, the
  // error listener's id-match check drops the event and the panel hangs
  // on "生成回复中…" with the Stop button stuck on.
  const requestId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  agent.currentRunId = requestId;
  agent.isStreaming = true;
  try {
    await invoke<string>('ai_chat', {
      request: {
        provider: settings.aiProvider,
        api_format: apiFormat,
        model,
        messages,
        base_url: baseUrl,
        // v4.0 — let the model decide which tools to call. The Rust side
        // passes `null` ⇒ all read-only tools by default; write tools
        // need explicit `allow_write: true`.
        tools: null,
        allow_write: settings.agentAllowWrite,
        tool_loop_cap: settings.agentToolLoopCap,
        workspace: workspace.currentFolder,
        request_id: requestId,
      },
    });
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
  // CJK / IME guard: while the user is mid-composition (e.g. typing
  // pinyin then pressing Enter to commit a candidate), `e.isComposing`
  // is true and the Enter belongs to the IME, not to us. Some older
  // engines emit `keyCode === 229` instead. Either way, never treat
  // a composition-Enter as "send" — the message would fly out before
  // the candidate is even inserted into the textarea.
  if (e.isComposing || e.keyCode === 229) return;
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
let unlistenToolCall: UnlistenFn | null = null;
let unlistenToolResult: UnlistenFn | null = null;
let unlistenRunStarted: UnlistenFn | null = null;

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
      // Drop any trailing empty assistant bubble (happens when the final
      // turn was just text we already streamed but the loop appended an
      // extra placeholder for a tool result that never came).
      const last = agent.messages[agent.messages.length - 1];
      if (last && last.role === 'assistant' && last.content === '') {
        agent.messages.pop();
      }
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
      // Drop the empty assistant placeholder so the error banner sits
      // where the bubble would have been, instead of an empty bubble +
      // a banner below it.
      const last = agent.messages[agent.messages.length - 1];
      if (last && last.role === 'assistant' && last.content === '') {
        agent.messages.pop();
      }
      if (e.payload.error !== 'cancelled') {
        errorMsg.value = e.payload.error;
      }
    },
  );

  // v4.0 — tool-call events. Insert a `tool` placeholder card on call,
  // fill the result when it lands.
  unlistenToolCall = await listen<{
    request_id: string;
    run_id: string;
    tool_call_id: string;
    tool: string;
    args: Record<string, unknown>;
  }>('solomd://ai-tool-call', (e) => {
    if (!agent.currentRunId || e.payload.request_id !== agent.currentRunId) return;
    agent.insertToolCall({
      toolCallId: e.payload.tool_call_id,
      name: e.payload.tool,
      args: e.payload.args,
      runId: e.payload.run_id,
    });
    autoscroll();
  });
  unlistenToolResult = await listen<{
    request_id: string;
    run_id: string;
    tool_call_id: string;
    result: unknown;
    error?: string;
  }>('solomd://ai-tool-result', (e) => {
    if (!agent.currentRunId || e.payload.request_id !== agent.currentRunId) return;
    let resultStr: string;
    try {
      resultStr =
        typeof e.payload.result === 'string'
          ? e.payload.result
          : JSON.stringify(e.payload.result, null, 2);
    } catch {
      resultStr = String(e.payload.result);
    }
    agent.completeToolCall({
      toolCallId: e.payload.tool_call_id,
      result: resultStr,
      error: e.payload.error,
    });
    autoscroll();
  });
  unlistenRunStarted = await listen<{ request_id: string; run_id: string }>(
    'solomd://ai-run-started',
    (e) => {
      if (!agent.currentRunId || e.payload.request_id !== agent.currentRunId) return;
      agent.currentPersistRunId = e.payload.run_id;
    },
  );
});

onBeforeUnmount(() => {
  unlistenChunk?.();
  unlistenDone?.();
  unlistenError?.();
  unlistenToolCall?.();
  unlistenToolResult?.();
  unlistenRunStarted?.();
  unlistenChunk = unlistenDone = unlistenError = null;
  unlistenToolCall = unlistenToolResult = unlistenRunStarted = null;
});

// --- Wikilink handling --------------------------------------------------
function renderRuns(text: string) {
  return parseWithWikilinks(text);
}

async function openWikilink(target: string, heading?: string) {
  // Resolve via the workspace index (Rust-backed). The store's `resolve()`
  // does stem → title → substring fallback so partial matches still open.
  // LLMs frequently emit `[[name.md]]` even though the canonical wikilink
  // form is bare-stem; strip a trailing `.md`/`.markdown`/`.mdown` so the
  // resolver's stem index hits.
  if (!target) return;
  const cleaned = target.replace(/\.(md|markdown|mdown)$/i, '');
  const path = await workspaceIndex.resolve(cleaned);
  if (!path) {
    errorMsg.value = `Could not resolve [[${target}]] in this workspace`;
    return;
  }
  await files.openPath(path, { bypassNewWindow: true });
  // Heading anchors are captured but not jumped to yet — `Editor.vue`
  // doesn't expose a scroll-to-heading API. Reserved for follow-up.
  void heading;
}

function chip(link: { target: string; heading?: string; alias?: string }) {
  return chipLabel(link as any);
}

/**
 * Compact one-line summary of an args object for the collapsed card head.
 * Strings are rendered with quotes; longer values are abbreviated.
 */
function formatArgsInline(args: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    let repr: string;
    if (typeof v === 'string') {
      const trimmed = v.length > 60 ? v.slice(0, 57) + '…' : v;
      repr = JSON.stringify(trimmed);
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      repr = String(v);
    } else {
      try {
        const s = JSON.stringify(v);
        repr = s.length > 40 ? s.slice(0, 37) + '…' : s;
      } catch {
        repr = '…';
      }
    }
    parts.push(`${k}: ${repr}`);
  }
  let line = parts.join(', ');
  if (line.length > 96) line = line.slice(0, 93) + '…';
  return line;
}

// Reset transient error when the panel falls out of `ready` state.
watch(stateKey, (k) => {
  if (k !== 'ready') errorMsg.value = null;
});
</script>

<template>
  <div class="agent-panel rp">
    <header class="rp-head agent-panel__head">
      <span class="rp-title agent-panel__title">{{ t('agent.heading') }}</span>
      <span class="agent-panel__beta">Beta</span>
      <span class="agent-panel__spacer" />
      <button
        v-if="stateKey === 'ready'"
        class="rp-chip agent-panel__chip"
        :class="{ 'is-active agent-panel__chip--on': includeActiveNote }"
        type="button"
        :title="t('agent.includeNoteTitle')"
        :aria-pressed="includeActiveNote"
        @click="includeActiveNote = !includeActiveNote"
      >
        <span class="agent-panel__chip-dot" :class="{ 'agent-panel__chip-dot--on': includeActiveNote }" />
        {{ t('agent.includeNote') }}
      </button>
      <button
        v-if="agent.messages.length"
        class="rp-icon-btn agent-panel__icon-btn"
        type="button"
        :title="t('agent.clearTitle')"
        :aria-label="t('agent.clearTitle')"
        @click="agent.clear()"
      >
        <Icons name="trash" :size="14" />
      </button>
      <button
        class="rp-icon-btn"
        type="button"
        :title="t('rightSidebar.hidePane')"
        :aria-label="t('rightSidebar.hidePane')"
        @click="emit('close')"
      >
        <Icons name="close" :size="14" />
      </button>
    </header>

    <div v-if="stateKey === 'no-folder'" class="rp-empty agent-panel__empty">
      {{ t('agent.empty.noFolder') }}
    </div>

    <div v-else-if="stateKey === 'no-ai'" class="rp-empty agent-panel__empty">
      <p>{{ t('agent.empty.noAi') }}</p>
      <button class="rp-btn agent-panel__cta" type="button" @click="onOpenAiSettings">
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
          <!-- Tool-call card: collapsed by default. Click to expand args + result. -->
          <div v-if="m.role === 'tool' && m.tool" class="agent-panel__tool">
            <button
              class="agent-panel__tool-head"
              :class="{ 'agent-panel__tool-head--err': !!m.tool.error, 'agent-panel__tool-head--pending': !m.tool.result && !m.tool.error }"
              type="button"
              :aria-expanded="!!m.tool.expanded"
              @click="agent.toggleToolExpand(m.tool.toolCallId)"
            >
              <span class="agent-panel__tool-icon" aria-hidden="true">
                <span v-if="!m.tool.result && !m.tool.error" class="agent-panel__tool-spinner" />
                <Icons v-else-if="m.tool.error" name="info" :size="14" />
                <Icons v-else name="wrench" :size="14" />
              </span>
              <code class="agent-panel__tool-sig">{{ m.tool.name }}({{ formatArgsInline(m.tool.args) }})</code>
              <Icons
                class="agent-panel__tool-caret"
                :name="m.tool.expanded ? 'chevron-down' : 'chevron-right'"
                :size="12"
              />
            </button>
            <div v-if="m.tool.expanded" class="agent-panel__tool-body">
              <div class="agent-panel__tool-section">
                <div class="agent-panel__tool-label">args</div>
                <pre class="agent-panel__tool-pre">{{ JSON.stringify(m.tool.args, null, 2) }}</pre>
              </div>
              <div class="agent-panel__tool-section">
                <div class="agent-panel__tool-label">{{ m.tool.error ? 'error' : 'result' }}</div>
                <pre
                  class="agent-panel__tool-pre"
                  :class="{ 'agent-panel__tool-pre--err': !!m.tool.error }"
                >{{ m.tool.error || m.tool.result || '(waiting…)' }}</pre>
              </div>
            </div>
          </div>

          <!-- User / assistant / system text. Assistant text gets wikilink chips. -->
          <template v-else>
            <div class="agent-panel__msg-role">{{ m.role }}</div>
            <div class="agent-panel__msg-body">
              <template v-if="m.role === 'assistant'">
                <template v-for="(run, ri) in renderRuns(m.content)" :key="ri">
                  <button
                    v-if="run.type === 'wikilink'"
                    class="agent-panel__wiki"
                    type="button"
                    :title="run.heading ? `${run.target}#${run.heading}` : run.target"
                    @click="openWikilink(run.target, run.heading)"
                  ><Icons class="agent-panel__wiki-icon" name="link" :size="11" />{{ chip(run) }}</button>
                  <span v-else>{{ run.value }}</span>
                </template>
              </template>
              <span v-else>{{ m.content }}</span>
              <span
                v-if="m.role === 'assistant' && agent.isStreaming && i === agent.messages.length - 1"
                class="agent-panel__cursor"
                aria-hidden="true"
              >▌</span>
            </div>
            <!-- v4.0: actions on completed assistant replies. The bridge
                 between "agent wrote something" and "actually editing the
                 doc" — without this the panel is just a chat tab next to
                 the editor. Hidden while the message is still streaming
                 (would copy/insert a half-finished reply) and on user
                 messages (no point copying your own prompt). -->
            <div
              v-if="m.role === 'assistant' && m.content
                && !(agent.isStreaming && i === agent.messages.length - 1)"
              class="agent-panel__msg-actions"
            >
              <button
                class="rp-btn rp-btn--sm rp-btn--ghost agent-panel__msg-action"
                type="button"
                :title="t('agent.msgCopyTitle')"
                @click="copyAssistantMessage(m.content)"
              >{{ t('agent.msgCopy') }}</button>
              <button
                class="rp-btn rp-btn--sm rp-btn--ghost agent-panel__msg-action"
                type="button"
                :disabled="!canInsertIntoEditor"
                :title="canInsertIntoEditor ? t('agent.msgInsertTitle') : t('agent.msgInsertNoEditor')"
                @click="insertAssistantMessage(m.content)"
              >{{ t('agent.msgInsert') }}</button>
            </div>
          </template>
        </li>
      </ul>
      <div v-else class="rp-empty agent-panel__empty">
        {{ t('agent.empty.ready') }}
      </div>

      <div v-if="errorMsg" class="agent-panel__error">{{ errorMsg }}</div>

      <footer class="agent-panel__compose">
        <textarea
          ref="inputRef"
          v-model="draft"
          class="rp-textarea agent-panel__input"
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
            class="rp-btn agent-panel__send agent-panel__send--stop"
            type="button"
            @click="stop"
          >
            {{ t('agent.stop') }}
          </button>
          <button
            v-else
            class="rp-btn rp-btn--primary agent-panel__send"
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
.agent-panel__title {
  flex: 0 1 auto;
}
.agent-panel__beta {
  flex: 0 0 auto;
  margin-left: 6px;
  height: 18px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  border-radius: var(--r-full);
  background: var(--fill-1);
  color: var(--text-3);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  user-select: none;
  -webkit-user-select: none;
}
.agent-panel__spacer {
  flex: 1 1 auto;
}
.agent-panel__chip {
  margin-right: 2px;
}
.agent-panel__chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
  opacity: 0.6;
  flex-shrink: 0;
}
.agent-panel__chip-dot--on {
  background: var(--accent);
  opacity: 1;
}
.agent-panel__empty p {
  margin: 0;
}

/* --- Messages ------------------------------------------------------------ */
.agent-panel__messages {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 4px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.agent-panel__msg {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
/* The bubble shape already says who is speaking; the role label stays only
   for system notes, where it carries information. */
.agent-panel__msg-role {
  display: none;
}
.agent-panel__msg--system .agent-panel__msg-role {
  display: block;
  margin-bottom: 2px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-3);
}
.agent-panel__msg-body {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.agent-panel__msg--user {
  align-items: flex-end;
}
.agent-panel__msg--user .agent-panel__msg-body {
  max-width: 88%;
  padding: 7px 11px;
  border-radius: var(--r-lg);
  background: var(--fill-1);
  line-height: 1.5;
}
.agent-panel__msg--system .agent-panel__msg-body {
  font-size: 12px;
  color: var(--text-3);
}
.agent-panel__cursor {
  display: inline-block;
  margin-left: 1px;
  color: var(--accent);
  animation: agent-panel-blink 1s steps(2, start) infinite;
}
@keyframes agent-panel-blink {
  to { visibility: hidden; }
}

/* --- Tool-call cards ----------------------------------------------------- */
.agent-panel__tool {
  border: var(--bd-hair);
  border-radius: var(--r-lg);
  background: var(--bg-elev);
  overflow: hidden;
}
.agent-panel__tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 30px;
  padding: 0 10px;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 12px;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.agent-panel__tool-head:hover {
  background: var(--fill-1);
}
.agent-panel__tool-head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent-ring);
}
.agent-panel__tool-head--err .agent-panel__tool-icon {
  color: var(--danger);
}
.agent-panel__tool-head--pending {
  color: var(--text-3);
}
.agent-panel__tool-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--text-3);
}
.agent-panel__tool-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--fill-2);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: agent-panel-spin 0.8s linear infinite;
}
@keyframes agent-panel-spin {
  to { transform: rotate(360deg); }
}
.agent-panel__tool-sig {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agent-panel__tool-caret {
  flex-shrink: 0;
  color: var(--text-3);
}
.agent-panel__tool-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px 10px 10px;
}
.agent-panel__tool-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.agent-panel__tool-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-3);
}
.agent-panel__tool-pre {
  margin: 0;
  padding: 6px 8px;
  background: var(--bg);
  border: var(--bd-hair);
  border-radius: var(--r-sm);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}
.agent-panel__tool-pre--err {
  color: var(--danger);
}

/* --- Per-assistant-reply actions (Copy / Insert) ------------------------- */
.agent-panel__msg-actions {
  display: flex;
  gap: 2px;
  margin-top: 4px;
  margin-left: -8px;
}
.agent-panel__msg-action {
  color: var(--text-3);
}

/* --- Wikilink chips ------------------------------------------------------ */
.agent-panel__wiki {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin: 0 1px;
  padding: 0 7px;
  height: 20px;
  vertical-align: 1px;
  border: 0;
  border-radius: var(--r-full);
  background: var(--accent-soft);
  color: var(--accent-text);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.agent-panel__wiki:hover {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}
.agent-panel__wiki:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.agent-panel__wiki-icon {
  opacity: 0.8;
}

.agent-panel__error {
  margin: 0 12px 8px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  border-radius: var(--r-md);
  white-space: pre-wrap;
  word-break: break-word;
}

/* --- Compose ------------------------------------------------------------- */
.agent-panel__compose {
  flex: 0 0 auto;
  padding: 10px 12px 12px;
  border-top: var(--bd-hair);
}
.agent-panel__input {
  min-height: 56px;
  max-height: 200px;
  resize: none;
}
.agent-panel__input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.agent-panel__compose-foot {
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.agent-panel__compose-hint {
  min-width: 0;
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agent-panel__send {
  flex-shrink: 0;
}
</style>
