<script setup lang="ts">
/**
 * #637 / #677 / #687 / #689 — Sync Conflict & Snapshot Manager Modal.
 *
 * Scans the active workspace for side-by-side sync conflict copies
 * (`* (冲突副本 *).*`), shows the color-coded line diff side-by-side with the
 * live merge editor at a fixed non-jumping height, supports smart inline
 * `<<<<<<<<` diff-based merging anchored on the working copy, and confirms
 * before destructive resolution.
 */
import { computed, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
import DsModal from '../ui/DsModal.vue';
import DsButton from '../ui/DsButton.vue';
import { useWorkspaceStore } from '../stores/workspace';
import { useTabsStore } from '../stores/tabs';
import { useSettingsStore } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import { samePath } from '../lib/path-key';

export interface SyncConflictEntry {
  base_rel: string;
  conflict_rel: string;
  base_exists: boolean;
  conflict_mtime: number;
  conflict_size: number;
  snapshot_dir: string;
}

interface DiffLine {
  kind: 'context' | 'add' | 'del';
  text: string;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface SyncConflictDiff {
  base_rel: string;
  conflict_rel: string;
  base_text: string;
  conflict_text: string;
  added_lines: number;
  removed_lines: number;
  hunks: DiffHunk[];
}

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

const workspace = useWorkspaceStore();
const tabs = useTabsStore();
const settings = useSettingsStore();
const toasts = useToastsStore();

const zh = computed(() => settings.language?.startsWith('zh'));
const folder = computed(() => workspace.currentFolder);

const loading = ref(false);
const resolving = ref(false);
const conflicts = ref<SyncConflictEntry[]>([]);
const selectedRel = ref<string | null>(null);
const diff = ref<SyncConflictDiff | null>(null);
const diffLoading = ref(false);
const mergedText = ref('');

const selectedEntry = computed(
  () => conflicts.value.find((c) => c.conflict_rel === selectedRel.value) ?? null,
);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(unix: number): string {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * #689 — Build an inline merged text anchored on `baseText`, inserting lines
 * added/modified in `conflictText` at their exact diff positions prefixed with
 * `<<<<<<<<` so the user can jump straight to every conflict mark.
 */
function buildInlineDiffMerge(baseText: string, conflictText: string): string {
  const normBase = baseText.replace(/\r\n/g, '\n');
  const normConflict = conflictText.replace(/\r\n/g, '\n');
  if (!normConflict) return normBase;
  if (!normBase) {
    return normConflict
      .split('\n')
      .map((line) => `<<<<<<<<${line}`)
      .join('\n');
  }
  const a = normBase.split('\n');
  const b = normConflict.split('\n');
  const m = a.length;
  const n = b.length;
  // Guard DP size for very large files (~2000+ lines) by falling back cleanly.
  if (m * n > 4_000_000) {
    return `${baseText}\n\n<<<<<<<<\n${conflictText}`;
  }
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // Base-only line: keep unmarked as requested in #689.
      out.push(a[i]);
      i++;
    } else {
      // Conflict-only / modified line: insert inline with `<<<<<<<<` prefix.
      out.push(`<<<<<<<<${b[j]}`);
      j++;
    }
  }
  while (i < m) {
    out.push(a[i++]);
  }
  while (j < n) {
    out.push(`<<<<<<<<${b[j++]}`);
  }
  return out.join('\n');
}

async function reload() {
  if (!folder.value) {
    conflicts.value = [];
    selectedRel.value = null;
    diff.value = null;
    return;
  }
  loading.value = true;
  try {
    conflicts.value = await invoke<SyncConflictEntry[]>('sync_list_conflicts', {
      workspace: folder.value,
    });
    if (conflicts.value.length > 0) {
      const keep = conflicts.value.some((c) => c.conflict_rel === selectedRel.value);
      selectedRel.value = keep ? selectedRel.value : conflicts.value[0].conflict_rel;
      await loadDiff();
    } else {
      selectedRel.value = null;
      diff.value = null;
    }
  } catch (e) {
    toasts.error(String(e));
  } finally {
    loading.value = false;
  }
}

let diffSeq = 0;

async function loadDiff() {
  const entry = selectedEntry.value;
  const seq = ++diffSeq;
  if (!folder.value || !entry) {
    diff.value = null;
    diffLoading.value = false;
    return;
  }
  diffLoading.value = true;
  try {
    const res = await invoke<SyncConflictDiff>('sync_diff_conflict', {
      workspace: folder.value,
      baseRel: entry.base_rel,
      conflictRel: entry.conflict_rel,
    });
    if (seq !== diffSeq) return;
    diff.value = res;
    mergedText.value = res.base_text || res.conflict_text;
  } catch (e) {
    if (seq !== diffSeq) return;
    diff.value = null;
    toasts.error(String(e));
  } finally {
    if (seq === diffSeq) {
      diffLoading.value = false;
    }
  }
}

async function selectConflict(rel: string) {
  selectedRel.value = rel;
  await loadDiff();
}

function reloadOpenBaseTab(baseRel: string, content: string) {
  if (!folder.value) return;
  const full = `${folder.value.replace(/\\/g, '/').replace(/\/+$/, '')}/${baseRel}`;
  const normalized = content.replace(/\r\n/g, '\n');
  for (const tab of tabs.tabs) {
    if (!tab.filePath) continue;
    if (samePath(tab.filePath, full)) {
      tabs.setContent(tab.id, normalized);
      tabs.markSaved(tab.id, tab.filePath);
    }
  }
}

function closeOpenConflictTab(conflictRel: string) {
  if (!folder.value) return;
  const full = `${folder.value.replace(/\\/g, '/').replace(/\/+$/, '')}/${conflictRel}`;
  for (const tab of [...tabs.tabs]) {
    if (!tab.filePath) continue;
    if (samePath(tab.filePath, full)) {
      tabs.closeTab(tab.id);
    }
  }
}

async function resolve(strategy: 'keep_base' | 'use_conflict' | 'manual_merge') {
  const entry = selectedEntry.value;
  if (!folder.value || !entry || resolving.value) return;
  const confirmMsg = zh.value
    ? strategy === 'keep_base'
      ? `确定保留工作副本「${entry.base_rel}」并删除冲突副本「${entry.conflict_rel}」？`
      : strategy === 'use_conflict'
        ? `确定用冲突副本「${entry.conflict_rel}」覆盖工作副本「${entry.base_rel}」？（原工作副本将自动保存快照）`
        : `确定将当前手工合并内容写入「${entry.base_rel}」并删除冲突副本「${entry.conflict_rel}」？`
    : strategy === 'keep_base'
      ? `Keep working copy "${entry.base_rel}" and delete conflict copy "${entry.conflict_rel}"?`
      : strategy === 'use_conflict'
        ? `Overwrite "${entry.base_rel}" with conflict copy "${entry.conflict_rel}"? (A snapshot of the current working copy will be saved.)`
        : `Save merged content to "${entry.base_rel}" and delete conflict copy "${entry.conflict_rel}"?`;
  let ok = false;
  try {
    ok = await tauriConfirm(confirmMsg, {
      title: zh.value ? '确认解决同步冲突' : 'Confirm Conflict Resolution',
      kind: 'warning',
    });
  } catch {
    ok = window.confirm(confirmMsg);
  }
  if (!ok) return;
  resolving.value = true;
  try {
    await invoke('sync_resolve_conflict', {
      workspace: folder.value,
      baseRel: entry.base_rel,
      conflictRel: entry.conflict_rel,
      strategy,
      mergedContent: strategy === 'manual_merge' ? mergedText.value : null,
    });
    if (strategy === 'use_conflict' && diff.value) {
      reloadOpenBaseTab(entry.base_rel, diff.value.conflict_text);
    } else if (strategy === 'manual_merge') {
      reloadOpenBaseTab(entry.base_rel, mergedText.value);
    }
    closeOpenConflictTab(entry.conflict_rel);
    toasts.success(
      zh.value
        ? strategy === 'keep_base'
          ? '已保留工作副本并移除冲突副本'
          : strategy === 'use_conflict'
            ? '已采用冲突副本覆盖工作副本（原版本已保存快照）'
            : '已保存手工合并结果并移除冲突副本'
        : 'Conflict resolved',
    );
    window.dispatchEvent(new CustomEvent('solomd:refresh-tree'));
    await reload();
  } catch (e) {
    toasts.error(String(e));
  } finally {
    resolving.value = false;
  }
}

async function openSnapshotDir() {
  if (!folder.value) return;
  try {
    const dir = await invoke<string>('sync_ensure_snapshot_dir', {
      workspace: folder.value,
    });
    await openPath(dir);
  } catch (e) {
    toasts.error(String(e));
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) void reload();
  },
  { immediate: true },
);
</script>

