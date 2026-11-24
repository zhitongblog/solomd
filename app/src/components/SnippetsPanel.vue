<template>
  <div class="snippets-panel">
    <PanelHeader :title="t('snippets.title')" @close="settings.toggleSnippetsPanel()">
      <template #actions>
        <button
          class="snippets-panel__add-btn"
          :title="t('snippets.add')"
          @click="openCreate"
        >
          +
        </button>
      </template>
    </PanelHeader>

    <div class="snippets-panel__search">
      <input
        v-model="query"
        class="snippets-panel__input"
        type="search"
        :placeholder="t('snippets.searchPlaceholder')"
      />
    </div>

    <div class="snippets-panel__list" @contextmenu.prevent>
      <div
        v-for="item in filteredSnippets"
        :key="item.id"
        class="snippets-panel__item"
        :title="t('snippets.dblClickHint')"
        @dblclick="insertSnippet(item)"
        @contextmenu.prevent="openCtx($event, item)"
      >
        <div class="snippets-panel__item-head">
          <span class="snippets-panel__item-name">{{ item.name }}</span>
          <span v-if="item.category" class="snippets-panel__item-cat">{{ item.category }}</span>
        </div>
        <pre class="snippets-panel__item-preview">{{ previewText(item.content) }}</pre>
        <div class="snippets-panel__item-actions">
          <button class="snippets-panel__mini-btn" @click.stop="insertSnippet(item)">
            {{ t('snippets.insert') }}
          </button>
          <button class="snippets-panel__mini-btn" @click.stop="openEdit(item)">
            {{ t('snippets.edit') }}
          </button>
          <button class="snippets-panel__mini-btn snippets-panel__mini-btn--danger" @click.stop="removeSnippet(item.id)">
            {{ t('snippets.delete') }}
          </button>
        </div>
      </div>

      <div v-if="filteredSnippets.length === 0" class="snippets-panel__empty">
        {{ t('snippets.empty') }}
      </div>
    </div>

    <!-- Right-click context menu -->
    <div
      v-if="ctxMenu"
      class="snippets-panel__ctx"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @click.stop
    >
      <button @click="insertSnippet(ctxMenu.item); ctxMenu = null">{{ t('snippets.insert') }}</button>
      <button @click="openEdit(ctxMenu.item); ctxMenu = null">{{ t('snippets.edit') }}</button>
      <button @click="duplicateSnippet(ctxMenu.item); ctxMenu = null">{{ t('snippets.duplicate') }}</button>
      <button class="danger" @click="removeSnippet(ctxMenu.item.id); ctxMenu = null">{{ t('snippets.delete') }}</button>
    </div>

    <!-- Add / Edit modal -->
    <div v-if="editorOpen" class="snippets-panel__modal-mask" @click.self="editorOpen = false">
      <div class="snippets-panel__modal">
        <header class="snippets-panel__modal-head">
          <h4>{{ editingId ? t('snippets.editTitle') : t('snippets.addTitle') }}</h4>
          <button class="snippets-panel__close" @click="editorOpen = false">×</button>
        </header>
        <div class="snippets-panel__modal-body">
          <label class="snippets-panel__field">
            <span>{{ t('snippets.nameLabel') }}</span>
            <input v-model="draftName" type="text" :placeholder="t('snippets.namePlaceholder')" />
          </label>
          <label class="snippets-panel__field">
            <span>{{ t('snippets.categoryLabel') }}</span>
            <input v-model="draftCategory" type="text" placeholder="Alert / HTML / Meta" />
          </label>
          <label class="snippets-panel__field">
            <span>{{ t('snippets.contentLabel') }}</span>
            <textarea
              ref="draftTextarea"
              v-model="draftContent"
              rows="7"
              :placeholder="t('snippets.contentPlaceholder')"
            />
          </label>
          <div class="snippets-panel__vars">
            <div class="snippets-panel__vars-label">{{ t('snippets.varsHint') }}</div>
            <div class="snippets-panel__var-chips">
              <button
                v-for="v in SNIPPET_VARIABLES"
                :key="v.token"
                type="button"
                class="snippets-panel__var-chip"
                :title="settings.language === 'zh' ? v.descZh : v.descEn"
                @click="appendVarToken(v.token)"
              >
                {{ v.token }}
              </button>
            </div>
          </div>
        </div>
        <footer class="snippets-panel__modal-foot">
          <button class="btn-secondary" @click="editorOpen = false">{{ t('common.cancel') }}</button>
          <button class="btn-primary" :disabled="!draftName.trim() || !draftContent" @click="saveDraft">
            {{ t('common.save') }}
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import PanelHeader from './panel/PanelHeader.vue';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceIndexStore } from '../stores/workspaceIndex';
import { useI18n } from '../i18n';
import {
  SNIPPET_VARIABLES,
  expandSnippet,
  extractFirstH1Title,
  loadSnippets,
  pinSnippetToTop,
  saveSnippets,
  toInsertMarkdownPayload,
  type SnippetItem,
} from '../lib/snippets';

