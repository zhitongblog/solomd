<script lang="ts">
export interface WhiteboardOpenDetail {
  /** Fence board id to edit. */
  boardId: string;
  /** Owning tab id (writeback target). */
  tabId: string;
  /** Initial snapshot JSON string. */
  snapshot: string;
}

export const WHITEBOARD_OPEN_EVENT = 'solomd:whiteboard-open';
</script>

<script setup lang="ts">
/**
 * WhiteboardOverlay — F7 fullscreen whiteboard editor.
 *
 * Opened by the `solomd:whiteboard-open` window event (dispatched from the
 * inline CM board widget's fullscreen button, or from a preview thumbnail
 * click). Mounts a full-window <Tldraw> editor via the dynamic-import runtime
 * adapter so the rest of the app still compiles without the tldraw dep, and
 * writes edits straight back into the owning tab's Markdown via
 * `replaceBoardSnapshot` (the same fence-splice path the inline widget uses) —
 * so the inline board, preview thumbnail, git history and disk all stay in
 * sync. Esc closes.
 */

import { onMounted, onBeforeUnmount, ref } from 'vue';
import { useI18n } from '../i18n';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { replaceBoardSnapshot, type BoardThemeTokens } from '../lib/tldraw-board';
import type { BoardHandle } from '../lib/tldraw-runtime';


const { t } = useI18n();
const settings = useSettingsStore();
const tabs = useTabsStore();

const open = ref(false);
const surface = ref<HTMLDivElement | null>(null);
let handle: BoardHandle | null = null;
let current: WhiteboardOpenDetail | null = null;

function theme(): BoardThemeTokens {
  return {
    colorScheme: settings.theme === 'dark' ? 'dark' : 'light',
    locale: settings.language || 'en',
  };
}

async function onOpen(e: Event) {
  const detail = (e as CustomEvent<WhiteboardOpenDetail>).detail;
  if (!detail) return;
  current = detail;
  open.value = true;
  // Wait a tick so the surface div renders, then mount the board.
  await Promise.resolve();
  requestAnimationFrame(async () => {
    if (!surface.value || !current) return;
    const { mountBoard } = await import('../lib/tldraw-runtime');
    handle = await mountBoard(surface.value, {
      snapshot: current.snapshot,
      theme: theme(),
      onSnapshotChange: (snapshotJson) => {
        if (!current) return;
        const tab = tabs.tabs.find((x) => x.id === current!.tabId);
        if (!tab) return;
        const next = replaceBoardSnapshot(tab.content || '', current.boardId, snapshotJson);
        if (next !== tab.content) tabs.setContent(current.tabId, next);
      },
    });
  });
}

function close() {
  open.value = false;
  current = null;
  try {
    handle?.destroy();
  } catch {
    /* already gone */
  }
  handle = null;
}

function onKeydown(e: KeyboardEvent) {
  if (open.value && e.key === 'Escape') {
    e.preventDefault();
    close();
  }
}

onMounted(() => {
  window.addEventListener(WHITEBOARD_OPEN_EVENT, onOpen);
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener(WHITEBOARD_OPEN_EVENT, onOpen);
  window.removeEventListener('keydown', onKeydown);
  close();
});
</script>

<template>
  <div v-if="open" class="wb-overlay">
    <div class="wb-overlay__bar">
      <button class="wb-overlay__close" @click="close">{{ t('whiteboard.closeFull') }}</button>
    </div>
    <div ref="surface" class="wb-overlay__surface"></div>
  </div>
</template>

<style scoped>
.wb-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  background: var(--bg);
  display: flex;
  flex-direction: column;
}
.wb-overlay__bar {
  display: flex;
  justify-content: flex-end;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft, var(--bg));
}
.wb-overlay__close {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}
.wb-overlay__close:hover {
  background: var(--bg-hover, var(--bg-soft));
}
.wb-overlay__surface {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}
</style>
