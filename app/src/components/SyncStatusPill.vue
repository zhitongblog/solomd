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
import { isMacOS } from '../lib/platform';
import { useSettingsStore } from '../stores/settings';
import { shortcutLabel } from '../lib/keybindings';
import { useGithubSyncStore } from '../stores/githubSync';
import { useGithubSync } from '../composables/useGithubSync';
import { useWorkspaceStore } from '../stores/workspace';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';
import Icons from './Icons.vue';

/** 'pill' — the status-bar pill. 'footer' — the 5.0 sidebar footer: a line
 *  icon + a short word (已同步 / 未同步 / 同步中 / 有冲突), same click actions. */
const props = withDefaults(defineProps<{ variant?: 'pill' | 'footer' }>(), { variant: 'pill' });

const sync = useGithubSyncStore();
const ops = useGithubSync();
const workspace = useWorkspaceStore();
const toasts = useToastsStore();
const { t } = useI18n();
// #180 — the chord in this sentence comes from the user's bindings, not from
// a literal baked into the translation.
const macChord = isMacOS();
const kbSettings = useSettingsStore();
function withChord(key: string, actionId: string): string {
  return t(key, { key: shortcutLabel(actionId, kbSettings.keybindings, macChord) || '—' });
}

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
      label: (s?.provider === 'gitea' ? t('githubSync.giteaPillConflicts', { n: String(s.conflicts.length) }) : t('githubSync.pillConflicts', { n: String(s.conflicts.length) })) || `${s.conflicts.length} conflict(s) — click to resolve`,
      action: 'open-conflicts',
      tone: 'err',
    };
  }
  if (s.behind > 0) {
    return {
      glyph: `↓${s.behind}`,
      label: (s?.provider === 'gitea' ? t('githubSync.giteaPillBehind', { n: String(s.behind) }) : t('githubSync.pillBehind', { n: String(s.behind) })) || `${s.behind} to pull — click to pull now`,
      action: 'pull',
      tone: 'warn',
    };
  }
  if (s.ahead > 0) {
    return {
      glyph: `↑${s.ahead}`,
      label: (s?.provider === 'gitea' ? t('githubSync.giteaPillAhead', { n: String(s.ahead) }) : t('githubSync.pillAhead', { n: String(s.ahead) })) || `${s.ahead} to push — click to push now`,
      action: 'push',
      tone: 'warn',
    };
  }
  if (s.dirty) {
    return {
      glyph: '●',
      label: withChord('githubSync.pillDirty', 'file.save') || 'Uncommitted local changes — save with ⌘S',
      action: 'noop',
      tone: 'warn',
    };
  }
  const cleanLabel = s?.provider === 'gitea'
    ? (t('githubSync.giteaPillClean') || 'In sync with Gitea')
    : (t('githubSync.pillClean') || 'In sync with GitHub');
  return { glyph: '✓', label: cleanLabel, action: 'noop', tone: 'ok' };
});

/** Short state word + icon for the sidebar footer. */
const footer = computed<{ icon: string; text: string }>(() => {
  const tone = mode.value.tone;
  if (tone === 'busy') return { icon: 'sync', text: t('sidebar.syncing') };
  if (tone === 'err') return { icon: 'sync', text: t('sidebar.syncConflicts') };
  if (tone === 'warn') return { icon: 'cloud', text: t('sidebar.unsynced') };
  return { icon: 'check-circle', text: t('sidebar.synced') };
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
  if (s.encrypted) lines.push(t('githubSync.pillEncrypted') || 'End-to-end encrypted');
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
        toasts.info(withChord('githubSync.pillDirty', 'file.save') || 'Save first to push.');
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
    v-if="visible && props.variant === 'footer'"
    class="sync-foot"
    :class="`sync-foot--${mode.tone}`"
    type="button"
    :title="tooltip"
    @click="onClick"
  >
    <Icons :name="footer.icon" :size="14" class="sync-foot__icon" />
    <span class="sync-foot__text">{{ footer.text }}</span>
  </button>
  <button
    v-else-if="visible"
    class="sync-pill"
    :class="`sync-pill--${mode.tone}`"
    :title="tooltip"
    @click="onClick"
  >
    <Icons
      class="sync-pill__cloud"
      :name="mode.tone === 'busy' ? 'sync' : 'cloud'"
      :size="13"
    />
    <span v-if="mode.tone === 'err'" class="sync-pill__glyph">{{ status?.conflicts.length ?? 0 }}</span>
    <span v-else-if="mode.glyph === '●'" class="sync-pill__dot" aria-hidden="true" />
    <span v-else-if="mode.glyph.startsWith('↑') || mode.glyph.startsWith('↓')" class="sync-pill__glyph">{{ mode.glyph }}</span>
  </button>
</template>

<style scoped>
.sync-foot {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 12px;
  cursor: default;
}
.sync-foot:hover {
  background: var(--fill-1);
  color: var(--text-2);
}
.sync-foot__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sync-foot--warn .sync-foot__icon {
  color: var(--accent);
}
.sync-foot--err {
  color: var(--danger);
}
.sync-foot--busy .sync-foot__icon {
  animation: sync-spin 1s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .sync-foot--busy .sync-foot__icon {
    animation: none;
  }
}
.sync-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 7px;
  border: 0;
  border-radius: var(--r-full);
  background: transparent;
  color: var(--text-3);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.sync-pill:hover {
  background: var(--fill-1);
  color: var(--text);
}
.sync-pill:focus-visible {
  outline: none;
  box-shadow: var(--ring);
}
.sync-pill__cloud {
  flex: 0 0 auto;
}
.sync-pill__glyph {
  min-width: 10px;
  text-align: center;
}
.sync-pill__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.sync-pill--warn {
  color: var(--accent-text);
}
.sync-pill--warn:hover {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.sync-pill--err {
  color: var(--danger);
}
.sync-pill--err:hover {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
}

.sync-pill--busy .sync-pill__cloud {
  animation: sync-spin 0.9s linear infinite;
}
@keyframes sync-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .sync-pill--busy .sync-pill__cloud { animation: none; }
}
</style>
