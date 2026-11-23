<script setup lang="ts">
import { useViewport } from '../composables/useViewport';
// A phone has no keyboard to press ↑↓ / ↵ / Esc with (and a touch emulator
// can report a fine pointer, so the CSS coarse-pointer rule alone missed it).
const { isNarrow } = useViewport();
/**
 * Global workspace search — persistent right-sidebar pane (v4.0.2).
 *
 * Earlier versions opened as a modal dialog over the editor. The persistent
 * panel layout — contributed by @beihai23 in PR #50 — keeps results visible
 * while the user clicks through matches, which fits the search-browse-compare
 * workflow common in knowledge-base editing.
 *
 * Mounts when the parent renders the 'search' pane in the rs-pane-host stack;
 * unmounts on close. ⌘⇧F toggles the parent's `searchOpen` ref.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useGlobalSearch, type SearchHit } from '../composables/useGlobalSearch';
import { useFiles } from '../composables/useFiles';
import { useTabsStore } from '../stores/tabs';
import { useTilesStore } from '../stores/tiles';
import { useWorkspaceStore } from '../stores/workspace';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';
import { useSettingsStore } from '../stores/settings';
import { useI18n } from '../i18n';
import Icons from './Icons.vue';

const props = defineProps<{ prefill?: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const search = useGlobalSearch();
const files = useFiles();
const tabs = useTabsStore();
const tiles = useTilesStore();
const workspace = useWorkspaceStore();
const wsIndex = useWorkspaceIndexStore();
const settings = useSettingsStore();
const { t } = useI18n();

const query = ref('');
const titleOnly = ref(false);
const expandedModal = ref(false);
const hits = ref<SearchHit[]>([]);
const loading = ref(false);
const selectedIdx = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const activeFilePath = computed(() => tabs.activeTab?.filePath ?? '');
const titleOnlyLabel = computed(() =>
  settings.language?.startsWith('zh') ? '仅标题' : 'Title',
);
const titleOnlyTip = computed(() =>
  settings.language?.startsWith('zh') ? '仅搜索笔记文件名与标题' : 'Search note titles and filenames only',
);

let debounceTimer: number | null = null;

onMounted(async () => {
  if (props.prefill) {
    query.value = props.prefill;
  }
  await nextTick();
  inputRef.value?.focus();
  if (query.value) doSearch();
});

watch(
  () => props.prefill,
  async (v) => {
    if (v && v !== query.value) {
      query.value = v;
      await nextTick();
      inputRef.value?.focus();
    }
  },
);

watch([query, titleOnly], () => {
  if (debounceTimer != null) {
    window.clearTimeout(debounceTimer);
  }
  debounceTimer = window.setTimeout(doSearch, 220);
});

onBeforeUnmount(() => {
  if (debounceTimer != null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  // #656 — Clear lingering editor match highlights when search panel closes.
  window.dispatchEvent(new CustomEvent('solomd:clear-search-highlight'));
});

const TITLE_HIT_CAP = 200;
let searchReqSeq = 0;

async function doSearch() {
  const q = query.value.trim();
  const reqId = ++searchReqSeq;
  if (!q) {
    hits.value = [];
    loading.value = false;
    window.dispatchEvent(new CustomEvent('solomd:clear-search-highlight'));
    return;
  }
  loading.value = true;
  try {
    let nextHits: SearchHit[];
    if (titleOnly.value) {
      const qLower = q.toLowerCase();
      const matched: SearchHit[] = [];
      const seenFiles = new Set<string>();
      for (const entry of wsIndex.entries) {
        if (matched.length >= TITLE_HIT_CAP) break;
        const displayTitle = entry.title || entry.headings?.[0] || entry.name;
        if (
          entry.name.toLowerCase().includes(qLower) ||
          entry.stem.toLowerCase().includes(qLower) ||
          displayTitle.toLowerCase().includes(qLower)
        ) {
          seenFiles.add(entry.path);
          matched.push({
            file: entry.path,
            line: 1,
            snippet: displayTitle,
          });
        }
      }
      if (matched.length === 0) {
        const rawHits = await search.search(q);
        if (reqId !== searchReqSeq) return;
        for (const h of rawHits) {
          if (matched.length >= TITLE_HIT_CAP) break;
          const base = h.file.split(/[\\/]/).pop() ?? h.file;
          const isHeading = /^#{1,6}\s+/.test(h.snippet.trim());
          if (
            !seenFiles.has(h.file) &&
            (base.toLowerCase().includes(qLower) || isHeading)
          ) {
            seenFiles.add(h.file);
            matched.push(h);
          }
        }
      }
      nextHits = matched;
    } else {
      const tagMatch = q.match(/^(?:#|tag:#?)([^\s#]+)$/i);
      const wantedTag = tagMatch ? tagMatch[1] : null;
      nextHits = await search.search(wantedTag ? `#${wantedTag}` : q);
      if (reqId !== searchReqSeq) return;
      // #648 — When searching for a `#tag` or `tag:name`, also surface notes whose
      // YAML frontmatter `tags:` / `tag:` metadata matches (frontmatter tags are
      // typically written without `#`, so literal text search for `#tag` misses them).
      if (wantedTag) {
        const needle = wantedTag.toLowerCase();
        const tagTokenRe = new RegExp(
          `(^|[\\s([{\"'،、，。；：！？])#${escapeRe(wantedTag)}(?:\\/[\\p{L}\\p{N}_-]+)*(?=$|[\\s)\\]}\"'.,;:!?،、，。；：！？])`,
          'iu',
        );
        const seenTagFiles = new Set(
          nextHits.filter((h) => tagTokenRe.test(h.snippet)).map((h) => h.file),
        );
        const fmHits: SearchHit[] = [];
        for (const entry of wsIndex.entries) {
          if (seenTagFiles.has(entry.path) || !entry.tags?.length) continue;
          const matchedTags = entry.tags.filter((tg) => {
            const tl = tg.toLowerCase();
            return tl === needle || tl.startsWith(`${needle}/`);
          });
          if (matchedTags.length > 0) {
            seenTagFiles.add(entry.path);
            fmHits.push({
              file: entry.path,
              line: 1,
              snippet: `tags: ${matchedTags.map((tg) => `#${tg}`).join(' ')}`,
            });
          }
        }
        if (fmHits.length > 0) {
          nextHits = [...fmHits, ...nextHits];
        }
      }
    }
    hits.value = nextHits;
    selectedIdx.value = 0;
  } finally {
    if (reqId === searchReqSeq) {
      loading.value = false;
    }
  }
}

const grouped = computed(() => {
  const map = new Map<string, Array<{ hit: SearchHit; idx: number }>>();
  const list = hits.value;
  for (let idx = 0; idx < list.length; idx++) {
    const h = list[idx];
    let group = map.get(h.file);
    if (!group) {
      group = [];
      map.set(h.file, group);
    }
    group.push({ hit: h, idx });
  }
  return Array.from(map.entries());
});

function shortPath(p: string) {
  const folder = workspace.currentFolder;
  if (folder && p.startsWith(folder)) {
    return p.slice(folder.length).replace(/^[\\/]/, '');
  }
  return p.split(/[\\/]/).slice(-2).join('/');
}

async function openHit(hit: SearchHit) {
  try {
    const rawQ = query.value.trim();
    const tagBare = rawQ.match(/^(?:#|tag:#?)([^\s#]+)$/i)?.[1];
    const highlightQuery = titleOnly.value
      ? ''
      : hit.line === 1 && hit.snippet.startsWith('tags: ') && tagBare
        ? tagBare
        : rawQ;
    await files.openPath(hit.file);
    await nextTick();
    window.dispatchEvent(
      new CustomEvent('solomd:outline-goto', {
        detail: {
          line: hit.line,
          paneId: tiles.focusedPaneId,
          query: highlightQuery,
        },
      }),
    );
  } catch (e) {
    console.error('GlobalSearch: openPath failed', e);
  }
}

function highlight(snippet: string): string {
  const q = query.value.trim();
  if (!q) return escapeHtml(snippet);
  // #648 — Normalize `tag:foo` / `tag:#foo` so `#foo` or `foo` highlights cleanly in snippets.
  const tagQ = q.match(/^tag:#?([^\s#]+)$/i)?.[1];
  const pattern = tagQ ? `#?${escapeRe(tagQ)}` : escapeRe(q);
  // Match against the raw text BEFORE HTML-escaping so queries like `a`, `&`,
  // `<`, or `;` never slice inside `&amp;` / `&lt;` entities!
  const re = new RegExp(pattern, 'gi');
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    out += escapeHtml(snippet.slice(last, m.index));
    out += `<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  out += escapeHtml(snippet.slice(last));
  return out;
}

function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c),
  );
}
function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function onKey(e: KeyboardEvent) {
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
</script>

<template>
  <div class="sp" :class="{ 'sp--expanded': expandedModal }">
    <header class="sp__head">
      <span class="sp__title">{{ t('search.heading') }}</span>
      <div class="sp__head-actions">
        <button
          class="rs-pane-close"
          type="button"
          :title="settings.language?.startsWith('zh') ? (expandedModal ? '收起为侧栏' : '展开为居中大窗') : (expandedModal ? 'Dock to sidebar' : 'Expand to modal view')"
          @click="expandedModal = !expandedModal"
        >{{ expandedModal ? '⤡' : '⤢' }}</button>
        <button
          class="rs-pane-close"
          type="button"
          :title="t('rightSidebar.hidePane')"
          @click="emit('close')"
        >×</button>
      </div>
    </header>
    <div class="sp__input-wrap">
      <Icons class="sp__input-icon" name="search" :size="14" aria-hidden="true" />
      <input
        ref="inputRef"
        v-model="query"
        class="sp__input"
        :placeholder="t('search.placeholder')"
        spellcheck="false"
        @keydown="onKey"
      />
      <button
        type="button"
        class="sp__mode-btn"
        :class="{ 'sp__mode-btn--active': titleOnly }"
        :title="titleOnlyTip"
        :aria-pressed="titleOnly"
        @click="titleOnly = !titleOnly"
      >{{ titleOnlyLabel }}</button>
      <span v-if="loading" class="sp__loading">…</span>
    </div>
    <div v-if="!workspace.currentFolder" class="sp__empty">
      {{ t('search.openFolder') }}
    </div>
    <div v-else-if="!query.trim()" class="sp__empty">
      {{ t('search.typeToSearch') }}
    </div>
    <div v-else-if="!hits.length && !loading" class="sp__empty">
      {{ t('search.noMatches') }}
    </div>
    <div v-else class="sp__results">
      <div v-for="[file, fileHits] in grouped" :key="file" class="sp__group">
        <div
          class="sp__file"
          :class="{ 'sp__file--active': file === activeFilePath }"
        >{{ shortPath(file) }}</div>
        <div
          v-for="item in fileHits"
          :key="item.idx"
          class="sp__hit"
          :class="{ 'sp__hit--active': item.idx === selectedIdx }"
          @click="openHit(item.hit)"
          @mouseenter="selectedIdx = item.idx"
        >
          <span class="sp__lineno">L{{ item.hit.line }}</span>
          <span class="sp__snippet" v-html="highlight(item.hit.snippet)"></span>
        </div>
      </div>
    </div>
    <div class="sp__footer">
      <span>{{ t('search.hitCount', { n: hits.length }) }}</span>
      <span v-if="!isNarrow" class="key-hint">{{ t('search.keyHint') }}</span>
    </div>
  </div>
</template>

<style scoped>
.sp {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  overflow: hidden;
}
.sp--expanded {
  position: fixed;
  top: 8vh;
  left: 50%;
  transform: translateX(-50%);
  width: min(760px, 92vw);
  height: min(640px, 82vh);
  z-index: var(--z-modal, 200);
  border: 1px solid var(--border);
  border-radius: var(--r-lg, 12px);
  box-shadow: var(--sh-pop, 0 20px 50px rgba(0, 0, 0, 0.35));
}
.sp__head-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.sp__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
}
.sp__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
/* 5.0 search field: a --fill-1 well (radius 8) with a leading icon, the
   same look as the sidebar search and the command palette's input row. */
