<script setup lang="ts">
/**
 * The quick-capture box — a whole window, but only just.
 *
 * Opened by the global hotkey (registered in Rust, see `quick_capture.rs`).
 * Type, press Enter, it's an Inbox note and the box is gone. Esc throws the
 * text away. There is deliberately nothing else here: no formatting, no
 * folder picker, no tags UI. Every control added is a decision the user has to
 * make before the thought is written down, which is the friction this exists
 * to remove.
 *
 * It runs as its own Vue root (`main.ts` branches on `?quickCapture=1`) in a
 * second webview, so it shares localStorage with the main window — which is
 * how it knows the theme and the language without any IPC.
 */
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useI18n } from '../i18n';
import { useSettingsStore } from '../stores/settings';
import { useWorkspaceStore } from '../stores/workspace';

const { t } = useI18n();
const settings = useSettingsStore();
const workspace = useWorkspaceStore();

const text = ref('');
const box = ref<HTMLTextAreaElement | null>(null);
const error = ref('');
const saving = ref(false);
// A ref rather than a plain `let`: `<script setup>` exposes a bare `let` to
// the template as its literal type, so the composition handlers could not
// assign to it.
const composing = ref(false);
let unlistenReset: UnlistenFn | null = null;

const folderName = computed(() => {
  const f = workspace.currentFolder;
  if (!f) return '';
  return f.split(/[\\/]/).filter(Boolean).pop() ?? f;
});

function focusBox() {
  void nextTick(() => box.value?.focus());
}

async function close() {
  text.value = '';
  error.value = '';
  try {
    await invoke('quick_capture_close');
  } catch {
    /* the window is going away either way */
  }
}

async function save() {
  if (saving.value) return;
  const content = text.value.trim();
  if (!content) {
    void close();
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    await invoke<string>('quick_capture_write', { content });
    text.value = '';
    await close();
  } catch (e) {
    // Staying open with the text intact is the only acceptable failure: the
    // note exists nowhere else, and the window closing would destroy it.
    error.value = String(e);
  } finally {
    saving.value = false;
  }
}

/**
 * Enter saves, Shift+Enter is a newline.
 *
 * The `isComposing` guard is not optional: committing an IME candidate is an
 * Enter press, so without it every pinyin/kana confirmation would file the
 * half-typed note and close the window.
 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    void close();
    return;
  }
  if (e.key !== 'Enter') return;
  if (composing.value || e.isComposing || e.keyCode === 229) return;
  if (e.shiftKey) return;
  e.preventDefault();
  void save();
}

onMounted(async () => {
  document.documentElement.setAttribute(
    'data-theme',
    settings.theme === 'light' ? 'light' : settings.theme,
  );
  focusBox();
  try {
    // Reopening the box must not present the last capture's leftovers.
    unlistenReset = await listen('solomd://quick-capture-reset', () => {
      text.value = '';
      error.value = '';
      focusBox();
    });
  } catch {}
});

onBeforeUnmount(() => {
  unlistenReset?.();
});
</script>

<template>
  <div class="qc" @keydown="onKeydown">
    <textarea
      ref="box"
      v-model="text"
      class="qc__input"
      :placeholder="t('quickCapture.placeholder')"
      rows="3"
      @compositionstart="composing = true"
      @compositionend="composing = false"
    ></textarea>
    <div class="qc__bar">
      <span v-if="error" class="qc__error">{{ error }}</span>
      <span v-else-if="!workspace.currentFolder" class="qc__error">
        {{ t('quickCapture.noWorkspace') }}
      </span>
      <span v-else class="qc__dest">{{ t('quickCapture.destination', { folder: folderName }) }}</span>
      <span class="qc__keys">{{ t('quickCapture.keys') }}</span>
    </div>
  </div>
</template>

<style scoped>
.qc {
  display: flex;
  flex-direction: column;
  height: 100vh;
  box-sizing: border-box;
  padding: 12px 14px 10px;
  background: var(--bg-elev, #f7f6f3);
  border: 1px solid var(--border, #e9e9e7);
  border-radius: 10px;
  color: var(--text);
  font-family: var(--font-ui, system-ui, sans-serif);
}
.qc__input {
  flex: 1;
  width: 100%;
  resize: none;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 15px;
  line-height: 1.55;
  font-family: inherit;
}
.qc__input::placeholder {
  color: var(--text-faint, #b4b4b4);
}
.qc__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--border, #e9e9e7);
  font-size: 11px;
  color: var(--text-muted, #787774);
}
.qc__error {
  color: var(--danger, #d64545);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qc__dest,
.qc__keys {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qc__keys {
  flex-shrink: 0;
  opacity: 0.75;
}
</style>