const props = defineProps<{
  selectionText?: string;
}>();

const settings = useSettingsStore();
const tabs = useTabsStore();
const wsIndex = useWorkspaceIndexStore();
const { t } = useI18n();

const snippets = ref<SnippetItem[]>(loadSnippets());
const query = ref('');
const ctxMenu = ref<{ x: number; y: number; item: SnippetItem } | null>(null);

const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const draftName = ref('');
const draftCategory = ref('');
const draftContent = ref('');
const draftTextarea = ref<HTMLTextAreaElement | null>(null);

const filteredSnippets = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return snippets.value;
  return snippets.value.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      (s.category || '').toLowerCase().includes(q) ||
      s.content.toLowerCase().includes(q),
  );
});

function previewText(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > 90 ? oneLine.slice(0, 90) + '…' : oneLine;
}

function resolvePrevNextBasenames(activePath: string | undefined): { prev: string; next: string } {
  if (!activePath) return { prev: '', next: '' };
  const norm = (p: string) => p.replace(/\\/g, '/');
  const cur = norm(activePath);
  const parent = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '';
  const siblings = wsIndex.entries
    .filter((e) => {
      const ep = norm(e.path);
      const eParent = ep.includes('/') ? ep.slice(0, ep.lastIndexOf('/')) : '';
      return eParent === parent;
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const idx = siblings.findIndex((e) => norm(e.path) === cur);
  if (idx < 0) return { prev: '', next: '' };
  const stripExt = (n: string) => n.replace(/\.[^.]+$/, '');
  return {
    prev: idx > 0 ? stripExt(siblings[idx - 1].name) : '',
    next: idx + 1 < siblings.length ? stripExt(siblings[idx + 1].name) : '',
  };
}

function insertSnippet(item: SnippetItem) {
  const active = tabs.activeTab;
  const fileName = active?.fileName || '';
  const filebase = fileName.replace(/\.[^.]+$/, '');
  const title = active ? extractFirstH1Title(active.content) : '';
  const { prev, next } = resolvePrevNextBasenames(active?.filePath);
  const sel = props.selectionText ?? window.getSelection()?.toString() ?? '';

  const expanded = expandSnippet(item.content, {
    selection: sel,
    filebase,
    title,
    filebaseprev: prev,
    filebasenext: next,
  });
  const payload = toInsertMarkdownPayload(expanded);
  window.dispatchEvent(new CustomEvent('solomd:insert-markdown', { detail: { snippet: payload } }));

  // Auto-pin most recently used snippet to index 0 (#653).
  snippets.value = pinSnippetToTop(snippets.value, item.id);
  saveSnippets(snippets.value);
}

function openCreate() {
  editingId.value = null;
  draftName.value = '';
  draftCategory.value = '';
  draftContent.value = '';
  editorOpen.value = true;
}

function openEdit(item: SnippetItem) {
  editingId.value = item.id;
  draftName.value = item.name;
  draftCategory.value = item.category || '';
  draftContent.value = item.content;
  editorOpen.value = true;
}

function duplicateSnippet(item: SnippetItem) {
  const copy: SnippetItem = {
    ...item,
    id: `snip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: `${item.name} (Copy)`,
    updatedAt: Date.now(),
  };
  snippets.value = [copy, ...snippets.value];
  saveSnippets(snippets.value);
}

function saveDraft() {
  const name = draftName.value.trim();
  if (!name || !draftContent.value) return;
  if (editingId.value) {
    snippets.value = snippets.value.map((s) =>
      s.id === editingId.value
        ? {
            ...s,
            name,
            category: draftCategory.value.trim() || undefined,
            content: draftContent.value,
            updatedAt: Date.now(),
          }
        : s,
    );
  } else {
    const created: SnippetItem = {
      id: `snip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      category: draftCategory.value.trim() || undefined,
      content: draftContent.value,
      updatedAt: Date.now(),
    };
    snippets.value = [created, ...snippets.value];
  }
  saveSnippets(snippets.value);
  editorOpen.value = false;
}

function removeSnippet(id: string) {
  snippets.value = snippets.value.filter((s) => s.id !== id);
  saveSnippets(snippets.value);
}

function appendVarToken(token: string) {
  const el = draftTextarea.value;
  if (el) {
    const start = el.selectionStart ?? draftContent.value.length;
    const end = el.selectionEnd ?? draftContent.value.length;
    draftContent.value =
      draftContent.value.slice(0, start) + token + draftContent.value.slice(end);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  } else {
    draftContent.value += token;
  }
}

function openCtx(e: MouseEvent, item: SnippetItem) {
  ctxMenu.value = { x: e.clientX, y: e.clientY, item };
}

function closeCtx() {
  ctxMenu.value = null;
}

onMounted(() => {
  window.addEventListener('click', closeCtx);
});

onBeforeUnmount(() => {
  window.removeEventListener('click', closeCtx);
});
</script>

<style scoped>
.snippets-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  font-size: 13px;
}
.snippets-panel__add-btn {
  border: 1px solid var(--border);
  background: var(--bg-soft);
  color: var(--fg);
  border-radius: 6px;
  width: 24px;
  height: 24px;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.snippets-panel__search {
  padding: 8px 10px 6px;
  border-bottom: 1px solid var(--border);
}
.snippets-panel__input {
  width: 100%;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg);
  font-size: 12px;
}
.snippets-panel__list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.snippets-panel__item {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--bg);
  cursor: pointer;
  transition: border-color 0.15s ease;
}
.snippets-panel__item:hover {
  border-color: var(--accent);
}
.snippets-panel__item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 4px;
}
.snippets-panel__item-name {
  font-weight: 600;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.snippets-panel__item-cat {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 99px;
  background: var(--bg-soft);
  color: var(--fg-muted);
  flex-shrink: 0;
}
.snippets-panel__item-preview {
  margin: 0 0 6px;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.snippets-panel__item-actions {
  display: flex;
  gap: 6px;
}
.snippets-panel__mini-btn {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: var(--bg-soft);
  color: var(--fg);
  cursor: pointer;
}
.snippets-panel__mini-btn--danger:hover {
  color: var(--danger, #e53935);
  border-color: var(--danger, #e53935);
}
.snippets-panel__empty {
  text-align: center;
  padding: 24px 12px;
  color: var(--fg-muted);
}
.snippets-panel__ctx {
  position: fixed;
  z-index: 2000;
  background: var(--bg-elevated, var(--bg));
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
  display: flex;
  flex-direction: column;
  min-width: 120px;
}
.snippets-panel__ctx button {
  text-align: left;
  border: none;
  background: transparent;
  color: var(--fg);
  padding: 6px 10px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
}
.snippets-panel__ctx button:hover {
  background: var(--bg-soft);
}
.snippets-panel__ctx button.danger {
  color: var(--danger, #e53935);
}
.snippets-panel__modal-mask {
  position: fixed;
  inset: 0;
  z-index: 2100;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
}
.snippets-panel__modal {
  width: min(520px, 92vw);
  max-height: 85vh;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
}
.snippets-panel__modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.snippets-panel__modal-head h4 {
  margin: 0;
  font-size: 14px;
}
.snippets-panel__close {
  border: none;
  background: transparent;
  color: var(--fg-muted);
  font-size: 18px;
  cursor: pointer;
}
.snippets-panel__modal-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.snippets-panel__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.snippets-panel__field input,
.snippets-panel__field textarea {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 9px;
  background: var(--bg-soft);
  color: var(--fg);
  font-size: 12px;
  font-family: inherit;
}
.snippets-panel__field textarea {
  font-family: var(--font-mono, monospace);
  resize: vertical;
}
.snippets-panel__vars-label {
  font-size: 11px;
  color: var(--fg-muted);
  margin-bottom: 6px;
}
.snippets-panel__var-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.snippets-panel__var-chip {
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  padding: 2px 6px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: var(--bg-soft);
  color: var(--fg);
  cursor: pointer;
}
.snippets-panel__var-chip:hover {
  border-color: var(--accent);
}
.snippets-panel__modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}
.btn-secondary,
.btn-primary {
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}
.btn-secondary {
  border: 1px solid var(--border);
  background: var(--bg-soft);
  color: var(--fg);
}
.btn-primary {
  border: none;
  background: var(--accent);
  color: #fff;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
