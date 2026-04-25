<script setup lang="ts">
/**
 * v2.2 — AutoGit per-note History sidebar panel.
 *
 * Lists every commit that touched the active document, newest first.
 * Click a row to expand its unified-diff inline; the "Restore" button
 * at the top of the diff overwrites the working copy with that version
 * (the next save will commit the rollback).
 *
 * Empty states:
 *   - No folder open → "Open a folder to enable history"
 *   - Folder not under git → "Initialize git history" button
 *   - Folder under git but file never committed → "No commits yet"
 *
 * i18n keys (must exist in en.ts + zh.ts; see SUMMARY.md):
 *   history.heading, history.empty, history.notInitialized,
 *   history.initBtn, history.restore, history.confirmRestore,
 *   history.justNow, history.savedSnapshot, history.commitFailed
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceStore } from '../stores/workspace';
import { useGitHistoryStore, type CommitMeta, type DiffResult } from '../stores/gitHistory';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

const tabs = useTabsStore();
const workspace = useWorkspaceStore();
const gh = useGitHistoryStore();
const toasts = useToastsStore();
const { t } = useI18n();

const activeFile = computed(() => tabs.activeTab?.filePath ?? null);
const folder = computed(() => workspace.currentFolder);

const commits = ref<CommitMeta[]>([]);
const loading = ref(false);
const expandedSha = ref<string | null>(null);
const diffCache = ref<Record<string, DiffResult | null>>({});

async function reload() {
  if (!folder.value || !activeFile.value) {
    commits.value = [];
    return;
  }
  if (!gh.status) {
    await gh.refreshStatus(folder.value);
  }
  if (!gh.isInitialized) {
    commits.value = [];
    return;
  }
  loading.value = true;
  try {
    commits.value = await gh.historyFor(folder.value, activeFile.value);
  } finally {
    loading.value = false;
  }
}

watch([folder, activeFile], () => {
  expandedSha.value = null;
  diffCache.value = {};
  reload();
});

watch(
  () => gh.status?.head_sha,
  () => {
    // HEAD moved — invalidate cached diffs.
    diffCache.value = {};
    reload();
  },
);

onMounted(async () => {
  if (folder.value) await gh.refreshStatus(folder.value);
  reload();
});

async function onInit() {
  if (!folder.value) return;
  try {
    await gh.init(folder.value, 'init: SoloMD workspace');
    toasts.success(t('history.initialized'));
    reload();
  } catch (e) {
    toasts.error(`${t('history.initFailed')}: ${e}`);
  }
}

async function toggleRow(sha: string) {
  if (expandedSha.value === sha) {
    expandedSha.value = null;
    return;
  }
  expandedSha.value = sha;
  if (diffCache.value[sha] === undefined && folder.value && activeFile.value) {
    diffCache.value[sha] = await gh.diff(folder.value, activeFile.value, sha);
  }
}

async function onRestore(sha: string, shortSha: string) {
  if (!folder.value || !activeFile.value) return;
  // Lightweight in-thread confirm; the parent integrates a richer dialog later.
  if (!window.confirm(t('history.confirmRestore', { sha: shortSha }))) return;
  try {
    await gh.rollback(folder.value, activeFile.value, sha);
    toasts.success(t('history.restored', { sha: shortSha }));
    // Tell the editor to reload from disk — the file watcher catches the
    // change but the active tab won't auto-pick-up unless we hint it.
    window.dispatchEvent(
      new CustomEvent('solomd:reload-active', { detail: { filePath: activeFile.value } }),
    );
  } catch (e) {
    toasts.error(`${t('history.commitFailed')}: ${e}`);
  }
}

/**
 * Render a "5 minutes ago" string. Falls back to a wall-clock UTC stamp
 * for anything older than ~30 days. Cheap, no Intl.RelativeTimeFormat —
 * the panel updates on each open so we don't need a ticker.
 */
function timeAgo(unix: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - unix);
  if (delta < 60) return t('history.justNow');
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 86_400 * 30) return `${Math.floor(delta / 86_400)}d`;
  const d = new Date(unix * 1000);
  return d.toISOString().slice(0, 10);
}
</script>

