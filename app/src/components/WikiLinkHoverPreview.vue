<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../stores/workspace';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';
import { useSettingsStore } from '../stores/settings';
import { useFiles } from '../composables/useFiles';
import { renderMarkdown } from '../lib/markdown';
import { isMobile } from '../lib/platform';

interface PreviewEntry {
  path: string;
  title: string;
  relPath: string;
  html: string;
  fetchedAt: number;
}

const CACHE_TTL_MS = 15_000;
const MAX_CACHE = 40;
const HOVER_DELAY_MS = 280;
const HIDE_DELAY_MS = 180;

const workspace = useWorkspaceStore();
const workspaceIndex = useWorkspaceIndexStore();
const settings = useSettingsStore();
const files = useFiles();

const visible = ref(false);
const loading = ref(false);
const entry = ref<PreviewEntry | null>(null);
const pos = ref({ left: 16, top: 16 });

const cache = new Map<string, PreviewEntry>();
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let activeTargetEl: HTMLElement | null = null;
let insidePopover = false;
let reqSeq = 0;

function clearTimers() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function parseWikiTarget(raw: string): string {
  const withoutAlias = raw.split('|')[0] ?? '';
  const withoutHeading = withoutAlias.split('#')[0] ?? '';
  return withoutHeading.trim();
}

function relativeLabel(absPath: string): string {
  const root = workspace.currentFolder;
  if (!root) return absPath;
  const normRoot = root.replace(/[\\/]+$/, '');
  if (absPath.startsWith(normRoot + '/') || absPath.startsWith(normRoot + '\\')) {
    return absPath.slice(normRoot.length + 1).replace(/\\/g, '/');
  }
  return absPath.split(/[\\/]/).pop() || absPath;
}

function computePosition(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const cardW = 380;
  const cardH = 260;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = rect.left;
  if (left + cardW + 16 > vw) left = Math.max(12, vw - cardW - 16);
  let top = rect.bottom + 8;
  if (top + cardH + 16 > vh && rect.top - cardH - 12 > 12) {
    top = rect.top - cardH - 8;
  }
  pos.value = { left: Math.round(left), top: Math.round(Math.max(12, top)) };
}

async function loadPreview(rawTarget: string, anchor: HTMLElement) {
  const seq = ++reqSeq;
  const target = parseWikiTarget(rawTarget);
  if (!target) return;

  const resolved = await workspaceIndex.resolve(target);
  if (seq !== reqSeq || !resolved) {
    if (seq === reqSeq) visible.value = false;
    return;
  }

  computePosition(anchor);

  const cached = cache.get(resolved);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    entry.value = cached;
    loading.value = false;
    visible.value = true;
    return;
  }

  loading.value = true;
  visible.value = true;
  try {
    const res = await invoke<{ content: string }>('read_file', { path: resolved });
    if (seq !== reqSeq) return;
    const raw = (res?.content || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    const excerpt = raw.split(/\r?\n/).slice(0, 32).join('\n');
    const html = renderMarkdown(excerpt || '*Empty note*');
    const title = resolved.split(/[\\/]/).pop()?.replace(/\.md$/i, '') || target;
    const built: PreviewEntry = {
      path: resolved,
      title,
      relPath: relativeLabel(resolved),
      html,
      fetchedAt: Date.now(),
    };
    if (cache.size >= MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(resolved, built);
    entry.value = built;
  } catch {
    if (seq === reqSeq) visible.value = false;
  } finally {
    if (seq === reqSeq) loading.value = false;
  }
}

function scheduleHide() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!insidePopover) {
      visible.value = false;
      activeTargetEl = null;
    }
  }, HIDE_DELAY_MS);
}

