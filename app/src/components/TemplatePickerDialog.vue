<script setup lang="ts">
/**
 * #322 — "New Note from Template…" modal dialog (`TemplatePickerDialog.vue`).
 * Supports built-in templates + custom `.md` templates inside the current
 * workspace's `templates/`, `Templates/`, or `.solomd/templates/` folders.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { DsButton, DsModal } from '../ui';
import { useWorkspaceStore } from '../stores/workspace';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useFiles } from '../composables/useFiles';
import {
  BUILTIN_NOTE_TEMPLATES,
  expandNoteTemplate,
  type NoteTemplateItem,
} from '../lib/note-templates';

const open = ref(false);
const noteTitle = ref('');
const selectedId = ref(BUILTIN_NOTE_TEMPLATES[0].id);
const customTemplates = ref<NoteTemplateItem[]>([]);
const titleInputRef = ref<HTMLInputElement | null>(null);

const workspace = useWorkspaceStore();
const settings = useSettingsStore();
const tabs = useTabsStore();
const files = useFiles();

const isZh = computed(() => !!settings.language?.startsWith('zh'));

const allTemplates = computed<NoteTemplateItem[]>(() => [
  ...customTemplates.value,
  ...BUILTIN_NOTE_TEMPLATES,
]);

const selectedTemplate = computed<NoteTemplateItem | undefined>(
  () =>
    allTemplates.value.find((t) => t.id === selectedId.value) ??
    allTemplates.value[0],
);

async function loadWorkspaceTemplates() {
  const root = workspace.currentFolder;
  if (!root || !('__TAURI_INTERNALS__' in window)) {
    customTemplates.value = [];
    return;
  }
  const sep = root.includes('\\') ? '\\' : '/';
  const candidateDirs = [
    `${root}${sep}templates`,
    `${root}${sep}Templates`,
    `${root}${sep}.solomd${sep}templates`,
  ];
  const found: NoteTemplateItem[] = [];
  const seenNames = new Set<string>();
  for (const dir of candidateDirs) {
    try {
      const entries = await invoke<Array<{ name: string; path: string; is_dir: boolean }>>(
        'list_dir',
        { path: dir, showHidden: true },
      );
      for (const e of entries) {
        if (e.is_dir || !/\.md$/i.test(e.name)) continue;
        const stem = e.name.replace(/\.md$/i, '');
        if (seenNames.has(stem.toLowerCase())) continue;
        seenNames.add(stem.toLowerCase());
        found.push({
          id: `custom:${e.path}`,
          nameZh: stem,
          nameEn: stem,
          descZh: `工作区模板 (${e.name})`,
          descEn: `Workspace template (${e.name})`,
          contentZh: '',
          contentEn: '',
          customPath: e.path,
        });
      }
    } catch {
      /* folder does not exist — ignore */
    }
  }
  customTemplates.value = found;
}

function handleOpenEvent() {
  open.value = true;
}

watch(open, async (v) => {
  if (!v) return;
  noteTitle.value = '';
  await loadWorkspaceTemplates();
  selectedId.value = allTemplates.value[0]?.id ?? BUILTIN_NOTE_TEMPLATES[0].id;
  await nextTick();
  titleInputRef.value?.focus();
});

async function applyTemplate(tpl?: NoteTemplateItem) {
  const target = tpl ?? selectedTemplate.value;
  if (!target) return;
  let raw = isZh.value ? target.contentZh : target.contentEn;
  if (target.customPath) {
    try {
      const res = await invoke<{ content: string }>('read_file', {
        path: target.customPath,
      });
      raw = res.content;
    } catch {
      raw = `# {{title}}\n\n`;
    }
  }
  const fallbackTitle = isZh.value ? target.nameZh : target.nameEn;
  const expanded = expandNoteTemplate(raw, {
    title: noteTitle.value,
    fallbackTitle,
  });
  open.value = false;
  await files.newFile();
  if (tabs.activeId) {
    tabs.setContent(tabs.activeId, expanded);
  }
}

onMounted(() => {
  window.addEventListener('solomd:open-template-picker', handleOpenEvent);
});

onBeforeUnmount(() => {
  window.removeEventListener('solomd:open-template-picker', handleOpenEvent);
});
</script>

<template>
  <DsModal
    :model-value="open"
    :title="isZh ? '从模板新建笔记' : 'New Note from Template'"
    width="520px"
    @update:model-value="open = $event"
  >
    <div class="tpl-dialog">
      <label class="tpl-dialog__field">
        <span class="tpl-dialog__label">{{ isZh ? '笔记标题（可选）' : 'Note Title (optional)' }}</span>
        <input
          ref="titleInputRef"
          v-model="noteTitle"
          type="text"
          class="tpl-dialog__input"
          :placeholder="isZh ? '输入标题，自动替换模板中的 {{title}}…' : 'Enter title to replace {{title}}…'"
          @keydown.enter.prevent="applyTemplate()"
        />
      </label>

      <div class="tpl-dialog__list" role="listbox">
        <button
          v-for="item in allTemplates"
          :key="item.id"
          type="button"
          class="tpl-dialog__item"
          :class="{ 'tpl-dialog__item--active': item.id === selectedId }"
          @click="selectedId = item.id"
          @dblclick="applyTemplate(item)"
        >
          <div class="tpl-dialog__item-head">
            <span class="tpl-dialog__item-name">{{ isZh ? item.nameZh : item.nameEn }}</span>
            <span v-if="item.customPath" class="tpl-dialog__badge">{{ isZh ? '工作区' : 'Workspace' }}</span>
          </div>
          <div class="tpl-dialog__item-desc">{{ isZh ? item.descZh : item.descEn }}</div>
        </button>
      </div>
    </div>

    <template #footer>
      <DsButton variant="ghost" @click="open = false">
        {{ isZh ? '取消' : 'Cancel' }}
      </DsButton>
      <DsButton variant="primary" @click="applyTemplate()">
        {{ isZh ? '创建笔记' : 'Create Note' }}
      </DsButton>
    </template>
  </DsModal>
</template>

<style scoped>
.tpl-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.tpl-dialog__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.tpl-dialog__label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
}
.tpl-dialog__input {
  height: 32px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--text);
  font: 13px var(--font-ui);
  outline: none;
}
.tpl-dialog__input:focus {
  border-color: var(--accent);
}
.tpl-dialog__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 260px;
  overflow-y: auto;
}
.tpl-dialog__item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 9px 12px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.tpl-dialog__item:hover {
  background: var(--bg-elev);
}
.tpl-dialog__item--active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent-soft) 45%, var(--bg));
}
.tpl-dialog__item-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tpl-dialog__item-name {
  font-size: 13px;
  font-weight: 600;
}
.tpl-dialog__badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
}
.tpl-dialog__item-desc {
  font-size: 12px;
  color: var(--text-muted);
}
</style>
