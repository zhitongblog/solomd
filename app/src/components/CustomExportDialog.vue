<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceStore } from '../stores/workspace';
import { useToastsStore } from '../stores/toasts';
import { useExport } from '../composables/useExport';
import { openDirectoryInFileManager } from '../lib/reveal-in-file-manager';

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const settings = useSettingsStore();
const tabs = useTabsStore();
const workspace = useWorkspaceStore();
const toasts = useToastsStore();
const exporter = useExport();

const isZh = computed(() => settings.language === 'zh');

type ExportScope = 'current' | 'folder';
type ExportFormat = 'pdf' | 'html' | 'docx' | 'png' | 'textpack';

const scope = ref<ExportScope>('current');
const format = ref<ExportFormat>(settings.lastCustomExportFormat || 'pdf');
const sourceFolder = ref<string>(workspace.currentFolder || '');
const includeSubfolders = ref(true);
const mergeIntoSingleDocument = ref(false);
const outputDir = ref<string>('');
const exporting = ref(false);
const progressText = ref('');
const statusMessage = ref('');
const statusKind = ref<'ok' | 'err' | ''>('');
const lastExportedPath = ref('');

function parentDirOf(filePath?: string): string {
  if (!filePath || filePath.startsWith('content://')) return '';
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx > 0 ? filePath.slice(0, idx) : '';
}

function joinOutputPath(dir: string, relFile: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  const cleanDir = dir.replace(/[/\\]+$/, '');
  const cleanRel = relFile.replace(/^[/\\]+/, '').replace(/[/\\]/g, sep);
  return `${cleanDir}${sep}${cleanRel}`;
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) return;
    format.value = settings.lastCustomExportFormat || 'pdf';
    if (!sourceFolder.value && workspace.currentFolder) {
      sourceFolder.value = workspace.currentFolder;
    }
    const activeNoteDir = parentDirOf(tabs.activeTab?.filePath);
    if (!outputDir.value) {
      outputDir.value =
        settings.lastCustomExportDir ||
        settings.defaultExportDir ||
        activeNoteDir ||
        workspace.currentFolder ||
        '';
    }
    statusMessage.value = '';
    statusKind.value = '';
    progressText.value = '';
  },
  { immediate: true },
);

async function pickSourceFolder() {
  try {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: sourceFolder.value || workspace.currentFolder || undefined,
      title: isZh.value ? '选择要批量导出的笔记文件夹' : 'Select Folder to Batch Export',
    });
    if (typeof picked === 'string' && picked.trim()) {
      sourceFolder.value = picked.trim();
    }
  } catch (e) {
    toasts.error(String(e));
  }
}

async function pickOutputDirectory() {
  try {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      defaultPath:
        outputDir.value ||
        settings.lastCustomExportDir ||
        settings.defaultExportDir ||
        parentDirOf(tabs.activeTab?.filePath) ||
        workspace.currentFolder ||
        undefined,
      title: isZh.value ? '选择导出输出目录' : 'Select Export Output Directory',
    });
    if (typeof picked === 'string' && picked.trim()) {
      outputDir.value = picked.trim();
      settings.setLastCustomExportDir(outputDir.value);
    }
  } catch (e) {
    toasts.error(String(e));
  }
}

async function openOutputDirectory() {
  const dir = outputDir.value.trim();
  if (!dir) {
    toasts.warning(isZh.value ? '请先选择输出目录' : 'Please select an output directory first');
    return;
  }
  try {
    await invoke('fs_create_dir', { path: dir }).catch(() => {});
    await openDirectoryInFileManager(dir);
  } catch (e) {
    toasts.error(String(e));
  }
}

interface DirItem {
  name: string;
  path: string;
  is_dir: boolean;
}