<template>
  <DsModal
    :model-value="props.modelValue"
    :title="zh ? '同步冲突与快照管理' : 'Sync Conflict & Snapshot Manager'"
    width="1120px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="scm">
      <div class="scm__bar">
        <span class="scm__summary">
          {{
            zh
              ? `当前工作区共检测到 ${conflicts.length} 个冲突副本`
              : `${conflicts.length} conflict copy(ies) detected in workspace`
          }}
        </span>
        <div class="scm__bar-actions">
          <DsButton variant="ghost" size="sm" @click="openSnapshotDir">
            {{ zh ? '打开快照目录' : 'Open Snapshot Dir' }}
          </DsButton>
          <DsButton variant="ghost" size="sm" :disabled="loading" @click="reload">
            {{ zh ? '刷新' : 'Refresh' }}
          </DsButton>
        </div>
      </div>

      <div v-if="!folder" class="scm__empty">
        {{ zh ? '请先打开一个工作区文件夹。' : 'Open a workspace folder first.' }}
      </div>
      <div v-else-if="loading" class="scm__empty">
        {{ zh ? '正在扫描冲突副本…' : 'Scanning conflict copies…' }}
      </div>
      <div v-else-if="conflicts.length === 0" class="scm__empty">
        {{ zh ? '当前工作区没有未处理的同步冲突副本。' : 'No unresolved sync conflict copies in this workspace.' }}
      </div>

      <div v-else class="scm__body">
        <aside class="scm__list">
          <button
            v-for="c in conflicts"
            :key="c.conflict_rel"
            type="button"
            class="scm__item"
            :class="{ 'is-active': c.conflict_rel === selectedRel }"
            @click="selectConflict(c.conflict_rel)"
          >
            <span class="scm__item-base">{{ c.base_rel }}</span>
            <span class="scm__item-conflict">{{ c.conflict_rel }}</span>
            <span class="scm__item-meta">{{ formatTime(c.conflict_mtime) }} · {{ formatSize(c.conflict_size) }}</span>
          </button>
        </aside>

        <section v-if="selectedEntry" class="scm__detail">
          <div class="scm__paths">
            <div><strong>{{ zh ? '工作副本：' : 'Working copy:' }}</strong> <code>{{ selectedEntry.base_rel }}</code></div>
            <div><strong>{{ zh ? '冲突副本：' : 'Conflict copy:' }}</strong> <code>{{ selectedEntry.conflict_rel }}</code></div>
            <div><strong>{{ zh ? '快照位置：' : 'Snapshots:' }}</strong> <code>{{ selectedEntry.snapshot_dir }}</code></div>
          </div>

          <div v-if="diffLoading" class="scm__empty">{{ zh ? '正在计算差异…' : 'Computing diff…' }}</div>

          <template v-else-if="diff">
            <div class="scm__split">
              <div class="scm__pane">
                <div class="scm__pane-head">
                  <span>{{ zh ? `差异参考 (+${diff.added_lines} / -${diff.removed_lines})` : `Diff Reference (+${diff.added_lines} / -${diff.removed_lines})` }}</span>
                </div>
                <div class="scm__diff">
                  <div v-if="diff.hunks.length === 0" class="scm__empty">
                    {{ zh ? '工作副本与冲突副本内容完全一致，可直接保留工作副本。' : 'Both files have identical content.' }}
                  </div>
                  <div v-for="(h, hi) in diff.hunks" :key="hi" class="scm__hunk">
                    <div class="scm__hunk-head">{{ h.header }}</div>
                    <pre
                      v-for="(ln, li) in h.lines"
                      :key="li"
                      class="scm__line"
                      :class="`scm__line--${ln.kind}`"
                    >{{ ln.kind === 'add' ? '+' : ln.kind === 'del' ? '-' : ' ' }} {{ ln.text }}</pre>
                  </div>
                </div>
              </div>

              <div class="scm__pane">
                <div class="scm__pane-head">
                  <span>{{ zh ? '手工合并修复区' : 'Merge Editor' }}</span>
                  <div class="scm__merge-tools">
                    <DsButton variant="ghost" size="sm" @click="mergedText = diff.base_text">
                      {{ zh ? '填入工作副本' : 'Working' }}
                    </DsButton>
                    <DsButton variant="ghost" size="sm" @click="mergedText = diff.conflict_text">
                      {{ zh ? '填入冲突副本' : 'Conflict' }}
                    </DsButton>
                    <DsButton
                      variant="ghost"
                      size="sm"
                      @click="mergedText = buildInlineDiffMerge(diff.base_text, diff.conflict_text)"
                    >
                      {{ zh ? '拼接工作&冲突副本 (<<<<<<<<)' : 'Inline Merge (<<<<<<<<)' }}
                    </DsButton>
                  </div>
                </div>
                <textarea v-model="mergedText" class="scm__textarea" spellcheck="false" />
              </div>
            </div>

            <div class="scm__actions">
              <DsButton variant="ghost" size="sm" :disabled="resolving" @click="resolve('keep_base')">
                {{ zh ? '保留工作副本（删冲突副本）' : 'Keep Working Copy' }}
              </DsButton>
              <DsButton variant="ghost" size="sm" :disabled="resolving" @click="resolve('use_conflict')">
                {{ zh ? '采用冲突副本覆盖' : 'Use Conflict Copy' }}
              </DsButton>
              <DsButton
                variant="primary"
                size="sm"
                :disabled="resolving"
                @click="resolve('manual_merge')"
              >
                {{ zh ? '保存修复内容为工作副本（删冲突副本）' : 'Save Merged Result' }}
              </DsButton>
            </div>
          </template>
        </section>
      </div>
    </div>
  </DsModal>
