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
const loading = ref(false);
const surface = ref<HTMLDivElement | null>(null);
let handle: BoardHandle | null = null;
let current: WhiteboardOpenDetail | null = null;
// Bumped on every open/close so a slow async mount that resolves after the
// overlay was re-opened (or closed) tears itself down instead of leaking a
// second tldraw React root onto the surface.
let mountToken = 0;

function theme(): BoardThemeTokens {
  return {
    colorScheme: settings.theme === 'dark' ? 'dark' : 'light',
    locale: settings.language || 'en',
  };
}

async function onOpen(e: Event) {
  const detail = (e as CustomEvent<WhiteboardOpenDetail>).detail;
  if (!detail) return;
  // Re-opening while a board is live: tear the old one down first.
  if (handle) {
    try {
      handle.destroy();
    } catch {
      /* already gone */
    }
    handle = null;
  }
  current = detail;
  open.value = true;
  loading.value = true;
  const token = ++mountToken;
  // Wait a tick so the surface div renders, then mount the board.
  await Promise.resolve();
  requestAnimationFrame(async () => {
    if (token !== mountToken || !surface.value || !current) return;
    try {
      const { mountBoard } = await import('../lib/tldraw-runtime');
      const mounted = await mountBoard(surface.value, {
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
      // The overlay was closed / re-opened while tldraw was loading — discard.
      if (token !== mountToken) {
        try {
          mounted.destroy();
        } catch {
          /* no-op */
        }
        return;
      }
      handle = mounted;
    } catch {
      /* mount failed (corrupt snapshot / dep) — leave the empty surface */
    } finally {
      if (token === mountToken) loading.value = false;
    }
  });
}

function close() {
  mountToken++;
  open.value = false;
  loading.value = false;
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
      <span class="wb-overlay__title">{{ t('whiteboard.insert') }}</span>
      <button class="wb-overlay__close" @click="close" :title="t('whiteboard.closeFull')">
        {{ t('whiteboard.closeFull') }}
      </button>
    </div>
    <div ref="surface" class="wb-overlay__surface">
      <div v-if="loading" class="wb-overlay__loading">
        <span class="wb-overlay__spinner" aria-hidden="true"></span>
        <span>{{ t('whiteboard.loading') }}</span>
      </div>
    </div>
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
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft, var(--bg));
}
.wb-overlay__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
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
.wb-overlay__loading {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-faint);
  font-size: 13px;
  font-style: italic;
  pointer-events: none;
}
.wb-overlay__spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--accent, var(--text-faint));
  border-radius: 50%;
  animation: wb-overlay-spin 0.7s linear infinite;
}
@keyframes wb-overlay-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