.sp__input-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  margin: 8px 10px;
  padding: 0 10px;
  border-radius: var(--r-md);
  background: var(--fill-1);
  color: var(--text-3);
}
.sp__input-wrap:focus-within {
  background: var(--bg);
  box-shadow: var(--ring);
}
.sp__input-icon {
  flex: none;
}
.sp__input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  padding: 0;
  font: 13px var(--font-ui);
  color: var(--text);
}
.sp__input::placeholder {
  color: var(--text-3);
}
.sp__mode-btn {
  flex: none;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  font: 11px var(--font-ui);
  cursor: pointer;
  transition: all 0.15s;
}
.sp__mode-btn:hover {
  color: var(--text);
  border-color: var(--text-3);
}
.sp__mode-btn--active {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: var(--accent);
  font-weight: 600;
}
.sp__loading {
  color: var(--accent);
  font-size: 14px;
}
.sp__empty {
  padding: 24px 16px;
  color: var(--text-faint);
  text-align: center;
  font-size: 12px;
  line-height: 1.6;
}
.sp__results {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.sp__group {
  margin-bottom: 4px;
}
.sp__file {
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.sp__file--active {
  position: relative;
}
.sp__file--active::after {
  content: ' ●';
  font-size: 8px;
  vertical-align: middle;
}
.sp__hit {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 12px 5px 20px;
  font-size: 12px;
  cursor: pointer;
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background 0.1s;
}
.sp__hit:hover,
.sp__hit--active {
  background: var(--bg-hover, rgba(255, 159, 64, 0.12));
}
.sp__lineno {
  color: var(--text-faint);
  flex-shrink: 0;
  font-size: 10px;
  width: 32px;
}
.sp__snippet {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp__snippet :deep(mark) {
  background: var(--accent, #ff9f40);
  color: #fff;
  padding: 0 2px;
  border-radius: 2px;
}
.sp__footer {
  display: flex;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: 10px;
  color: var(--text-faint);
  border-top: 1px solid var(--border);
}
</style>