<template>
  <div class="history">
    <header class="history__head">
      <span class="history__title">{{ t('history.heading') }}</span>
      <span v-if="!loading && commits.length > 0" class="history__count">{{ commits.length }}</span>
    </header>

    <!-- 1. No folder open -->
    <div v-if="!folder" class="history__empty">
      {{ t('history.openFolder') }}
    </div>

    <!-- 2. Folder is not under git -->
    <div v-else-if="!gh.isInitialized" class="history__empty">
      <p class="history__msg">{{ t('history.notInitialized') }}</p>
      <button class="history__init-btn" :disabled="gh.loading" @click="onInit">
        {{ gh.loading ? '…' : t('history.initBtn') }}
      </button>
    </div>

    <!-- 3. No active file or no commits -->
    <div v-else-if="!activeFile" class="history__empty">
      {{ t('history.noActive') }}
    </div>
    <div v-else-if="loading" class="history__empty">
      {{ t('history.loading') }}
    </div>
    <div v-else-if="commits.length === 0" class="history__empty">
      {{ t('history.empty') }}
    </div>

    <!-- 4. Commit list -->
    <ul v-else class="history__list">
      <li v-for="c in commits" :key="c.sha" class="history__item">
        <button
          class="history__row"
          :class="{ 'history__row--open': expandedSha === c.sha }"
          @click="toggleRow(c.sha)"
        >
          <span class="history__sha">{{ c.short_sha }}</span>
          <span class="history__time">{{ timeAgo(c.time) }}</span>
          <span class="history__msg-line">{{ c.message }}</span>
        </button>

        <div v-if="expandedSha === c.sha" class="history__diff-wrap">
          <div class="history__diff-toolbar">
            <button class="history__restore" @click="onRestore(c.sha, c.short_sha)">
              {{ t('history.restore') }}
            </button>
            <span class="history__author">{{ c.author }}</span>
          </div>
          <div v-if="diffCache[c.sha] === undefined" class="history__diff-loading">
            {{ t('history.loading') }}
          </div>
          <div v-else-if="!diffCache[c.sha]" class="history__diff-empty">
            {{ t('history.diffUnavailable') }}
          </div>
          <pre v-else class="history__diff">
<template v-for="(hunk, hi) in diffCache[c.sha]!.hunks" :key="hi"><span class="history__hunk-hdr">@@ -{{ hunk.old_start }},{{ hunk.old_lines }} +{{ hunk.new_start }},{{ hunk.new_lines }} @@</span>
<template v-for="(line, li) in hunk.lines" :key="`${hi}-${li}`"><span :class="['history__line', `history__line--${line.kind}`]">{{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ' }}{{ line.text }}</span>
</template></template></pre>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.history {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  overflow: hidden;
}
.history__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
}
.history__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.history__count {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.history__empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.6;
}
.history__msg {
  margin: 0 0 12px;
}
.history__init-btn {
  background: var(--accent, #ff9f40);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.12s;
}
.history__init-btn:hover {
  opacity: 0.9;
}
.history__init-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.history__list {
  list-style: none;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  flex: 1;
}
.history__item + .history__item {
  margin-top: 2px;
}
.history__row {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 8px;
  align-items: baseline;
  width: 100%;
  background: transparent;
  border: 1px solid transparent;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s, border-color 0.12s;
}
.history__row:hover {
  background: var(--bg-hover);
  border-color: var(--border);
}
.history__row--open {
  background: var(--bg-hover);
  border-color: var(--border);
}
.history__sha {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--accent, #ff9f40);
  font-weight: 500;
}
.history__time {
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.history__msg-line {
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history__diff-wrap {
  margin: 4px 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-soft);
  overflow: hidden;
}
.history__diff-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
.history__restore {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.history__restore:hover {
  background: var(--bg-hover);
  border-color: var(--accent, #ff9f40);
  color: var(--accent, #ff9f40);
}
.history__author {
  font-size: 10px;
  color: var(--text-faint);
}
.history__diff-loading,
.history__diff-empty {
  padding: 12px;
  font-size: 11px;
  color: var(--text-faint);
  text-align: center;
}
.history__diff {
  margin: 0;
  padding: 8px 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre;
  overflow-x: auto;
  max-height: 360px;
  overflow-y: auto;
  color: var(--text);
}
.history__hunk-hdr {
  display: block;
  color: var(--text-faint);
  background: var(--bg-elev);
  padding: 0 4px;
  border-radius: 3px;
  margin: 2px 0;
}
.history__line {
  display: block;
}
.history__line--add {
  background: rgba(46, 160, 67, 0.18);
  color: #2ea043;
}
.history__line--remove {
  background: rgba(248, 81, 73, 0.18);
  color: #f85149;
}
.history__line--context {
  color: var(--text-muted);
}
</style>