async function collectMarkdownFiles(rootDir: string, recursive: boolean): Promise<Array<{ path: string; relDir: string; baseName: string }>> {
  const out: Array<{ path: string; relDir: string; baseName: string }> = [];
  async function walk(curDir: string, relPrefix: string) {
    const entries = await invoke<DirItem[]>('list_dir', {
      path: curDir,
      showHidden: false,
      withTimes: false,
    });
    for (const entry of entries) {
      if (!entry.path || entry.name === '__solomd_truncated__') continue;
      if (entry.is_dir) {
        if (recursive && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await walk(entry.path, relPrefix ? `${relPrefix}/${entry.name}` : entry.name);
        }
      } else if (/\.(md|markdown)$/i.test(entry.name)) {
        const baseName = entry.name.replace(/\.(md|markdown)$/i, '');
        out.push({ path: entry.path, relDir: relPrefix, baseName });
      }
    }
  }
  await walk(rootDir, '');
  return out;
}

async function runCustomExport() {
  const outDir = outputDir.value.trim();
  if (!outDir) {
    toasts.warning(isZh.value ? '请先选择输出目录' : 'Please select an output directory first');
    return;
  }
  settings.setLastCustomExportDir(outDir);
  settings.setLastCustomExportFormat(format.value);

  exporting.value = true;
  statusMessage.value = '';
  statusKind.value = '';
  progressText.value = '';
  const ext = format.value;

  try {
    if (scope.value === 'current') {
      const tab = tabs.activeTab;
      if (!tab) {
        throw new Error(isZh.value ? '当前没有打开的文档' : 'No active document');
      }
      const rawName = (tab as { fileName?: string; title?: string }).fileName || (tab as { title?: string }).title || 'Untitled';
      const baseName = rawName.replace(/\.[^.]+$/, '') || 'Untitled';
      const targetPath = joinOutputPath(outDir, `${baseName}.${ext}`);
      progressText.value = isZh.value ? `正在导出 ${baseName}.${ext}…` : `Exporting ${baseName}.${ext}…`;
      await exporter.exportNoteToFile({
        content: tab.content ?? '',
        baseName,
        filePath: tab.filePath,
        outputPath: targetPath,
        format: format.value,
      });
      lastExportedPath.value = targetPath;
      const msg = isZh.value ? `导出成功：${targetPath}` : `Exported to: ${targetPath}`;
      statusMessage.value = msg;
      statusKind.value = 'ok';
      toasts.success(msg);
    } else {
      const folder = sourceFolder.value.trim();
      if (!folder) {
        throw new Error(isZh.value ? '请选择要导出的源文件夹' : 'Please select a source folder');
      }
      progressText.value = isZh.value ? '正在扫描文件夹中的 Markdown 文档…' : 'Scanning folder for Markdown notes…';
      const mdFiles = await collectMarkdownFiles(folder, includeSubfolders.value);
      if (mdFiles.length === 0) {
        throw new Error(isZh.value ? '所选文件夹中没有找到 .md 文档' : 'No .md files found in the selected folder');
      }
      if (mergeIntoSingleDocument.value) {
        const folderName = folder.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || 'Exported-Book';
        const sections: string[] = [`# ${folderName}\n\n[TOC]`];
        for (let i = 0; i < mdFiles.length; i++) {
          const item = mdFiles[i];
          progressText.value = isZh.value
            ? `正在读取并合并章节 (${i + 1} / ${mdFiles.length})：${item.baseName}`
            : `Reading & merging section (${i + 1} / ${mdFiles.length}): ${item.baseName}`;
          const loaded = await invoke<string | { content: string }>('read_file', { path: item.path });
          const raw = (typeof loaded === 'string' ? loaded : loaded?.content ?? '').trim();
          const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
          const hasTopHeading = /^#\s+\S/.test(body);
          const chapterTitle = item.relDir ? `${item.relDir} / ${item.baseName}` : item.baseName;
          sections.push(hasTopHeading ? body : `# ${chapterTitle}\n\n${body}`);
        }
        const mergedContent = sections.join('\n\n---\n\n');
        const targetPath = joinOutputPath(outDir, `${folderName}.${ext}`);
        progressText.value = isZh.value
          ? `正在生成合集文档：${folderName}.${ext}…`
          : `Generating combined document: ${folderName}.${ext}…`;
        await exporter.exportNoteToFile({
          content: mergedContent,
          baseName: folderName,
          filePath: mdFiles[0].path,
          outputPath: targetPath,
          format: format.value,
        });
        lastExportedPath.value = targetPath;
        const msg = isZh.value
          ? `合集导出完成：已将 ${mdFiles.length} 篇笔记合并导出至 ${targetPath}`
          : `Combined export complete: ${mdFiles.length} notes merged into ${targetPath}`;
        statusMessage.value = msg;
        statusKind.value = 'ok';
        toasts.success(msg);
      } else {
        let exportedCount = 0;
        let lastPath = outDir;
        for (let i = 0; i < mdFiles.length; i++) {
          const item = mdFiles[i];
          progressText.value = isZh.value
            ? `正在批量导出 (${i + 1} / ${mdFiles.length})：${item.baseName}.${ext}`
            : `Batch exporting (${i + 1} / ${mdFiles.length}): ${item.baseName}.${ext}`;
          const loaded = await invoke<string | { content: string }>('read_file', { path: item.path });
          const content = typeof loaded === 'string' ? loaded : loaded?.content ?? '';
          const relFile = item.relDir ? `${item.relDir}/${item.baseName}.${ext}` : `${item.baseName}.${ext}`;
          const targetPath = joinOutputPath(outDir, relFile);
          await exporter.exportNoteToFile({
            content,
            baseName: item.baseName,
            filePath: item.path,
            outputPath: targetPath,
            format: format.value,
          });
          lastPath = targetPath;
          exportedCount++;
        }
        lastExportedPath.value = lastPath;
        const msg = isZh.value
          ? `批量导出完成：共导出 ${exportedCount} 篇文档至 ${outDir}`
          : `Batch export complete: ${exportedCount} notes exported to ${outDir}`;
        statusMessage.value = msg;
        statusKind.value = 'ok';
        toasts.success(msg);
      }
    }
  } catch (e) {
    const errMsg = String((e as Error)?.message ?? e);
    statusMessage.value = errMsg;
    statusKind.value = 'err';
    toasts.error(errMsg);
  } finally {
    exporting.value = false;
    progressText.value = '';
  }
}
</script>

