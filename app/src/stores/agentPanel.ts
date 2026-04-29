import { defineStore } from 'pinia';

/**
 * v4.0 pillar 1 — Inline Agent Panel store.
 *
 * Holds the conversation state for the right-side Agent Panel. Kept
 * deliberately small in this skeleton commit; subsequent commits on
 * `feat/v4-panel` add streaming routing, MCP tool calls, citations, and
 * persistence to `<workspace>/.solomd/agent-runs/<ts>.md`.
 */

export type AgentMessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  content: string;
  /** Populated when `role === 'tool'`. Surfaces in tool-call cards UI. */
  tool?: {
    name: string;
    args: Record<string, unknown>;
    result?: string;
  };
  createdAt: number;
}

interface AgentPanelState {
  messages: AgentMessage[];
  isStreaming: boolean;
  /** Run id used to namespace persistence + cancellation. Null when idle. */
  currentRunId: string | null;
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
    clear() {
      this.messages = [];
      this.currentRunId = null;
      this.isStreaming = false;
    },
  },
});
