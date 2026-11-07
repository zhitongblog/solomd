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
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceStore } from '../stores/workspace';
import { useSettingsStore } from '../stores/settings';
import { useGitHistoryStore, type CommitMeta, type DiffResult } from '../stores/gitHistory';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';
import GithubConflictPanel from './GithubConflictPanel.vue';
import Icons from './Icons.vue';
import PanelHeader from './panel/PanelHeader.vue';
import { hasGitBackend } from '../lib/platform';

/** #230 — no libgit2 in the Android binary; the init button would only ever
 *  answer `Command git_init_workspace not found`. */
const gitBackend = hasGitBackend();

const tabs = useTabsStore();
const workspace = useWorkspaceStore();
const settings = useSettingsStore();
const gh = useGitHistoryStore();
const toasts = useToastsStore();
const { t } = useI18n();

const emit = defineEmits<{ close: [] }>();

const activeFile = computed(() => tabs.activeTab?.filePath ?? null);
const folder = computed(() => workspace.currentFolder);

type HistoryTabMode = 'snapshots' | 'git';
const activeMode = ref<HistoryTabMode>('snapshots');

interface SyncVersionEntry {
  id: string;
  rel_path: string;
  sha256: string;
  size: number;
  created_at: number;
  label: string;
  device: string;
}

const snapshots = ref<SyncVersionEntry[]>([]);
const snapshotsLoading = ref(false);
const expandedSnapId = ref<string | null>(null);
const snapDiffCache = ref<Record<string, DiffResult | null>>({});

const commits = ref<CommitMeta[]>([]);
const loading = ref(false);
const expandedSha = ref<string | null>(null);
const diffCache = ref<Record<string, DiffResult | null>>({});

async function reloadSnapshots() {
  if (!folder.value || !activeFile.value) {
    snapshots.value = [];
    return;
  }
  snapshotsLoading.value = true;
  try {
    snapshots.value = await invoke<SyncVersionEntry[]>('sync_list_file_versions', {
      workspace: folder.value,
      filePath: activeFile.value,
    });
  } catch {
    snapshots.value = [];
  } finally {
    snapshotsLoading.value = false;
  }
}