<template>
  <div v-if="open" class="custom-export-backdrop" @click.self="emit('close')">
    <div class="custom-export-dialog" role="dialog" aria-modal="true">
      <div class="custom-export__header">
        <h3>{{ isZh ? '自定义导出 / 批量导出' : 'Custom & Batch Export' }}</h3>
        <button type="button" class="custom-export__close" @click="emit('close')">✕</button>
      </div>

      <div class="custom-export__body">
        <div class="custom-export__field">
          <label class="custom-export__label">{{ isZh ? '导出范围' : 'Export Scope' }}</label>
          <div class="custom-export__radios">
            <label class="custom-export__radio">
              <input v-model="scope" type="radio" value="current" />
              <span>{{ isZh ? '当前文档' : 'Current Note' }}</span>
            </label>
            <label class="custom-export__radio">
              <input v-model="scope" type="radio" value="folder" />
              <span>{{ isZh ? '整个文件夹批量导出' : 'Batch Export Folder' }}</span>
            </label>
          </div>
        </div>

        <div v-if="scope === 'folder'" class="custom-export__field">
          <label class="custom-export__label">{{ isZh ? '源文件夹路径' : 'Source Folder' }}</label>
          <div class="custom-export__row">
            <input
              v-model="sourceFolder"
              type="text"
              class="custom-export__input"
              :placeholder="isZh ? '选择要批量导出的笔记文件夹…' : 'Select source folder…'"
            />
            <button type="button" class="custom-export__btn" @click="pickSourceFolder">
              {{ isZh ? '浏览…' : 'Browse…' }}
            </button>
          </div>
          <label class="custom-export__checkbox">
            <input v-model="includeSubfolders" type="checkbox" />
            <span>{{ isZh ? '包含子文件夹中的所有 Markdown 文档（保持目录结构）' : 'Include subfolders (preserve directory structure)' }}</span>
          </label>
          <label class="custom-export__checkbox">
            <input v-model="mergeIntoSingleDocument" type="checkbox" />
            <span>{{ isZh ? '将所有笔记合并输出为 1 份文档成册（自动生成总目录与页码）' : 'Merge all notes into a single combined document (with Table of Contents)' }}</span>
          </label>
        </div>

        <div class="custom-export__field">
          <label class="custom-export__label">{{ isZh ? '导出格式' : 'Export Format' }}</label>
          <select v-model="format" class="custom-export__select">
            <option value="pdf">{{ isZh ? 'PDF 文档 (.pdf)' : 'PDF Document (.pdf)' }}</option>
            <option value="html">{{ isZh ? '网页文件 (.html)' : 'Standalone HTML (.html)' }}</option>
            <option value="docx">{{ isZh ? 'Word 文档 (.docx)' : 'Word Document (.docx)' }}</option>
            <option value="png">{{ isZh ? 'PNG 长图 (.png)' : 'PNG Image (.png)' }}</option>
            <option value="textpack">{{ isZh ? 'TextPack 自包含单文件容器 (.textpack)' : 'TextPack Self-Contained Bundle (.textpack)' }}</option>
          </select>
        </div>

        <div class="custom-export__field">
          <label class="custom-export__label">{{ isZh ? '输出目录 (自动记忆上次路径)' : 'Output Directory (remembered)' }}</label>
          <div class="custom-export__row">
            <input
              v-model="outputDir"
              type="text"
              class="custom-export__input"
              :placeholder="isZh ? '选择导出文件的保存目录…' : 'Select output directory…'"
            />
            <button type="button" class="custom-export__btn" @click="pickOutputDirectory">
              {{ isZh ? '浏览…' : 'Browse…' }}
            </button>
          </div>
        </div>

        <p v-if="progressText" class="custom-export__progress">{{ progressText }}</p>
        <p
          v-if="statusMessage"
          class="custom-export__status"
          :class="{
            'custom-export__status--ok': statusKind === 'ok',
            'custom-export__status--err': statusKind === 'err',
          }"
        >
          {{ statusMessage }}
        </p>
      </div>

      <div class="custom-export__footer">
        <button
          type="button"
          class="custom-export__btn"
          :disabled="!outputDir.trim()"
          @click="openOutputDirectory"
        >
          {{ isZh ? '📂 打开输出目录' : '📂 Open Output Directory' }}
        </button>
        <div class="custom-export__footer-right">
          <button type="button" class="custom-export__btn" @click="emit('close')">
            {{ isZh ? '关闭' : 'Close' }}
          </button>
          <button
            type="button"
            class="custom-export__btn custom-export__btn--primary"
            :disabled="exporting || !outputDir.trim()"
            @click="runCustomExport"
          >
            {{ exporting ? (isZh ? '正在导出…' : 'Exporting…') : (isZh ? '开始导出' : 'Export Now') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.custom-export-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2200;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.custom-export-dialog {
  width: min(560px, 100%);
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.custom-export__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.custom-export__header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.custom-export__close {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 15px;
  padding: 4px 8px;
  border-radius: 4px;
}
.custom-export__close:hover {
  background: var(--bg-elev);
  color: var(--text);
}
.custom-export__body {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.custom-export__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.custom-export__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}
.custom-export__radios {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
}
.custom-export__radio,
.custom-export__checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}
.custom-export__row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.custom-export__input,
.custom-export__select {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elev);
  color: var(--text);
}
.custom-export__btn {
  padding: 7px 12px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-elev);
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}
.custom-export__btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.custom-export__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.custom-export__btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}
.custom-export__btn--primary:hover:not(:disabled) {
  color: #fff;
  filter: brightness(1.06);
}
.custom-export__progress {
  margin: 0;
  font-size: 12px;
  color: var(--accent);
}
.custom-export__status {
  margin: 0;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  word-break: break-all;
}
.custom-export__status--ok {
  background: rgba(34, 197, 94, 0.12);
  color: #16a34a;
}
.custom-export__status--err {
  background: rgba(239, 68, 68, 0.12);
  color: #dc2626;
}
.custom-export__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  background: var(--bg-elev);
}
.custom-export__footer-right {
  display: flex;
  gap: 8px;
}
</style>
