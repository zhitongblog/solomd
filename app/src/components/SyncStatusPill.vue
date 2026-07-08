<script setup lang="ts">
/**
 * v3.0 SyncStatusPill — status-bar quick action for GitHub sync.
 *
 * Hidden when the current workspace isn't linked. When it is, condenses
 * the SyncStatus payload into a single glyph + click action:
 *
 *   ☁️ ✓        up to date, clean         → click: "already up to date" toast
 *   ☁️ ↑N      N commits ahead             → click: push
 *   ☁️ ↓N      N commits behind            → click: pull
 *   ☁️ ↑N ↓M   diverged (rare)             → click: pull first
 *   ☁️ ●        clean local but uncommitted → click: AutoGit nudge
 *   ☁️ ↻        operation in flight        → click ignored
 *   ☁️ ⚠N       conflicts pending          → click: open History panel
 *
 * Hover surfaces last-push / last-pull / remote URL in a tooltip.
 */
import { computed } from 'vue';
import { useGithubSyncStore } from '../stores/githubSync';
import { useGithubSync } from '../composables/useGithubSync';
import { useWorkspaceStore } from '../stores/workspace';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

const sync = useGithubSyncStore();
const ops = useGithubSync();
const workspace = useWorkspaceStore();
const toasts = useToastsStore();
const { t } = useI18n();

const status = computed(() => sync.status);
const visible = computed(() => Boolean(status.value?.linked));

interface Mode {
  /** Glyph rendered after the cloud icon. Falls back to ✓ when nothing
   *  needs the user's attention. */
  glyph: string;
  /** ARIA label / tooltip subject — short. */
  label: string;
  /** What clicking does. */
  action: 'push' | 'pull' | 'noop' | 'open-conflicts' | 'busy';
  /** Visual emphasis: warn for conflicts, info for ahead/behind, faint for clean. */
  tone: 'ok' | 'warn' | 'err' | 'busy';
}

const mode = computed<Mode>(() => {
  const s = status.value;
  if (!s) return { glyph: '·', label: '', action: 'noop', tone: 'ok' };
  if (sync.pushing || sync.pulling) {
    return { glyph: '↻', label: t('githubSync.pillBusy') || 'Syncing…', action: 'busy', tone: 'busy' };
  }
  if (s.has_conflicts) {
    return {
      glyph: `⚠${s.conflicts.length}`,
      label: t('githubSync.pillConflicts', { n: String(s.conflicts.length) }) || `${s.conflicts.length} conflict(s) — click to resolve`,
      action: 'open-conflicts',
      tone: 'err',
    };
  }
  if (s.behind > 0) {
    return {
      glyph: `↓${s.behind}`,
      label: t('githubSync.pillBehind', { n: String(s.behind) }) || `${s.behind} to pull — click to pull now`,
      action: 'pull',
      tone: 'warn',
    };
  }
  if (s.ahead > 0) {
    return {
      glyph: `↑${s.ahead}`,
      label: t('githubSync.pillAhead', { n: String(s.ahead) }) || `${s.ahead} to push — click to push now`,
      action: 'push',
      tone: 'warn',
    };
  }
  if (s.dirty) {
    return {
      glyph: '●',
      label: t('githubSync.pillDirty') || 'Uncommitted local changes — save with ⌘S',
      action: 'noop',
      tone: 'warn',
    };
  }
  return { glyph: '✓', label: t('githubSync.pillClean') || 'In sync with GitHub', action: 'noop', tone: 'ok' };
});

function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return t('githubSync.never') || 'never';
  const dt = Date.now() / 1000 - ts;
  if (dt < 60) return t('githubSync.agoSec', { n: String(Math.floor(dt)) }) || `${Math.floor(dt)}s ago`;
  if (dt < 3600) return t('githubSync.agoMin', { n: String(Math.floor(dt / 60)) }) || `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400) return t('githubSync.agoHour', { n: String(Math.floor(dt / 3600)) }) || `${Math.floor(dt / 3600)}h ago`;
  return t('githubSync.agoDay', { n: String(Math.floor(dt / 86400)) }) || `${Math.floor(dt / 86400)}d ago`;
}

const tooltip = computed(() => {
  const s = status.value;
  if (!s) return '';
  const repo = s.remote_url
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '');
  const lines = [
    `${mode.value.label}`,
    `→ ${repo}`,
    `${t('githubSync.lastPush') || 'Last push'}: ${fmtAgo(s.last_push_at)}`,
    `${t('githubSync.lastPull') || 'Last pull'}: ${fmtAgo(s.last_pull_at)}`,
  ];
  if (s.encrypted) lines.push(`🔒 ${t('githubSync.pillEncrypted') || 'End-to-end encrypted'}`);
  return lines.join('\n');
});

async function onClick() {
  switch (mode.value.action) {
    case 'push':
      await ops.pushNow();
      break;
    case 'pull':
      await ops.pullNow();
      break;
    case 'open-conflicts':
      // The conflict resolver lives in the History panel, which lives
      // in the right-side sidebar. Dispatching this event lets the
      // sidebar host (App.vue) bring it into focus without us depending
      // on the exact sidebar API here.
      window.dispatchEvent(new CustomEvent('solomd:open-history-panel'));
      break;
    case 'busy':
      // Click during an in-flight op is intentionally ignored — let it
      // finish. Toast just so the user gets feedback.
      toasts.info(t('githubSync.pillBusy') || 'Syncing — please wait');
      break;
    case 'noop':
    default:
      // Up-to-date / dirty-but-no-commit. Just confirm state in a toast
      // so a click never feels like nothing happened.
      if (status.value?.dirty) {
        toasts.info(t('githubSync.pillDirty') || 'Save first to push.');
      } else {
        toasts.success(t('githubSync.upToDate') || 'Already up to date.');
      }
      break;
  }
  // Whatever the action, refresh state afterwards so the pill reflects
  // the new ahead/behind/dirty.
  if (workspace.currentFolder) {
    await sync.refreshStatus(workspace.currentFolder);
  }
}
</script>

<template>
  <button
    v-if="visible"
    class="sync-pill"
    :class="`sync-pill--${mode.tone}`"
    :title="tooltip"
    @click="onClick"
  >
    <span class="sync-pill__cloud">{{ status?.encrypted ? '🔒' : '☁' }}</span>
    <span class="sync-pill__glyph">{{ mode.glyph }}</span>
  </button>
</template>

<style scoped>
.sync-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  cursor: pointer;
  font-variant-numeric: tabular-nums;
  font-family: inherit;
  transition: all 0.12s;
  line-height: 1.6;
}
.sync-pill:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.sync-pill__cloud {
  font-size: 11px;
  line-height: 1;
}
.sync-pill__glyph {
  font-family: var(--font-mono);
  letter-spacing: 0.02em;
  min-width: 14px;
  text-align: center;
}

.sync-pill--ok { color: var(--text-faint); border-color: var(--border); }
.sync-pill--ok:hover { color: var(--text); }

.sync-pill--warn {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
}
.sync-pill--warn:hover {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}

.sync-pill--err {
  color: #d12;
  border-color: rgba(221, 17, 34, 0.5);
}
.sync-pill--err:hover {
  background: rgba(221, 17, 34, 0.12);
}

.sync-pill--busy {
  color: var(--text-muted);
  border-color: var(--border);
}
.sync-pill--busy .sync-pill__glyph {
  display: inline-block;
  animation: sync-spin 0.8s linear infinite;
}
@keyframes sync-spin { to { transform: rotate(360deg); } }
</style>
