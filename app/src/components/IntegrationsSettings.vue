<script setup lang="ts">
/**
 * IntegrationsSettings — v2.4 Settings → Integrations panel.
 *
 * Two cards:
 *   1. CLI (solomd)        — `which solomd` status + install one-liner
 *   2. MCP (solomd-mcp)    — bundled sidecar path + Claude Desktop config
 *
 * Designed to be embedded inline inside SettingsPanel.vue right under the
 * AI rewrite section (so users see CLI + MCP + AI as a related cluster of
 * "things SoloMD talks to").
 */

import { ref, computed, onMounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openPath, openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { useToastsStore } from '../stores/toasts';
import { useWorkspaceStore } from '../stores/workspace';
import { useSettingsStore } from '../stores/settings';
import { useI18n } from '../i18n';

const { t } = useI18n();
const toasts = useToastsStore();
const workspace = useWorkspaceStore();

// One-liner the user pastes in their terminal. Mirrors scripts/install-cli.sh.
const CLI_INSTALL_CMD =
  'curl -fsSL https://raw.githubusercontent.com/zhitongblog/solomd/main/scripts/install-cli.sh | bash';

const settings = useSettingsStore();
// Locale-aware so a Chinese-language SoloMD links to the Chinese docs.
const MCP_DOCS_URL = computed(() =>
  settings.language === 'zh'
    ? 'https://solomd.app/zh/docs/mcp/'
    : 'https://solomd.app/docs/mcp/',
);
const CLI_DOCS_URL = computed(() =>
  settings.language === 'zh'
    ? 'https://solomd.app/zh/docs/cli/'
    : 'https://solomd.app/docs/cli/',
);

// ---------------------------------------------------------------------------
// Backend state
// ---------------------------------------------------------------------------

interface CliStatus {
  installed: boolean;
  path?: string | null;
  version?: string | null;
}

interface McpPath {
  path: string | null;
  bundled: boolean;
}

const cli = ref<CliStatus>({ installed: false });
const mcp = ref<McpPath>({ path: null, bundled: false });
const claudeConfigPath = ref<string | null>(null);

async function refreshAll() {
  try {
    cli.value = await invoke<CliStatus>('cli_status');
  } catch (e) {
    cli.value = { installed: false };
  }
  try {
    mcp.value = await invoke<McpPath>('mcp_path');
  } catch (e) {
    mcp.value = { path: null, bundled: false };
  }
  try {
    claudeConfigPath.value = await invoke<string | null>(
      'mcp_claude_desktop_config_path'
    );
  } catch {
    claudeConfigPath.value = null;
  }
}

onMounted(refreshAll);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function copyInstallCmd() {
  await writeText(CLI_INSTALL_CMD);
  toasts.success(t('integrations.cliCopiedToast'));
}

async function showInstall() {
  // We don't run sudo from the GUI. Toast the command + copy it for them.
  await writeText(CLI_INSTALL_CMD);
  toasts.info(t('integrations.cliInstallToast') + '  ' + CLI_INSTALL_CMD);
}

// ---------------------------------------------------------------------------
// MCP — Claude Desktop config block
// ---------------------------------------------------------------------------

const claudeConfigJson = computed(() => {
  // Build the exact JSON we'd want the user to drop into their config.
  // We always emit the `solomd-vault` server key with the bundled binary
  // path + the user's currently-open workspace folder. If either is
  // missing (no workspace, dev build) we fall back to a sensible
  // placeholder + comment.
  const command = mcp.value.path ?? '/path/to/solomd-mcp';
  const ws = workspace.currentFolder ?? '/path/to/your/notes';

  const config = {
    mcpServers: {
      'solomd-vault': {
        command,
        args: ['--workspace', ws],
      },
    },
  };
  return JSON.stringify(config, null, 2);
});

async function copyMcpConfig() {
  await writeText(claudeConfigJson.value);
  if (!workspace.currentFolder) {
    toasts.info(t('integrations.mcpNoWorkspace'));
  } else {
    toasts.success(t('integrations.mcpCopiedToast'));
  }
}

async function openClaudeConfigFile() {
  if (!claudeConfigPath.value) return;
  try {
    await openPath(claudeConfigPath.value);
  } catch (e) {
    // File may not exist yet — reveal the parent folder so the user can
    // create it, or fall back to surfacing the path in a toast.
    try {
      await revealItemInDir(claudeConfigPath.value);
    } catch {
      toasts.info(claudeConfigPath.value);
    }
  }
}

async function openMcpDocs() {
  try {
    await openUrl(MCP_DOCS_URL.value);
  } catch (e) {
    toasts.error(String(e));
  }
}

async function openCliDocs() {
  try {
    await openUrl(CLI_DOCS_URL.value);
  } catch (e) {
    toasts.error(String(e));
  }
}

// ---------------------------------------------------------------------------
// Static lists (kept here so the template can `v-for` over a typed array
// rather than `Object.keys(t(...))` which is awkward in Vue templates).
// ---------------------------------------------------------------------------
const cliSubKeys = ['open', 'new', 'list', 'search', 'cat', 'help'] as const;
const mcpToolKeys = [
  'list_notes',
  'read_note',
  'search',
  'get_backlinks',
  'list_tags',
  'get_outline',
  'write_note',
  'append_to_note',
] as const;
</script>

<template>
  <section class="integrations">
    <h3 class="integrations__heading">{{ t('integrations.heading') }}</h3>
    <p class="integrations__intro">{{ t('integrations.intro') }}</p>

    <!-- ────────────────────────────────────────────────────────────── -->
    <!-- CLI sub-card                                                    -->
    <!-- ────────────────────────────────────────────────────────────── -->
    <div class="ic-card" data-testid="integrations-cli">
      <div class="ic-card__title">{{ t('integrations.cliTitle') }}</div>

      <div class="ic-status">
        <span
          class="ic-dot"
          :class="cli.installed ? 'ic-dot--ok' : 'ic-dot--off'"
        ></span>
        <span v-if="cli.installed">
          {{ t('integrations.cliInstalled', { path: cli.path || '' }) }}
        </span>
        <span v-else class="ic-status--off">
          {{ t('integrations.cliNotInstalled') }}
        </span>
      </div>
      <div v-if="cli.version" class="ic-version">
        {{ t('integrations.cliVersionLabel') }}: {{ cli.version }}
      </div>

      <div class="ic-row">
        <button class="ic-btn" @click="showInstall">
          {{ t('integrations.cliInstallBtn') }}
        </button>
        <button class="ic-btn" @click="copyInstallCmd">
          {{ t('integrations.cliCopyInstallBtn') }}
        </button>
        <button class="ic-btn" @click="openCliDocs">
          {{ t('integrations.cliDocsBtn') }}
        </button>
      </div>

      <details class="ic-details">
        <summary>{{ t('integrations.cliSubcommandsHeading') }}</summary>
        <ul class="ic-list">
          <li v-for="k in cliSubKeys" :key="k">
            <code>solomd {{ k }}</code> —
            {{ t(`integrations.cliSubcommands.${k}`) }}
          </li>
        </ul>
      </details>
    </div>

    <!-- ────────────────────────────────────────────────────────────── -->
    <!-- MCP sub-card                                                    -->
    <!-- ────────────────────────────────────────────────────────────── -->
    <div class="ic-card" data-testid="integrations-mcp">
      <div class="ic-card__title">{{ t('integrations.mcpTitle') }}</div>

      <div class="ic-status">
        <span
          class="ic-dot"
          :class="mcp.bundled ? 'ic-dot--ok' : 'ic-dot--off'"
        ></span>
        <span v-if="mcp.bundled">
          {{ t('integrations.mcpBundled', { path: mcp.path || '' }) }}
        </span>
        <span v-else class="ic-status--off">
          {{ t('integrations.mcpNotBundled') }}
        </span>
      </div>
      <p class="ic-desc">{{ t('integrations.mcpDesc') }}</p>

      <div class="ic-config-heading">
        {{ t('integrations.mcpClaudeConfigHeading') }}
      </div>
      <p class="ic-config-hint">{{ t('integrations.mcpClaudeConfigHint') }}</p>

      <pre
        class="ic-config-block"
        @click="copyMcpConfig"
        :title="t('integrations.mcpCopyConfigBtn')"
      >{{ claudeConfigJson }}</pre>

      <div class="ic-row">
        <button class="ic-btn" @click="copyMcpConfig">
          {{ t('integrations.mcpCopyConfigBtn') }}
        </button>
        <button
          class="ic-btn"
          :disabled="!claudeConfigPath"
          @click="openClaudeConfigFile"
        >
          {{ t('integrations.mcpOpenConfigBtn') }}
        </button>
        <button class="ic-btn" @click="openMcpDocs">
          {{ t('integrations.mcpHowBtn') }}
        </button>
      </div>

      <details class="ic-details">
        <summary>{{ t('integrations.mcpToolsHeading') }}</summary>
        <ul class="ic-list">
          <li v-for="k in mcpToolKeys" :key="k">
            <code>{{ k }}</code> —
            {{ t(`integrations.mcpTools.${k}`) }}
          </li>
        </ul>
        <p class="ic-write-note">
          {{ t('integrations.mcpWriteNote') }}
        </p>
      </details>
    </div>
  </section>
</template>

<style scoped>
.integrations {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.integrations__heading {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin: 18px 0 0;
}
.integrations__intro {
  font-size: 11px;
  color: var(--text-faint);
  margin: 0 0 4px;
  line-height: 1.5;
}
.ic-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ic-card__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.ic-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
  word-break: break-all;
}
.ic-status--off {
  color: var(--text-faint);
}
.ic-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}
.ic-dot--ok {
  background: #22c55e;
}
.ic-dot--off {
  background: var(--text-faint);
  opacity: 0.4;
}
.ic-version {
  font-size: 11px;
  color: var(--text-faint);
  margin-left: 14px;
}
.ic-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 2px;
}
.ic-btn {
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  padding: 5px 10px;
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
}
.ic-btn:hover:not(:disabled) {
  background: var(--bg-active, var(--bg-elev));
}
.ic-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ic-desc {
  font-size: 11px;
  color: var(--text-faint);
  margin: 2px 0;
  line-height: 1.5;
}
.ic-config-heading {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  margin-top: 4px;
}
.ic-config-hint {
  font-size: 11px;
  color: var(--text-faint);
  margin: 0;
  line-height: 1.5;
}
.ic-config-block {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 10px;
  font-family: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--text);
  overflow-x: auto;
  margin: 0;
  cursor: copy;
  white-space: pre;
  line-height: 1.5;
}
.ic-config-block:hover {
  border-color: var(--accent);
}
.ic-details {
  margin-top: 4px;
}
.ic-details summary {
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}
.ic-details summary:hover {
  color: var(--text);
}
.ic-list {
  list-style: none;
  padding: 6px 0 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ic-list li {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}
.ic-list code {
  background: var(--bg-elev);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  color: var(--text);
}
.ic-write-note {
  font-size: 10px;
  color: var(--text-faint);
  margin: 6px 0 0;
  line-height: 1.5;
}
</style>