</template>

<style scoped>
/* #687 — Fixed uniform modal height so switching conflicts or editing never jumps. */
.scm {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 78vh;
  min-height: 520px;
  max-height: 86vh;
}
.scm__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
}
.scm__summary {
  font-size: 12.5px;
  color: var(--text-2);
}
.scm__bar-actions {
  display: flex;
  gap: 6px;
}
.scm__empty {
  padding: 28px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--text-3);
}
.scm__body {
  display: flex;
  gap: 12px;
  min-height: 0;
  flex: 1;
}
.scm__list {
  width: 220px;
  flex-shrink: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-right: 1px solid var(--hairline);
  padding-right: 10px;
}
.scm__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
.scm__item:hover {
  background: var(--fill-1);
}
.scm__item.is-active {
  background: var(--accent-soft, rgba(59, 130, 246, 0.12));
  border-color: var(--accent);
}
.scm__item-base {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scm__item-conflict {
  font-size: 11px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scm__item-meta {
  font-size: 10.5px;
  color: var(--text-3);
}
.scm__detail {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.scm__paths {
  font-size: 11.5px;
  color: var(--text-2);
  background: var(--fill-1);
  border-radius: 6px;
  padding: 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  word-break: break-all;
  flex-shrink: 0;
}
.scm__paths code {
  font-family: var(--font-mono);
  font-size: 11px;
}
.scm__split {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
@media (max-width: 820px) {
  .scm__split {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
}
.scm__pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.scm__pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  flex-shrink: 0;
}
.scm__merge-tools {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.scm__diff {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: var(--bg);
  font-family: var(--font-mono);
  font-size: 12px;
}
.scm__hunk-head {
  padding: 3px 8px;
  font-size: 11px;
  color: var(--text-3);
  background: var(--fill-1);
  border-bottom: 1px solid var(--hairline);
}
.scm__line {
  margin: 0;
  padding: 1px 8px;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.45;
}
.scm__line--add {
  background: rgba(34, 197, 94, 0.14);
}
.scm__line--del {
  background: rgba(239, 68, 68, 0.14);
}
.scm__textarea {
  flex: 1;
  min-height: 0;
  width: 100%;
  resize: none;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.5;
}
.scm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--hairline);
  flex-shrink: 0;
}
</style>
