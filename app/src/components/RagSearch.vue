<script setup lang="ts">
/**
 * v2.3 Local RAG / semantic-search panel.
 *
 * Opens on ⌘⇧F when `settings.ragEnabled` is on. Talks to the Rust
 * `rag` module via `useRagStore`. Same modal shape as GlobalSearch so
 * the muscle-memory carries over — but ranks by cosine similarity, not
 * substring match.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { useRagStore, type RagHit } from '../stores/rag';
import { useFiles } from '../composables/useFiles';
import { useWorkspaceStore } from '../stores/workspace';
import { useSettingsStore } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';
import Icons from './Icons.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'open-settings'): void }>();

const { t } = useI18n();
const rag = useRagStore();
const toasts = useToastsStore();
const files = useFiles();
const workspace = useWorkspaceStore();
const settings = useSettingsStore();

const query = ref('');
const hits = ref<RagHit[]>([]);
const selectedIdx = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
let debounceTimer: number | null = null;

watch(
  () => props.open,
  async (v) => {
    if (v) {
      await nextTick();
      inputRef.value?.focus();
      // Refresh status when opened so the "X of Y indexed" line is fresh.
      await rag.refreshStatus(workspace.currentFolder);
      if (query.value) doSearch();
    }
  }
);

watch(query, () => {
  if (debounceTimer != null) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(doSearch, 220);
});

// #92 — keep the keyboard-selected hit scrolled into view, matching the
// CommandPalette / QuickSwitcher behaviour (arrow-down past the fold was
// hiding the highlighted result here).
watch(selectedIdx, async () => {
  await nextTick();
  const item = document.querySelectorAll<HTMLElement>('.rag__results .rag__hit')[selectedIdx.value];
  item?.scrollIntoView({ block: 'nearest' });
});

async function doSearch() {
  const q = query.value.trim();
  if (!q) {
    hits.value = [];
    return;
  }
  hits.value = await rag.search(workspace.currentFolder, q, 20);
  selectedIdx.value = 0;
}

function shortPath(p: string) {
  const folder = workspace.currentFolder;
  if (folder && p.startsWith(folder)) {
    return p.slice(folder.length).replace(/^[\\/]/, '');
  }
  return p.split(/[\\/]/).slice(-2).join('/');
}

async function openHit(hit: RagHit) {
  emit('close');
  await files.openPath(hit.path);
  // Best-effort: scroll to the chunk's char offset. PaneContent listens
  // for this event and seeks the editor cursor.
  window.dispatchEvent(
    new CustomEvent('solomd:rag-goto', {
      detail: { path: hit.path, charStart: hit.char_start, charEnd: hit.char_end },
    })
  );
}

async function onReindex() {
  await rag.reindex(workspace.currentFolder);
  if (rag.lastError) {
    toasts.error(`RAG reindex failed: ${rag.lastError}`);
    return;
  }
  toasts.success(t('toast.reindexed', { n: rag.status?.indexed_files ?? 0 }));
  if (query.value) doSearch();
}

function onKey(e: KeyboardEvent) {
  // CJK/IME guard — see CommandPalette.vue for rationale.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIdx.value = Math.min(selectedIdx.value + 1, hits.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIdx.value = Math.max(selectedIdx.value - 1, 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const hit = hits.value[selectedIdx.value];
    if (hit) openHit(hit);
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
  );
}

const indexLine = computed(() => {
  const st = rag.status;
  if (!st) return '';
  if (st.indexed_files === 0) return t('rag.notIndexed');
  return t('rag.indexedCounter', {
    indexed: String(st.indexed_files),
    total: String(st.total_files),
    chunks: String(st.total_chunks),
  });
});

const scoreColor = (score: number) => {
  // Map cosine [-1,1] → opacity; we mostly see [0, 0.6] in practice.
  const clamped = Math.max(0, Math.min(1, score * 1.3));
  return `rgba(var(--accent-rgb, 255, 159, 64), ${0.35 + clamped * 0.65})`;
};
</script>

<template>
  <Teleport to="body">
  <div v-if="open" class="rag__backdrop" @click.self="emit('close')">
    <div class="rag" role="dialog" aria-label="Semantic search">
      <div class="rag__header">
        <Icons class="rag__icon" name="search" :size="16" aria-hidden="true" />
        <input
          ref="inputRef"
          v-model="query"
          @keydown="onKey"
          class="rag__input"
          :placeholder="t('rag.placeholder')"
          spellcheck="false"
        />
        <span v-if="rag.searching" class="rag__loading">…</span>
      </div>

      <div v-if="!settings.ragEnabled" class="rag__empty">
        <p>{{ t('rag.disabledHeading') }}</p>
        <button class="rag__btn rag__btn--primary" @click="emit('open-settings')">
          {{ t('rag.openSettings') }}
        </button>
      </div>
      <div v-else-if="!workspace.currentFolder" class="rag__empty">
        {{ t('rag.openFolder') }}
      </div>
      <div v-else-if="!rag.status?.ready" class="rag__empty">
        <p>{{ t('rag.notIndexed') }}</p>
        <button
          class="rag__btn rag__btn--primary"
          :disabled="rag.indexing"
          @click="onReindex"
        >
          {{ rag.indexing ? t('rag.indexing') : t('rag.buildIndex') }}
        </button>
      </div>
      <div v-else-if="!query.trim()" class="rag__empty">
        <p>{{ t('rag.tryQueries') }}</p>
        <p class="rag__status">{{ indexLine }}</p>
      </div>
      <div v-else-if="!hits.length && !rag.searching" class="rag__empty">
        {{ t('rag.noResults') }}
      </div>
      <div v-else class="rag__results">
        <div
          v-for="(hit, i) in hits"
          :key="hit.path + ':' + hit.chunk_idx"
          class="rag__hit"
          :class="{ 'rag__hit--active': i === selectedIdx }"
          @click="openHit(hit)"
          @mouseenter="selectedIdx = i"
        >
          <div class="rag__hit-row1">
            <span
              class="rag__score"
              :style="{ background: scoreColor(hit.score) }"
              :title="`cosine ${hit.score.toFixed(3)}`"
            >
              {{ hit.score.toFixed(2) }}
            </span>
            <span class="rag__hit-name">{{ hit.name }}</span>
            <span class="rag__hit-path">{{ shortPath(hit.path) }}</span>
          </div>
          <div class="rag__hit-snippet" v-html="escapeHtml(hit.snippet)"></div>
        </div>
      </div>

      <div class="rag__footer">
        <span v-if="rag.status?.ready">{{ indexLine }}</span>
        <span v-else></span>
        <span class="rag__hints">
          <span class="key-hint">{{ t('rag.hintNav') }}</span>
          <button
            class="rag__btn rag__btn--small"
            :disabled="rag.indexing"
            @click="onReindex"
          >
            {{ rag.indexing ? t('rag.indexing') : t('rag.reindex') }}
          </button>
        </span>
      </div>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
/* 5.0 — the semantic-search palette: same frame as the command palette
   (radius 12, --sh-modal, 44px input row with an icon, 15px text), wider
   because each hit carries a snippet. */
