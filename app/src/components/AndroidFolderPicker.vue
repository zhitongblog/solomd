<script setup lang="ts">
/**
 * #148 / #151 — Android folder browser.
 *
 * Tauri's dialog plugin has no directory picker on Android, and with
 * MANAGE_EXTERNAL_STORAGE granted we don't need SAF anyway — shared storage
 * is a normal filesystem. This is a compact browser over `list_dir`, rooted
 * at /storage/emulated/0, that returns a real path the whole existing stack
 * (file tree, read/write, watcher, AutoGit) works against unchanged.
 */
import { ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';

const props = defineProps<{ open: boolean; start?: string }>();
const emit = defineEmits<{
  (e: 'pick', path: string): void;
  (e: 'close'): void;
  (e: 'request-permission'): void;
}>();

const ROOT = '/storage/emulated/0';
const cwd = ref(ROOT);
const dirs = ref<{ name: string; path: string }[]>([]);
const loading = ref(false);
const error = ref('');
// EACCES despite the app believing it holds all-files access — usually the
// grant hasn't taken effect on this still-running process yet. Surface a
// re-grant CTA (which drives the request + auto-restart) instead of a raw
// "Permission denied (os error 13)".
const permDenied = ref(false);

async function load(path: string) {
  loading.value = true;
  error.value = '';
  permDenied.value = false;
  try {
    const entries = await invoke<{ name: string; path: string; is_dir: boolean }[]>('list_dir', { path });
    dirs.value = entries.filter((e) => e.is_dir).map((e) => ({ name: e.name, path: e.path }));
    cwd.value = path;
  } catch (e) {
    const msg = String(e);
    error.value = msg;
    permDenied.value = /permission denied|os error 13|EACCES/i.test(msg);
    dirs.value = [];
  } finally {
    loading.value = false;
  }
}

function up() {
  if (cwd.value === ROOT) return;
  const parent = cwd.value.replace(/\/[^/]+$/, '') || ROOT;
  load(parent.startsWith(ROOT) ? parent : ROOT);
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) load(props.start && props.start.startsWith(ROOT) ? props.start : ROOT);
  },
);

// Show the path below the root as a friendly breadcrumb.
function shortCwd(): string {
  return cwd.value === ROOT ? 'Internal storage' : cwd.value.replace(ROOT, 'Internal storage');
}
</script>

<template>
  <div v-if="open" class="afp-backdrop" @click.self="emit('close')">
    <div class="afp">
      <div class="afp__head">
        <span class="afp__title">Choose a folder</span>
        <button class="afp__x" @click="emit('close')">✕</button>
      </div>
      <div class="afp__crumb">
        <button class="afp__up" :disabled="cwd === ROOT" @click="up">↑ Up</button>
        <span class="afp__path" :title="cwd">{{ shortCwd() }}</span>
      </div>
      <div class="afp__list">
        <div v-if="loading" class="afp__msg">Loading…</div>
        <div v-else-if="permDenied" class="afp__msg afp__perm">
          <p>需要「所有文件访问」权限才能浏览手机里的文件夹。</p>
          <button class="afp__btn afp__btn--primary" @click="emit('request-permission')">
            去开启权限
          </button>
        </div>
        <div v-else-if="error" class="afp__msg afp__msg--err">{{ error }}</div>
        <div v-else-if="!dirs.length" class="afp__msg">No sub-folders here.</div>
        <button
          v-for="d in dirs"
          :key="d.path"
          class="afp__item"
          @click="load(d.path)"
        >
          📁 {{ d.name }}
        </button>
      </div>
      <div class="afp__foot">
        <button class="afp__btn" @click="emit('close')">Cancel</button>
        <button class="afp__btn afp__btn--primary" @click="emit('pick', cwd)">
          Use this folder
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.afp-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: var(--z-modal, 2000);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.afp {
  background: var(--bg, #fff);
  color: var(--text, #111);
  border-radius: var(--r-lg, 12px);
  width: 100%;
  max-width: 420px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--sh-pop, 0 8px 28px rgba(0, 0, 0, 0.12));
}
.afp__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: var(--bd, 1px solid var(--border, #eee));
}
.afp__title { font-weight: 600; }
.afp__x { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--text-muted, #888); }
.afp__crumb {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: var(--bd, 1px solid var(--border, #eee));
}
.afp__up {
  border: var(--bd, 1px solid var(--border, #ddd));
  background: var(--bg-hover, #f5f5f5);
  border-radius: var(--r-sm, 4px);
  padding: 4px 10px;
  cursor: pointer;
  font-size: 13px;
}
.afp__up:disabled { opacity: 0.4; cursor: default; }
.afp__path { font-size: 13px; color: var(--text-muted, #666); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.afp__list { overflow-y: auto; flex: 1; padding: 6px 0; }
.afp__item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: none;
  color: inherit;
  padding: 11px 16px;
  cursor: pointer;
  font-size: 15px;
}
.afp__item:hover { background: var(--bg-hover, #f2f2f2); }
.afp__msg { padding: 20px 16px; color: var(--text-muted, #888); font-size: 14px; }
.afp__msg--err { color: var(--danger, #d33); white-space: pre-wrap; }
.afp__perm { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
.afp__perm p { margin: 0; color: var(--text, #333); font-size: 14px; }
.afp__foot {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  padding: 12px 16px;
  border-top: var(--bd, 1px solid var(--border, #eee));
}
.afp__btn {
  border: var(--bd, 1px solid var(--border, #ddd));
  background: var(--bg-hover, #f5f5f5);
  border-radius: var(--r-sm, 6px);
  padding: 8px 16px;
  cursor: pointer;
  font-size: 14px;
  color: inherit;
}
.afp__btn--primary { background: var(--accent, #ff9f40); color: #000; border-color: transparent; font-weight: 600; }
</style>