async function reload() {
  void reloadSnapshots();
  if (!folder.value || !activeFile.value) {
    commits.value = [];
    return;
  }
  if (!gitBackend) {
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
  expandedSnapId.value = null;
  snapDiffCache.value = {};
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

function onSnapshotSavedEvent() {
  snapDiffCache.value = {};
  void reloadSnapshots();
}

onMounted(async () => {
  window.addEventListener('solomd:snapshot-saved', onSnapshotSavedEvent);
  window.addEventListener('solomd:remote-pulled', onSnapshotSavedEvent);
  if (folder.value && gitBackend) await gh.refreshStatus(folder.value);
  reload();
});

onUnmounted(() => {
  window.removeEventListener('solomd:snapshot-saved', onSnapshotSavedEvent);
  window.removeEventListener('solomd:remote-pulled', onSnapshotSavedEvent);
});

async function saveManualSnapshot() {
  if (!folder.value || !activeFile.value) return;
  try {
    const entry = await invoke<SyncVersionEntry | null>('sync_save_file_snapshot', {
      workspace: folder.value,
      filePath: activeFile.value,
      label: settings.language === 'zh' ? '手动创建版本快照' : 'Manual snapshot',
      maxVersions: settings.syncMaxVersions,
    });
    if (entry) {
      toasts.success(
        settings.language === 'zh'
          ? `已保存版本快照 (${entry.sha256.slice(0, 7)})`
          : `Saved version snapshot (${entry.sha256.slice(0, 7)})`,
      );
      snapDiffCache.value = {};
      await reloadSnapshots();
    } else {
      toasts.info(
        settings.language === 'zh'
          ? '当前内容与最新快照相同，无需重复创建'
          : 'Content matches latest snapshot',
      );
    }
  } catch (e) {
    toasts.error(String(e));
  }
}

async function toggleSnapRow(id: string) {
  if (expandedSnapId.value === id) {
    expandedSnapId.value = null;
    return;
  }
  expandedSnapId.value = id;
  if (snapDiffCache.value[id] === undefined && folder.value && activeFile.value) {
    try {
      snapDiffCache.value[id] = await invoke<DiffResult>('sync_get_file_version_diff', {
        workspace: folder.value,
        filePath: activeFile.value,
        versionId: id,
      });
    } catch {
      snapDiffCache.value[id] = null;
    }
  }
}

async function onRestoreSnapshot(entry: SyncVersionEntry) {
  if (!folder.value || !activeFile.value) return;
  const shortSha = entry.sha256.slice(0, 7);
  if (!window.confirm(t('history.confirmRestore', { sha: shortSha }))) return;
  const tabId = tabs.activeTab?.id;
  try {
    const restored = await invoke<string>('sync_restore_file_version', {
      workspace: folder.value,
      filePath: activeFile.value,
      versionId: entry.id,
      maxVersions: settings.syncMaxVersions,
    });
    if (tabId) {
      tabs.setContent(tabId, restored);
      tabs.markSaved(tabId, activeFile.value);
    }
    snapDiffCache.value = {};
    await reloadSnapshots();
    toasts.success(t('history.restored', { sha: shortSha }));
  } catch (e) {
    toasts.error(`${t('history.commitFailed')}: ${e}`);
  }
}

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
  if (!window.confirm(t('history.confirmRestore', { sha: shortSha }))) return;
  const tabId = tabs.activeTab?.id;
  try {
    // Backend rolls back the on-disk file...
    await gh.rollback(folder.value, activeFile.value, sha);
    // ...but the active tab's in-memory buffer still has the OLD content.
    // If we don't sync it now, (1) the editor visually shows no change so
    // the user thinks rollback failed, and (2) the next ⌘S writes the
    // stale buffer back to disk, silently undoing the rollback. Pull the
    // fresh content from the target sha and overwrite the tab buffer +
    // mark it saved (no unsaved-changes indicator).
    const restored = await gh.fileAt(folder.value, activeFile.value, sha);
    if (restored !== null && tabId) {
      tabs.setContent(tabId, restored);
      tabs.markSaved(tabId, activeFile.value);
    }
    toasts.success(t('history.restored', { sha: shortSha }));
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
  <div class="history rp">
    <PanelHeader
      :title="t('history.heading')"
      :count="
        activeMode === 'snapshots'
          ? (!snapshotsLoading && snapshots.length > 0 ? snapshots.length : null)
          : (!loading && commits.length > 0 ? commits.length : null)
      "
      @close="emit('close')"
    />

    <!-- v2.6 — GitHub sync conflict resolver. Sits above the commit list
         when a pull surfaced merge conflicts; auto-hides when empty. -->
    <GithubConflictPanel />

    <div v-if="folder && activeFile" class="history__mode-bar">
      <div class="history__mode-tabs">
        <button
          type="button"
          class="history__mode-tab"
          :class="{ 'history__mode-tab--active': activeMode === 'snapshots' }"
          @click="activeMode = 'snapshots'"
        >
          {{ settings.language === 'zh' ? '云同步与本地快照' : 'Snapshots' }}
          <span v-if="snapshots.length > 0" class="history__mode-badge">{{ snapshots.length }}</span>
        </button>
        <button
          v-if="gitBackend"
          type="button"
          class="history__mode-tab"
          :class="{ 'history__mode-tab--active': activeMode === 'git' }"
          @click="activeMode = 'git'"
        >
          Git
          <span v-if="commits.length > 0" class="history__mode-badge">{{ commits.length }}</span>
        </button>
      </div>
      <button
        v-if="activeMode === 'snapshots'"
        type="button"
        class="rp-btn rp-btn--sm"
        @click="saveManualSnapshot"
      >
        {{ settings.language === 'zh' ? '📌 创建快照' : '📌 Snapshot' }}
      </button>
    </div>

    <!-- 1. No folder open -->
    <div v-if="!folder" class="rp-empty">
      {{ t('history.openFolder') }}
    </div>

    <div v-else-if="!activeFile" class="rp-empty">
      {{ t('history.noActive') }}
    </div>

    <!-- Mode A: Cross-platform Local & Cloud Sync Snapshots (`.solomd-sync/versions/`) -->
    <template v-else-if="activeMode === 'snapshots'">
      <div v-if="snapshotsLoading" class="rp-empty">
        {{ t('history.loading') }}
      </div>
      <div v-else-if="snapshots.length === 0" class="rp-empty">
        <p class="history__msg">
          {{
            settings.language === 'zh'
              ? '暂无快照（保存笔记或同步到网盘时会自动留存版本）'
              : 'No snapshots yet (saved automatically on save & cloud sync)'
          }}
        </p>
        <button class="rp-btn rp-btn--primary" @click="saveManualSnapshot">
          {{ settings.language === 'zh' ? '📌 立即创建首个版本快照' : '📌 Create First Snapshot' }}
        </button>
      </div>
      <ul v-else class="rp-body rp-list history__list">
        <li v-for="s in snapshots" :key="s.id" class="history__item">
          <button
            class="rp-row history__row"
            :class="{ 'history__row--open': expandedSnapId === s.id }"
            :aria-expanded="expandedSnapId === s.id"
            @click="toggleSnapRow(s.id)"
          >
            <Icons class="rp-row__icon history__chev" name="chevron-right" :size="12" />
            <span class="rp-row__label history__msg-line">{{ s.label }}</span>
            <span class="rp-count history__time">{{ timeAgo(s.created_at) }}</span>
          </button>

          <div v-if="expandedSnapId === s.id" class="history__diff-wrap">
            <div class="history__diff-toolbar">
              <button class="rp-btn rp-btn--sm history__restore" @click="onRestoreSnapshot(s)">
                <Icons name="undo" :size="12" />
                {{ t('history.restore') }}
              </button>
              <span class="history__author">
                <span class="history__sha">{{ s.sha256.slice(0, 7) }}</span> · {{ s.device }}
              </span>
            </div>
            <div v-if="snapDiffCache[s.id] === undefined" class="history__diff-loading">
              {{ t('history.loading') }}
            </div>
            <div v-else-if="!snapDiffCache[s.id]" class="history__diff-empty">
              {{ t('history.diffUnavailable') }}
            </div>
            <pre v-else class="history__diff">
<template v-for="(hunk, hi) in snapDiffCache[s.id]!.hunks" :key="hi"><span class="history__hunk-hdr">@@ -{{ hunk.old_start }},{{ hunk.old_lines }} +{{ hunk.new_start }},{{ hunk.new_lines }} @@</span>
<template v-for="(line, li) in hunk.lines" :key="`${hi}-${li}`"><span :class="['history__line', `history__line--${line.kind}`]">{{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ' }}{{ line.text }}</span>
</template></template></pre>
          </div>
        </li>
      </ul>
    </template>

    <!-- Mode B: AutoGit per-note history -->
    <template v-else>
      <div v-if="!gitBackend" class="rp-empty">
        <p class="history__msg">{{ t('settings.syncUnsupportedAndroid') }}</p>
      </div>
      <div v-else-if="!gh.isInitialized" class="rp-empty">
        <p class="history__msg">{{ t('history.notInitialized') }}</p>
        <button class="rp-btn rp-btn--primary" :disabled="gh.loading" @click="onInit">
          {{ gh.loading ? '…' : t('history.initBtn') }}
        </button>
      </div>
      <div v-else-if="loading" class="rp-empty">
        {{ t('history.loading') }}
      </div>
      <div v-else-if="commits.length === 0" class="rp-empty">
        {{ t('history.empty') }}
      </div>
      <ul v-else class="rp-body rp-list history__list">
        <li v-for="c in commits" :key="c.sha" class="history__item">
          <button
            class="rp-row history__row"
            :class="{ 'history__row--open': expandedSha === c.sha }"
            :aria-expanded="expandedSha === c.sha"
            @click="toggleRow(c.sha)"
          >
            <Icons class="rp-row__icon history__chev" name="chevron-right" :size="12" />
            <span class="rp-row__label history__msg-line">{{ c.message }}</span>
            <span class="rp-count history__time">{{ timeAgo(c.time) }}</span>
          </button>

          <div v-if="expandedSha === c.sha" class="history__diff-wrap">
            <div class="history__diff-toolbar">
              <button class="rp-btn rp-btn--sm history__restore" @click="onRestore(c.sha, c.short_sha)">
                <Icons name="undo" :size="12" />
                {{ t('history.restore') }}
              </button>
              <span class="history__author"><span class="history__sha">{{ c.short_sha }}</span> · {{ c.author }}</span>
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
    </template>
  </div>
</template>

<style scoped>
.history__mode-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: var(--bd-hair);
}
.history__mode-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
}
.history__mode-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: none;
  border-radius: var(--r-sm, 4px);
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  cursor: pointer;
}
.history__mode-tab--active {
  background: var(--fill-2, rgba(127, 127, 127, 0.14));
  color: var(--text);
  font-weight: 600;
}
.history__mode-badge {
  font-size: 10px;
  opacity: 0.75;
}
.history__msg {
  margin: 0 0 2px;
}
.history__list > li + li {
  margin-top: 1px;
}
.history__chev {
  transition: transform var(--dur-fast) var(--ease);
}
.history__row--open {
  background: var(--fill-1);
}
.history__row--open .history__chev {
  transform: rotate(90deg);
}
.history__sha {
  font-family: var(--font-mono);
  font-size: 11px;
}
.history__time {
  min-width: 2.5em;
  text-align: right;
}
.history__diff-wrap {
  margin: 4px 0 8px 8px;
  border: var(--bd-hair);
  border-radius: var(--r-md);
  background: var(--bg-elev);
  overflow: hidden;
}
.history__diff-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: var(--bd-hair);
}
.history__author {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-3);
}
.history__diff-loading,
.history__diff-empty {
  padding: 12px;
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
}
.history__diff {
  margin: 0;
  padding: 8px 10px;
  font-family: var(--font-mono);
  /* The template's literal newlines between the block-level line spans
     would each add an empty line; zero-size them, the spans restore it. */
  font-size: 0;
  line-height: 1.55;
  white-space: pre;
  overflow: auto;
  max-height: 360px;
  color: var(--text);
}
.history__hunk-hdr,
.history__line {
  font-size: 11px;
}
.history__hunk-hdr {
  display: block;
  margin: 2px 0;
  color: var(--text-3);
}
.history__line {
  display: block;
}
.history__line--add {
  background: color-mix(in srgb, var(--success) 14%, transparent);
  color: color-mix(in srgb, var(--success) 80%, var(--text));
}
.history__line--remove {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: color-mix(in srgb, var(--danger) 80%, var(--text));
}
.history__line--context {
  color: var(--text-2);
}
</style>
