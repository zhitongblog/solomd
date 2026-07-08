import { defineStore } from 'pinia';

/**
 * v4.0 pillar 1 — Inline Agent Panel store.
 *
 * Holds the conversation state for the right-side Agent Panel. The first
 * commit on `feat/v4-panel` only had user/assistant text; this update adds
 * the tool-message variant for the tool-call cards and stashes the run_id
 * per run so the UI can deep-link into `<workspace>/.solomd/agent-runs/`.
 */

export type AgentMessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface AgentToolPayload {
  /** Tool name, e.g. `read_note`. */
  name: string;
  /** Args object the model sent. Rendered as JSON in the expanded card. */
  args: Record<string, unknown>;
  /** Result body — either the JSON-stringified tool return or the error
   *  message. Set after `solomd://ai-tool-result` arrives. */
  result?: string;
  /** Set when the dispatch failed; pairs with `result` to surface in red. */
  error?: string;
  /** UI-only flag — whether the inline card is expanded. Defaults false. */
  expanded?: boolean;
  /** Pairing key from the LLM payload — used to match tool-call → result. */
  toolCallId: string;
  /** Run id this tool belongs to (so jumping between runs works). */
  runId?: string;
}

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  content: string;
  /** Populated when `role === 'tool'`. */
  tool?: AgentToolPayload;
  createdAt: number;
}

interface AgentPanelState {
  messages: AgentMessage[];
  isStreaming: boolean;
  /** request_id mints by the Rust runner; used for cancellation / event
   *  matching. Renamed in spirit but kept the existing property name to
   *  avoid breaking the rest of the app. */
  currentRunId: string | null;
  /** Persistence run id minted by the Rust agent_run module — distinct
   *  from currentRunId (request_id). Stashed when
   *  `solomd://ai-run-started` fires so the UI can deep-link to
   *  `<workspace>/.solomd/agent-runs/<runId>/run.md`. */
  currentPersistRunId: string | null;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const useAgentPanelStore = defineStore('agentPanel', {
  state: (): AgentPanelState => ({
    messages: [],
    isStreaming: false,
    currentRunId: null,
    currentPersistRunId: null,
  }),
  actions: {
    addMessage(msg: Omit<AgentMessage, 'id' | 'createdAt'>): AgentMessage {
      const full: AgentMessage = {
        ...msg,
        id: newId(),
        createdAt: Date.now(),
      };
      this.messages.push(full);
      return full;
    },
    appendToLastAssistant(chunk: string) {
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === 'assistant') {
        last.content += chunk;
      }
    },
    /**
     * Insert a tool-call placeholder card immediately after the last
     * assistant placeholder. The result fills in once
     * `solomd://ai-tool-result` arrives. We then re-append a fresh
     * assistant placeholder so subsequent text deltas keep flowing into
     * a new bubble (matches the Anthropic / OpenAI pattern of multiple
     * assistant turns in one chat round).
     */
    insertToolCall(payload: { toolCallId: string; name: string; args: Record<string, unknown>; runId?: string }) {
      this.addMessage({
        role: 'tool',
        content: '',
        tool: {
          name: payload.name,
          args: payload.args,
          toolCallId: payload.toolCallId,
          runId: payload.runId,
          expanded: false,
        },
      });
      // Add a fresh empty assistant bubble so streaming text post-tool lands
      // in its own card, not concatenated to the pre-tool reasoning.
      this.addMessage({ role: 'assistant', content: '' });
    },
    /** Match a result event to the matching pending tool message by id. */
    completeToolCall(payload: { toolCallId: string; result?: string; error?: string }) {
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const m = this.messages[i];
        if (m.role === 'tool' && m.tool && m.tool.toolCallId === payload.toolCallId) {
          m.tool.result = payload.result;
          m.tool.error = payload.error;
          break;
        }
      }
    },
    /** Toggle the expand/collapse state for a tool card by id. */
    toggleToolExpand(toolCallId: string) {
      for (const m of this.messages) {
        if (m.role === 'tool' && m.tool && m.tool.toolCallId === toolCallId) {
          m.tool.expanded = !m.tool.expanded;
          return;
        }
      }
    },
    clear() {
      this.messages = [];
      this.currentRunId = null;
      this.currentPersistRunId = null;
      this.isStreaming = false;
    },
  },
});
