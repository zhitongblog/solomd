<script setup lang="ts">
/**
 * v4.0 pillar 1 — Inline Agent Panel.
 *
 * Right-side first-class panel: chat-with-vault routed through the existing
 * AI provider stack and (eventually) the MCP tool surface. This skeleton
 * commit ships the UI shell + empty/disabled states + Pinia store wiring.
 * AI streaming, MCP tool calls, citation parsing, and per-run persistence
 * land in subsequent commits on `feat/v4-panel`.
 */
import { computed } from 'vue';
import { useWorkspaceStore } from '../stores/workspace';
import { useSettingsStore } from '../stores/settings';
import { useAgentPanelStore } from '../stores/agentPanel';
import { useI18n } from '../i18n';

const emit = defineEmits<{
  (e: 'open-settings', section?: string): void;
}>();

const workspace = useWorkspaceStore();
const settings = useSettingsStore();
const agent = useAgentPanelStore();
const { t } = useI18n();

const hasFolder = computed(() => !!workspace.currentFolder);
const aiConfigured = computed(() => settings.aiEnabled);

type StateKey = 'no-folder' | 'no-ai' | 'ready';
const stateKey = computed<StateKey>(() => {
  if (!hasFolder.value) return 'no-folder';
  if (!aiConfigured.value) return 'no-ai';
  return 'ready';
});

function onOpenAiSettings() {
  emit('open-settings', 'integrations');
}
</script>

<template>
  <div class="agent-panel">
    <header class="agent-panel__head">
      <span class="agent-panel__title">{{ t('agent.heading') }}</span>
      <span class="agent-panel__beta">BETA</span>
      <span class="agent-panel__spacer" />
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
      <ul v-if="agent.messages.length" class="agent-panel__messages">
        <li
          v-for="m in agent.messages"
          :key="m.id"
          class="agent-panel__msg"
          :class="`agent-panel__msg--${m.role}`"
        >
          <div class="agent-panel__msg-role">{{ m.role }}</div>
          <div class="agent-panel__msg-body">{{ m.content }}</div>
        </li>
      </ul>
      <div v-else class="agent-panel__empty">
        {{ t('agent.empty.ready') }}
      </div>

      <footer class="agent-panel__compose">
        <textarea
          class="agent-panel__input"
          :placeholder="t('agent.placeholder')"
          rows="2"
          disabled
          aria-disabled="true"
        ></textarea>
        <div class="agent-panel__compose-foot">
          <span class="agent-panel__compose-hint">{{ t('agent.streamingComingSoon') }}</span>
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
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
}
</style>
