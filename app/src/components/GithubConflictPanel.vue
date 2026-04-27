<script setup lang="ts">
/**
 * GithubConflictPanel — surfaced from the History panel when
 * `sync.status.has_conflicts` is true.
 *
 * Renders one row per conflicting file with three resolution choices:
 *   - "Use mine"     → discard remote, keep local
 *   - "Use GitHub"   → overwrite local with remote
 *   - "Keep both"    → write the remote alongside as `<stem>.remote-<date>.<ext>`
 *
 * After every resolve the Rust side re-runs `git status` so the panel
 * automatically empties when the last conflict is gone.
 */
import { ref } from 'vue';
import { useGithubSyncStore } from '../stores/githubSync';
import { useWorkspaceStore } from '../stores/workspace';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

const sync = useGithubSyncStore();
const workspace = useWorkspaceStore();
const toasts = useToastsStore();
const { t } = useI18n();

const busy = ref<Record<string, boolean>>({});

async function resolve(file: string, choice: 'local' | 'remote' | 'both') {
  if (!workspace.currentFolder) return;
  busy.value[file] = true;
  try {
    await sync.resolveConflict(workspace.currentFolder, file, choice);
    toasts.success(t('githubSync.conflictResolvedToast', { file }));
    // If that was the last one, signal the editor to reload from disk —
    // the file content may have changed under any open tab.
    window.dispatchEvent(new CustomEvent('solomd:remote-pulled'));
  } catch (e) {
    toasts.error(`${t('githubSync.conflictResolveFailed')}: ${e}`);
  } finally {
    delete busy.value[file];
  }
}

async function pushAfterResolve() {
  if (!workspace.currentFolder) return;
  try {
    await sync.push(workspace.currentFolder);
    toasts.success(t('githubSync.pushedToast'));
  } catch (e) {
    toasts.error(`${t('githubSync.pushFailed')}: ${e}`);
  }
}
</script>

<template>
  <section v-if="sync.hasConflicts" class="ghc">
    <div class="ghc__header">
      <span class="ghc__icon">⚠</span>
      <strong>{{ t('githubSync.conflictsHeading', { n: String(sync.status?.conflicts.length ?? 0) }) }}</strong>
    </div>
    <p class="ghc__intro">{{ t('githubSync.conflictsIntro') }}</p>

    <ul class="ghc__list">
      <li v-for="file in sync.status?.conflicts ?? []" :key="file" class="ghc__item">
        <div class="ghc__file" :title="file">{{ file }}</div>
        <div class="ghc__actions">
          <button
            class="ghc__btn"
            :disabled="!!busy[file]"
            @click="resolve(file, 'local')"
          >
            {{ t('githubSync.useLocal') }}
          </button>
          <button
            class="ghc__btn"
            :disabled="!!busy[file]"
            @click="resolve(file, 'remote')"
          >
            {{ t('githubSync.useRemote') }}
          </button>
          <button
            class="ghc__btn"
            :disabled="!!busy[file]"
            @click="resolve(file, 'both')"
          >
            {{ t('githubSync.keepBoth') }}
          </button>
        </div>
      </li>
    </ul>

    <div v-if="(sync.status?.conflicts.length ?? 0) === 0 && (sync.status?.ahead ?? 0) > 0" class="ghc__push-row">
      <button class="ghc__btn ghc__btn--primary" @click="pushAfterResolve">
        {{ t('githubSync.pushAfterResolve') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.ghc {
  border: 1px solid #d12;
  background: rgba(221, 17, 34, 0.04);
  border-radius: 6px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ghc__header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text);
}
.ghc__icon {
  color: #d12;
}
.ghc__intro {
  font-size: 11px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.5;
}
.ghc__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ghc__item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  border-radius: 4px;
}
.ghc__file {
  font-size: 11px;
  color: var(--text);
  font-family: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ghc__actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.ghc__btn {
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  padding: 4px 9px;
  font-size: 10px;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
}
.ghc__btn:hover:not(:disabled) {
  background: var(--bg-active, var(--bg-elev));
}
.ghc__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ghc__btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text, #000);
}
.ghc__push-row {
  margin-top: 4px;
}
</style>
