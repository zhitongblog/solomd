<script setup lang="ts">
/**
 * v3.0 — Network proxy settings (global, ~/.solomd/proxy).
 *
 * Conceptually network-level, not GitHub-specific — covers any
 * libgit2-backed remote (GitHub / GitLab / Gitea / custom). Lives at
 * the top of the 同步 (Sync) category so users hitting "Operation
 * timed out" find it before they think to dig into a sub-panel.
 *
 * Today this only affects libgit2 push/pull. If we ever route AI /
 * RAG / GitHub REST through reqwest with a proxy too, the same field
 * will drive that — store stays the same.
 */
import { onMounted, ref } from 'vue';
import { useGithubSyncStore } from '../stores/githubSync';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';

const sync = useGithubSyncStore();
const toasts = useToastsStore();
const { t } = useI18n();

const proxyUrl = ref('');
const saving = ref(false);

onMounted(async () => {
  try {
    proxyUrl.value = await sync.getProxy();
  } catch {
    /* file may not exist yet — empty default is fine */
  }
});

async function save() {
  saving.value = true;
  try {
    await sync.setProxy(proxyUrl.value);
    toasts.success(
      proxyUrl.value.trim()
        ? t('githubSync.proxySavedToast')
        : t('githubSync.proxyClearedToast'),
    );
  } catch (e) {
    toasts.error(String(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="proxy">
    <h3 class="proxy__heading">{{ t('githubSync.proxyTitle') }}</h3>
    <div class="proxy__row">
      <input
        v-model="proxyUrl"
        type="text"
        class="proxy__input"
        :placeholder="t('githubSync.proxyPlaceholder')"
        spellcheck="false"
      />
      <button class="proxy__btn" :disabled="saving" @click="save">
        {{ saving ? t('githubSync.proxySaving') : t('githubSync.proxySaveBtn') }}
      </button>
    </div>
    <p class="proxy__hint">{{ t('githubSync.proxyHint') }}</p>
  </section>
</template>

<style scoped>
.proxy {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.proxy__heading {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin: 18px 0 0;
}
.proxy__row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.proxy__input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 4px;
  font: inherit;
  font-size: 12px;
  font-family: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
}
.proxy__btn {
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  padding: 6px 12px;
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
}
.proxy__btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.proxy__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.proxy__hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.5;
}
</style>
