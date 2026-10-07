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
import GithubConflictPanel from './GithubConflictPanel.vue';
import Icons from './Icons.vue';
import PanelHeader from './panel/PanelHeader.vue';
import { hasGitBackend } from '../lib/platform';

/** #230 — no libgit2 in the Android binary; the init button would only ever
 *  answer `Command git_init_workspace not found`. */
const gitBackend = hasGitBackend();

const tabs = useTabsStore();
const workspace = useWorkspaceStore();
const gh = useGitHistoryStore();
const toasts = useToastsStore();
const { t } = useI18n();

const emit = defineEmits<{ close: [] }>();

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
      :count="!loading && commits.length > 0 ? commits.length : null"
      @close="emit('close')"
    />

    <!-- v2.6 — GitHub sync conflict resolver. Sits above the commit list
         when a pull surfaced merge conflicts; auto-hides when empty. -->
    <GithubConflictPanel />

    <!-- 1. No folder open -->
    <div v-if="!folder" class="rp-empty">
      {{ t('history.openFolder') }}
    </div>

    <!-- 2a. #230 — platform has no git backend at all (Android) -->
    <div v-else-if="!gitBackend" class="rp-empty">
      <p class="history__msg">{{ t('settings.syncUnsupportedAndroid') }}</p>
    </div>

    <!-- 2. Folder is not under git -->
    <div v-else-if="!gh.isInitialized" class="rp-empty">
      <p class="history__msg">{{ t('history.notInitialized') }}</p>
      <button class="rp-btn rp-btn--primary" :disabled="gh.loading" @click="onInit">
        {{ gh.loading ? '…' : t('history.initBtn') }}
      </button>
    </div>

    <!-- 3. No active file or no commits -->
    <div v-else-if="!activeFile" class="rp-empty">
      {{ t('history.noActive') }}
    </div>
    <div v-else-if="loading" class="rp-empty">
      {{ t('history.loading') }}
    </div>
    <div v-else-if="commits.length === 0" class="rp-empty">
      {{ t('history.empty') }}
    </div>

    <!-- 4. Commit list -->
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
  </div>
</template>

<style scoped>
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
