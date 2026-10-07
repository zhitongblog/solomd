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
import Icons from './Icons.vue';
import '../styles/panels.css';

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
      <Icons class="ghc__icon" name="info" :size="14" />
      <strong>{{ t('githubSync.conflictsHeading', { n: String(sync.status?.conflicts.length ?? 0) }) }}</strong>
    </div>
    <p class="ghc__intro">{{ t('githubSync.conflictsIntro') }}</p>

    <ul class="ghc__list">
      <li v-for="file in sync.status?.conflicts ?? []" :key="file" class="ghc__item">
        <div class="ghc__file" :title="file">{{ file }}</div>
        <div class="ghc__actions">
          <button
            class="rp-btn rp-btn--sm"
            :disabled="!!busy[file]"
            @click="resolve(file, 'local')"
          >
            {{ t('githubSync.useLocal') }}
          </button>
          <button
            class="rp-btn rp-btn--sm"
            :disabled="!!busy[file]"
            @click="resolve(file, 'remote')"
          >
            {{ t('githubSync.useRemote') }}
          </button>
          <button
            class="rp-btn rp-btn--sm"
            :disabled="!!busy[file]"
            @click="resolve(file, 'both')"
          >
            {{ t('githubSync.keepBoth') }}
          </button>
        </div>
      </li>
    </ul>

    <div v-if="(sync.status?.conflicts.length ?? 0) === 0 && (sync.status?.ahead ?? 0) > 0" class="ghc__push-row">
      <button class="rp-btn rp-btn--sm rp-btn--primary" @click="pushAfterResolve">
        {{ t('githubSync.pushAfterResolve') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.ghc {
  flex: 0 0 auto;
  margin: 0 8px 8px;
  padding: 10px 12px;
  border: var(--hair-w) solid color-mix(in srgb, var(--danger) 40%, transparent);
  border-radius: var(--r-lg);
  background: color-mix(in srgb, var(--danger) 6%, transparent);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ghc__header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text);
}
.ghc__header strong {
  font-weight: 600;
}
.ghc__icon {
  flex: 0 0 auto;
  color: var(--danger);
}
.ghc__intro {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-3);
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
  gap: 6px;
  padding: 8px;
  border: var(--bd-hair);
  border-radius: var(--r-md);
  background: var(--bg);
}
.ghc__file {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ghc__actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.ghc__push-row {
  margin-top: 2px;
}
</style>