.rag__backdrop {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
  z-index: var(--z-modal);
  animation: sm-fade-in var(--dur) var(--ease-out);
}
.rag {
  width: min(720px, calc(100vw - 32px));
  max-height: 72vh;
  background: var(--bg-pop);
  color: var(--text);
  border: var(--bd-hair);
  border-radius: 12px;
  box-shadow: var(--sh-modal);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transform-origin: top center;
  animation: sm-dialog-in var(--dur) var(--ease-out);
}
.rag__header {
  display: flex;
  align-items: center;
  flex: none;
  height: 44px;
  border-bottom: var(--bd-hair);
  padding: 0 16px;
  gap: 10px;
  color: var(--text-3);
}
.rag__icon {
  display: inline-flex;
  flex: none;
  color: var(--text-3);
}
.rag__input {
  flex: 1;
  min-width: 0;
  height: 100%;
  background: transparent;
  border: none;
  outline: none;
  padding: 0;
  font: 15px var(--font-ui);
  color: var(--text);
}
.rag__input::placeholder {
  color: var(--text-3);
}
.rag__loading {
  color: var(--text-3);
  font-size: 15px;
}
.rag__empty {
  padding: 28px 24px;
  color: var(--text-3);
  text-align: center;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}
.rag__empty p {
  margin: 0;
  line-height: 1.6;
}
.rag__status {
  font-size: 12px;
  color: var(--text-3);
}
.rag__results {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.rag__hit {
  padding: 8px 10px;
  border-radius: 7px;
  cursor: default;
}
.rag__hit:hover,
.rag__hit--active {
  background: var(--fill-2);
}
.rag__hit-row1 {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 3px;
}
.rag__score {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--accent-strong-fg);
  background: var(--accent-strong);
  padding: 1px 6px;
  border-radius: var(--r-full);
  min-width: 34px;
  text-align: center;
  flex-shrink: 0;
}
.rag__hit-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.rag__hit-path {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  text-align: right;
}
.rag__hit-snippet {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.rag__footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  font-size: 12px;
  color: var(--text-3);
  border-top: var(--bd-hair);
  gap: 10px;
}
.rag__hints {
  display: flex;
  align-items: center;
  gap: 12px;
}
.rag__btn {
  height: 32px;
  border: 0;
  background: var(--fill-1);
  color: var(--text);
  padding: 0 14px;
  font: inherit;
  font-size: 13px;
  font-weight: 560;
  border-radius: var(--r-md);
  cursor: default;
}
.rag__btn:hover:not(:disabled) {
  background: var(--fill-2);
}
.rag__btn:disabled {
  opacity: 0.5;
  cursor: progress;
}
.rag__btn--primary,
.rag__btn--primary:hover:not(:disabled) {
  background: var(--accent-strong);
  color: var(--accent-strong-fg);
}
.rag__btn--small {
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
}
@media (prefers-reduced-motion: reduce) {
  .rag__backdrop,
  .rag {
    animation: none;
  }
}
</style>