function onMouseOver(ev: MouseEvent) {
  if (isMobile()) return;
  const el = (ev.target as Element | null)?.closest?.(
    '.cm-wikilink, .md-wikilink',
  ) as HTMLElement | null;
  if (!el) return;
  if (el === activeTargetEl && visible.value) {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    return;
  }
  const raw =
    el.getAttribute('data-wikilink-target') ||
    el.getAttribute('data-wikilink') ||
    '';
  if (!raw) return;
  activeTargetEl = el;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (showTimer) clearTimeout(showTimer);
  showTimer = setTimeout(() => {
    void loadPreview(raw, el);
  }, HOVER_DELAY_MS);
}

function onMouseOut(ev: MouseEvent) {
  const from = (ev.target as Element | null)?.closest?.('.cm-wikilink, .md-wikilink');
  if (!from) return;
  const to = ev.relatedTarget as Element | null;
  if (to && (from.contains(to) || to.closest?.('.wikilink-hover-card'))) return;
  scheduleHide();
}

function onPopoverEnter() {
  insidePopover = true;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function onPopoverLeave() {
  insidePopover = false;
  scheduleHide();
}

function onKeyDown(ev: KeyboardEvent) {
  if (ev.key === 'Escape' && visible.value) {
    clearTimers();
    visible.value = false;
    activeTargetEl = null;
  }
}

async function openPreviewNote() {
  const target = entry.value?.path;
  if (!target) return;
  visible.value = false;
  activeTargetEl = null;
  await files.openPath(target);
}

onMounted(() => {
  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('mouseout', onMouseOut, true);
  window.addEventListener('keydown', onKeyDown);
});

onBeforeUnmount(() => {
  clearTimers();
  document.removeEventListener('mouseover', onMouseOver, true);
  document.removeEventListener('mouseout', onMouseOut, true);
  window.removeEventListener('keydown', onKeyDown);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="wikilink-hover-card"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
      @mouseenter="onPopoverEnter"
      @mouseleave="onPopoverLeave"
    >
      <div class="wikilink-hover-card__header">
        <div class="wikilink-hover-card__titles">
          <div class="wikilink-hover-card__title">{{ entry?.title || '…' }}</div>
          <div v-if="entry?.relPath" class="wikilink-hover-card__path">{{ entry.relPath }}</div>
        </div>
        <button
          v-if="entry"
          type="button"
          class="wikilink-hover-card__open"
          @click="openPreviewNote"
        >
          {{ settings.language === 'zh' ? '打开' : 'Open' }}
        </button>
      </div>
      <div v-if="loading" class="wikilink-hover-card__loading">
        {{ settings.language === 'zh' ? '正在加载预览…' : 'Loading preview…' }}
      </div>
      <div
        v-else-if="entry"
        class="wikilink-hover-card__body preview-content"
        v-html="entry.html"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.wikilink-hover-card {
  position: fixed;
  z-index: 950;
  width: 380px;
  max-width: calc(100vw - 24px);
  max-height: 280px;
  display: flex;
  flex-direction: column;
  background: var(--bg-elev, var(--bg));
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
  overflow: hidden;
  font-size: 13px;
}
.wikilink-hover-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev, var(--bg)) 85%, var(--bg));
}
.wikilink-hover-card__titles {
  min-width: 0;
  flex: 1;
}
.wikilink-hover-card__title {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wikilink-hover-card__path {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wikilink-hover-card__open {
  flex-shrink: 0;
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--accent-text, var(--accent));
  cursor: pointer;
}
.wikilink-hover-card__open:hover {
  border-color: var(--accent);
}
.wikilink-hover-card__loading {
  padding: 16px 12px;
  color: var(--text-muted);
  font-size: 12px;
}
.wikilink-hover-card__body {
  padding: 10px 14px;
  overflow-y: auto;
  font-size: 12.5px;
  line-height: 1.55;
  max-width: none;
  margin: 0;
}
.wikilink-hover-card__body :deep(h1) { font-size: 1.25em; margin: 0.4em 0; }
.wikilink-hover-card__body :deep(h2) { font-size: 1.12em; margin: 0.4em 0; }
.wikilink-hover-card__body :deep(p) { margin: 0.45em 0; }
.wikilink-hover-card__body :deep(img) { max-width: 100%; height: auto; border-radius: 4px; }
</style>
