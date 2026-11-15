<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useWorkspaceStore } from '../stores/workspace';
import { useToastsStore } from '../stores/toasts';
import { useExport } from '../composables/useExport';
import { openDirectoryInFileManager } from '../lib/reveal-in-file-manager';
import { sourceFolderFor, treeSelection } from '../lib/new-file-target';
import { buildMergedBookMarkdown, type MergedNoteInput } from '../lib/merged-book';
import {
  resolveRenamedExportPath,
  splitExportPath,
  suggestNumberedExportPath,
  validateHtmlContentWidth,
} from '../lib/export-overwrite';

type ExportScope = 'current' | 'folder';
type ExportFormat = 'pdf' | 'html' | 'docx' | 'epub' | 'odt' | 'latex' | 'rtf' | 'png' | 'textpack';

const props = defineProps<{
  open: boolean;
  preset?: {
    scope?: ExportScope;
    format?: ExportFormat;
  } | null;
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

const scope = ref<ExportScope>('current');
const format = ref<ExportFormat>(settings.lastCustomExportFormat || 'pdf');

function formatExtension(fmt: ExportFormat): string {
  return fmt === 'latex' ? 'tex' : fmt;
}
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

/**
 * #554 — the Explorer publishes its current selection (a folder, or the file
 * the user has open). A selected folder is the source folder itself; a
 * selected file contributes its parent folder. Falls back to the vault root
 * through the caller when no usable row is selected.
 */
function sourceFolderFromTree(): string {
  // #554 — the Explorer's selected folder (or the parent of the selected
  // file) becomes the batch-export source folder.
  return sourceFolderFor(treeSelection()) ?? '';
}

/**
 * #551 — `@click.self` on the backdrop closes the dialog on ANY click whose
 * target resolves to the backdrop. A drag that starts in a text field and ends
 * outside the panel makes the backdrop the nearest common ancestor of the
 * mousedown / mouseup targets, so Chromium fires `click` on it and the whole
 * window disappears mid-selection. Require both ends of the gesture to be on
 * the backdrop itself before dismissing.
 */
let backdropPointerDown = false;
let backdropPointerUp = false;
function onBackdropPointerDown(e: PointerEvent) {
  backdropPointerDown = e.button === 0 && e.target === e.currentTarget;
  backdropPointerUp = false;
}
function onBackdropPointerUp(e: PointerEvent) {
  backdropPointerUp = e.target === e.currentTarget;
}
function onBackdropClick(e: MouseEvent) {
  const shouldClose = backdropPointerDown && backdropPointerUp && e.target === e.currentTarget;
  backdropPointerDown = false;
  backdropPointerUp = false;
  if (shouldClose) emit('close');
}

/** #553 — the success toast gets a one-click way into the output folder. */
function notifyExportSuccess(message: string, dir: string) {
  toasts.push(
    message,
    'success',
    6000,
    () => { void openDirectoryInFileManager(dir); },
    { actionLabel: isZh.value ? '打开输出目录' : 'Open Output Folder' },
  );
}

watch(
  [() => props.open, () => props.preset],
  ([isOpen, preset]) => {
    if (!isOpen) return;
    if (preset?.scope) {
      scope.value = preset.scope;
    } else {
      scope.value = 'current';
    }
    if (preset?.format) {
      format.value = preset.format;
    } else {
      format.value = settings.lastCustomExportFormat || 'pdf';
    }
    // #554 — mirror the Explorer's current row into the source folder field.
    // A tree selection always wins; without one keep the last manual choice,
    // falling back to the vault root on the very first open.
    const fromTree = sourceFolderFromTree();
    if (fromTree) {
      sourceFolder.value = fromTree;
    } else if (!sourceFolder.value && workspace.currentFolder) {
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

/** #553 — a .docx used as a Word "reference doc": its styles, theme and page
 *  setup are applied to the generated document. The path is a global setting
 *  so the File → Export → Word path picks up the same template. */
async function pickDocxTemplate() {
  try {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      defaultPath: settings.docxReferenceDoc || outputDir.value || workspace.currentFolder || undefined,
      filters: [{ name: isZh.value ? 'Word 模板' : 'Word Template', extensions: ['docx'] }],
      title: isZh.value ? '选择自定义 Word 模板 (.docx)' : 'Select Custom Word Template (.docx)',
    });
    if (typeof picked === 'string' && picked.trim()) {
      settings.setDocxReferenceDoc(picked.trim());
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

interface CollectedExportItem {
  path: string;
  relDir: string;
  baseName: string;
  emptyDir?: boolean;
}

const ASSET_FOLDER_RE = /^(?:_?assets|images|img|media|attachments|static)$/i;

async function collectMarkdownFiles(
  rootDir: string,
  recursive: boolean,
  includeEmptyLeafDirs = false,
): Promise<CollectedExportItem[]> {
  const out: CollectedExportItem[] = [];
  async function walk(curDir: string, relPrefix: string): Promise<number> {
    const startLen = out.length;
    const entries = await invoke<DirItem[]>('list_dir', {
      path: curDir,
      showHidden: false,
      withTimes: false,
    });
    const sorted = [...entries].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    for (const entry of sorted) {
      if (!entry.path || entry.name === '__solomd_truncated__') continue;
      if (entry.is_dir) {
        if (recursive && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const childRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
          const added = await walk(entry.path, childRel);
          if (includeEmptyLeafDirs && added === 0 && !ASSET_FOLDER_RE.test(entry.name)) {
            out.push({ path: '', relDir: childRel, baseName: '', emptyDir: true });
          }
        }
      } else if (/\.(md|markdown)$/i.test(entry.name)) {
        const baseName = entry.name.replace(/\.(md|markdown)$/i, '');
        out.push({ path: entry.path, relDir: relPrefix, baseName });
      }
    }
    return out.length - startLen;
  }
  await walk(rootDir, '');
  return out;
}

// #584 — Desktop HTML content width warning bubble
const htmlWidthWarning = computed(() => {
  const screenW = typeof window !== 'undefined' && window.screen?.width ? window.screen.width : 1920;
  return validateHtmlContentWidth(settings.exportHtmlContentWidth, screenW, isZh.value);
});

function onHtmlWidthInput(ev: Event) {
  const raw = (ev.target as HTMLInputElement).value.trim();
  if (raw === '') {
    settings.setExportHtmlContentWidth(0);
    return;
  }
  const num = Number.parseInt(raw, 10);
  if (Number.isFinite(num)) {
    settings.setExportHtmlContentWidth(Math.max(0, num));
  }
}

// #581 — Overwrite confirmation & New File Name `(1)` dialog state
const overwritePromptOpen = ref(false);
const overwriteTargetPath = ref('');
const overwriteTargetName = ref('');
let overwriteResolver: ((choice: 'overwrite' | 'rename' | 'cancel') => void) | null = null;

const renamePromptOpen = ref(false);
const renameOriginalPath = ref('');
const renameInputValue = ref('');
const renameInputEl = ref<HTMLInputElement | null>(null);
let renameResolver: ((resolvedPath: string | null) => void) | null = null;

function settleOverwritePrompt(choice: 'overwrite' | 'rename' | 'cancel') {
  overwritePromptOpen.value = false;
  const r = overwriteResolver;
  overwriteResolver = null;
  if (r) r(choice);
}

function cancelRenamePrompt() {
  renamePromptOpen.value = false;
  const r = renameResolver;
  renameResolver = null;
  if (r) r(null);
}

function confirmRenamePrompt() {
  const resolved = resolveRenamedExportPath(renameOriginalPath.value, renameInputValue.value);
  if (!resolved) {
    toasts.warning(isZh.value ? '新文件名不能为空，请输入有效的文件名' : 'File name cannot be empty');
    void nextTick(() => renameInputEl.value?.focus());
    return;
  }
  renamePromptOpen.value = false;
  const r = renameResolver;
  renameResolver = null;
  if (r) r(resolved);
}

async function resolveExportTargetConflict(desiredPath: string): Promise<string | null> {
  let exists = false;
  try {
    exists = await invoke<boolean>('fs_file_exists', { path: desiredPath });
  } catch {
    exists = false;
  }
  if (!exists) return desiredPath;

  const { fileName } = splitExportPath(desiredPath);
  overwriteTargetPath.value = desiredPath;
  overwriteTargetName.value = fileName;
  overwritePromptOpen.value = true;

  const choice = await new Promise<'overwrite' | 'rename' | 'cancel'>((resolve) => {
    overwriteResolver = resolve;
  });

  if (choice === 'overwrite') return desiredPath;
  if (choice === 'cancel') return null;

  // Compute default numbered name `name(1).ext`, `name(2).ext`, ...
  const suggested = await suggestNumberedExportPath(desiredPath, async (candidate) => {
    try {
      return await invoke<boolean>('fs_file_exists', { path: candidate });
    } catch {
      return false;
    }
  });
  renameOriginalPath.value = desiredPath;
  renameInputValue.value = suggested.fileName;
  renamePromptOpen.value = true;
  await nextTick();
  if (renameInputEl.value) {
    renameInputEl.value.focus();
    const dot = suggested.fileName.lastIndexOf('.');
    if (dot > 0) {
      renameInputEl.value.setSelectionRange(0, dot);
    } else {
      renameInputEl.value.select();
    }
  }

  return await new Promise<string | null>((resolve) => {
    renameResolver = resolve;
  });
}

// #580 & #581 — Escape key closes rename prompt, overwrite prompt, or custom export window
function onGlobalKeydown(e: KeyboardEvent) {
  if (!props.open) return;
  if (e.key === 'Escape') {
    if (renamePromptOpen.value) {
      e.preventDefault();
      e.stopPropagation();
      cancelRenamePrompt();
      return;
    }
    if (overwritePromptOpen.value) {
      e.preventDefault();
      e.stopPropagation();
      settleOverwritePrompt('cancel');
      return;
    }
    if (!exporting.value) {
      e.preventDefault();
      e.stopPropagation();
      emit('close');
    }
    return;
  }
  if (overwritePromptOpen.value && !renamePromptOpen.value && !e.metaKey && !e.ctrlKey) {
    const k = e.key.toLowerCase();
    if (k === 'o') {
      e.preventDefault();
      settleOverwritePrompt('overwrite');
    } else if (k === 'r') {
      e.preventDefault();
      settleOverwritePrompt('rename');
    } else if (k === 'c') {
      e.preventDefault();
      settleOverwritePrompt('cancel');
    }
  }
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown, true);
  if (overwriteResolver) settleOverwritePrompt('cancel');
  if (renameResolver) cancelRenamePrompt();
});

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
  const ext = formatExtension(format.value);

  try {
    if (scope.value === 'current') {
      const tab = tabs.activeTab;
      if (!tab) {
        throw new Error(isZh.value ? '当前没有打开的文档' : 'No active document');
      }
      const rawName = (tab as { fileName?: string; title?: string }).fileName || (tab as { title?: string }).title || 'Untitled';
      const baseName = rawName.replace(/\.[^.]+$/, '') || 'Untitled';
      const desiredPath = joinOutputPath(outDir, `${baseName}.${ext}`);
      const targetPath = await resolveExportTargetConflict(desiredPath);
      if (!targetPath) return;
      const finalFileName = splitExportPath(targetPath).fileName;
      progressText.value = isZh.value ? `正在导出 ${finalFileName}…` : `Exporting ${finalFileName}…`;
      await exporter.exportNoteToFile({
        content: tab.content ?? '',
        baseName,
        filePath: tab.filePath,
        outputPath: targetPath,
        format: format.value,
        includeBookmarks: settings.exportHtmlWithNav,
        includeTocPage: settings.exportIncludeTocPage,
        htmlPaginated: settings.exportHtmlPaginated,
        htmlContentWidth: settings.exportHtmlContentWidth,
      });
      lastExportedPath.value = targetPath;
      const msg = isZh.value ? `导出成功：${targetPath}` : `Exported to: ${targetPath}`;
      statusMessage.value = msg;
      statusKind.value = 'ok';
      notifyExportSuccess(msg, outDir);
    } else {
      const folder = sourceFolder.value.trim();
      if (!folder) {
        throw new Error(isZh.value ? '请选择要导出的源文件夹' : 'Please select a source folder');
      }
      progressText.value = isZh.value ? '正在扫描文件夹中的 Markdown 文档…' : 'Scanning folder for Markdown notes…';
      const mdFiles = await collectMarkdownFiles(
        folder,
        includeSubfolders.value,
        mergeIntoSingleDocument.value,
      );
      const realNoteFiles = mdFiles.filter((f) => !f.emptyDir);
      if (realNoteFiles.length === 0) {
        throw new Error(isZh.value ? '所选文件夹中没有找到 .md 文档' : 'No .md files found in the selected folder');
      }
      if (mergeIntoSingleDocument.value) {
        const folderName = folder.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || 'Exported-Book';
        const desiredPath = joinOutputPath(outDir, `${folderName}.${ext}`);
        const targetPath = await resolveExportTargetConflict(desiredPath);
        if (!targetPath) return;
        const mergedNotes: MergedNoteInput[] = [];
        let noteIdx = 0;
        for (let i = 0; i < mdFiles.length; i++) {
          const item = mdFiles[i];
          if (item.emptyDir) {
            mergedNotes.push({
              relDir: item.relDir,
              baseName: '',
              content: '',
              emptyDir: true,
            });
            continue;
          }
          noteIdx++;
          progressText.value = isZh.value
            ? `正在读取并合并章节 (${noteIdx} / ${realNoteFiles.length})：${item.baseName}`
            : `Reading & merging section (${noteIdx} / ${realNoteFiles.length}): ${item.baseName}`;
          const loaded = await invoke<string | { content: string }>('read_file', { path: item.path });
          const raw = typeof loaded === 'string' ? loaded : loaded?.content ?? '';
          mergedNotes.push({
            path: item.path,
            relDir: item.relDir,
            baseName: item.baseName,
            content: raw,
          });
        }
        const mergedContent = buildMergedBookMarkdown(folderName, mergedNotes);
        const finalFileName = splitExportPath(targetPath).fileName;
        progressText.value = isZh.value
          ? `正在生成合集文档：${finalFileName}…`
          : `Generating combined document: ${finalFileName}…`;
        await exporter.exportNoteToFile({
          content: mergedContent,
          baseName: folderName,
          filePath: joinOutputPath(folder, `${folderName}.md`),
          outputPath: targetPath,
          format: format.value,
          includeBookmarks: settings.exportHtmlWithNav,
          includeTocPage: settings.exportIncludeTocPage,
          htmlPaginated: settings.exportHtmlPaginated,
          htmlContentWidth: settings.exportHtmlContentWidth,
        });
        lastExportedPath.value = targetPath;
        const msg = isZh.value
          ? `合集导出完成：已将 ${realNoteFiles.length} 篇笔记合并导出至 ${targetPath}`
          : `Combined export complete: ${realNoteFiles.length} notes merged into ${targetPath}`;
        statusMessage.value = msg;
        statusKind.value = 'ok';
        notifyExportSuccess(msg, outDir);
      } else {
        let exportedCount = 0;
        let lastPath = outDir;
        for (let i = 0; i < realNoteFiles.length; i++) {
          const item = realNoteFiles[i];
          progressText.value = isZh.value
            ? `正在批量导出 (${i + 1} / ${realNoteFiles.length})：${item.baseName}.${ext}`
            : `Batch exporting (${i + 1} / ${realNoteFiles.length}): ${item.baseName}.${ext}`;
          const loaded = await invoke<string | { content: string }>('read_file', { path: item.path });
          const content = typeof loaded === 'string' ? loaded : loaded?.content ?? '';
          const relFile = item.relDir ? `${item.relDir}/${item.baseName}.${ext}` : `${item.baseName}.${ext}`;
          const desiredPath = joinOutputPath(outDir, relFile);
          const targetPath = await resolveExportTargetConflict(desiredPath);
          if (!targetPath) return;
          await exporter.exportNoteToFile({
            content,
            baseName: item.baseName,
            filePath: item.path,
            outputPath: targetPath,
            format: format.value,
            includeBookmarks: settings.exportHtmlWithNav,
            includeTocPage: settings.exportIncludeTocPage,
            htmlPaginated: settings.exportHtmlPaginated,
            htmlContentWidth: settings.exportHtmlContentWidth,
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
        notifyExportSuccess(msg, outDir);
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
  <div
    v-if="open"
    class="custom-export-backdrop"
    @pointerdown="onBackdropPointerDown"
    @pointerup="onBackdropPointerUp"
    @click.self="onBackdropClick"
  >
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
          <!-- #554 — the path is taken from the Explorer's selected row on
               open; browsing still overrides it for this session. -->
          <p class="custom-export__hint">
            {{ isZh
              ? '打开窗口时自动填入导航树选中的文件夹（选中文件时取其所在文件夹），也可手动浏览修改。'
              : 'Filled from the Explorer selection on open (a selected file uses its parent folder); you can still browse to override it.' }}
          </p>
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
            <option value="epub">{{ isZh ? 'EPUB 电子书 (.epub，需 Pandoc)' : 'EPUB eBook (.epub, requires Pandoc)' }}</option>
            <option value="odt">{{ isZh ? 'ODT 文档 (.odt，需 Pandoc)' : 'OpenDocument Text (.odt, requires Pandoc)' }}</option>
            <option value="latex">{{ isZh ? 'LaTeX 文档 (.tex，需 Pandoc)' : 'LaTeX Document (.tex, requires Pandoc)' }}</option>
            <option value="rtf">{{ isZh ? 'RTF 富文本 (.rtf，需 Pandoc)' : 'Rich Text Format (.rtf, requires Pandoc)' }}</option>
            <option value="png">{{ isZh ? 'PNG 长图 (.png)' : 'PNG Image (.png)' }}</option>
            <option value="textpack">{{ isZh ? 'TextPack 自包含单文件容器 (.textpack)' : 'TextPack Self-Contained Bundle (.textpack)' }}</option>
          </select>
          <template v-if="format !== 'png' && format !== 'textpack'">
            <label class="custom-export__checkbox" style="margin-top: 4px;">
              <input
                type="checkbox"
                :checked="settings.exportHtmlWithNav"
                @change="settings.setExportHtmlWithNav(($event.target as HTMLInputElement).checked)"
              />
              <span>{{ isZh ? '添加书签栏内容（HTML包含搜索面板）' : 'Include bookmark sidebar (HTML includes global search panel)' }}</span>
            </label>
            <label class="custom-export__checkbox" style="margin-top: 2px;">
              <input
                type="checkbox"
                :checked="settings.exportIncludeTocPage"
                @change="settings.setExportIncludeTocPage(($event.target as HTMLInputElement).checked)"
              />
              <span>{{ isZh ? '添加目录页（文档开头的目录含页码）' : 'Include Table of Contents page (leading TOC with page numbers)' }}</span>
            </label>
            <label
              v-if="format === 'html'"
              class="custom-export__checkbox"
              :class="{ 'custom-export__checkbox--disabled': !settings.exportHtmlWithNav }"
              style="margin-top: 2px;"
              :title="isZh
                ? '当选中该选项时，HTML文档右侧内容面板，将以原笔记文件为粒度分开载入。'
                : 'When enabled, the right content pane loads notes one page at a time per source note file.'"
            >
              <input
                type="checkbox"
                :disabled="!settings.exportHtmlWithNav"
                :checked="settings.exportHtmlWithNav && settings.exportHtmlPaginated"
                @change="settings.setExportHtmlPaginated(($event.target as HTMLInputElement).checked)"
              />
              <span>{{ isZh ? 'HTML分页载入' : 'Paginated HTML loading' }}</span>
            </label>
          </template>
        </div>

        <!-- #584 — HTML desktop content display width setting -->
        <div v-if="format === 'html'" class="custom-export__field">
          <label class="custom-export__label">{{ isZh ? 'HTML内容显示宽度（像素）' : 'HTML Content Width (px)' }}</label>
          <div class="custom-export__row custom-export__width-row">
            <input
              type="number"
              min="0"
              step="50"
              class="custom-export__input custom-export__width-input"
              :value="settings.exportHtmlContentWidth"
              @input="onHtmlWidthInput"
            />
            <span class="custom-export__unit">px</span>
            <span v-if="htmlWidthWarning" class="custom-export__bubble" role="status">
              {{ htmlWidthWarning }}
            </span>
          </div>
          <p class="custom-export__hint">
            {{ isZh
              ? '0：不限制，内容铺满页面（默认 960 px；仅针对桌面端生效，手机端自动自适应全宽）。'
              : '0 = unlimited full width (default 960 px; applies to desktop screens, mobile adapts automatically).' }}
          </p>
        </div>

        <!-- #553 — optional user-supplied .docx used as a Word reference doc. -->
        <div v-if="format === 'docx'" class="custom-export__field">
          <label class="custom-export__label">{{ isZh ? '自定义 Word 模板 (.docx)' : 'Custom Word Template (.docx)' }}</label>
          <div class="custom-export__row">
            <input
              type="text"
              class="custom-export__input"
              :value="settings.docxReferenceDoc"
              spellcheck="false"
              :placeholder="isZh ? '可选：使用自己的 Word 模板…' : 'Optional: use your own Word template…'"
              @change="settings.setDocxReferenceDoc(($event.target as HTMLInputElement).value.trim())"
            />
            <button type="button" class="custom-export__btn" @click="pickDocxTemplate">
              {{ isZh ? '浏览…' : 'Browse…' }}
            </button>
            <button
              v-if="settings.docxReferenceDoc"
              type="button"
              class="custom-export__btn"
              @click="settings.setDocxReferenceDoc('')"
            >
              {{ isZh ? '清除' : 'Clear' }}
            </button>
          </div>
          <p class="custom-export__hint">
            {{ isZh
              ? '导出时套用模板中的字体、标题/正文样式、主题配色与页面尺寸页边距；页眉页脚仍由内置「Word 导出样式」决定。'
              : 'Applies the template fonts, heading/body styles, theme colours and page size/margins. Headers and footers still come from the built-in Word preset.' }}
          </p>
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

    <!-- #581 — Export Overwrite Confirmation Dialog -->
    <div
      v-if="overwritePromptOpen"
      class="custom-export-subbackdrop"
      @click.self="settleOverwritePrompt('cancel')"
    >
      <div class="custom-export-subdialog" role="alertdialog" aria-modal="true">
        <div class="custom-export__header">
          <h3>{{ isZh ? '导出覆盖确认' : 'Confirm Overwrite' }}</h3>
          <button type="button" class="custom-export__close" @click="settleOverwritePrompt('cancel')">✕</button>
        </div>
        <div class="custom-export__body">
          <p class="custom-export__prompt-msg">
            {{ isZh
              ? `目标文件“${overwriteTargetName}”已存在，请选择后续操作：`
              : `Target file "${overwriteTargetName}" already exists. Choose an action:` }}
          </p>
          <p class="custom-export__hint" style="word-break: break-all;">{{ overwriteTargetPath }}</p>
        </div>
        <div class="custom-export__subfooter">
          <button
            type="button"
            class="custom-export__btn custom-export__btn--primary"
            @click="settleOverwritePrompt('overwrite')"
          >
            {{ isZh ? '覆盖(O)' : 'Overwrite (O)' }}
          </button>
          <button
            type="button"
            class="custom-export__btn"
            @click="settleOverwritePrompt('rename')"
          >
            {{ isZh ? '重命名(R)' : 'Rename (R)' }}
          </button>
          <button
            type="button"
            class="custom-export__btn"
            @click="settleOverwritePrompt('cancel')"
          >
            {{ isZh ? '取消(C)' : 'Cancel (C)' }}
          </button>
        </div>
      </div>
    </div>

    <!-- #581 — New File Name `(1)` Dialog -->
    <div
      v-if="renamePromptOpen"
      class="custom-export-subbackdrop"
      @click.self="cancelRenamePrompt"
    >
      <div class="custom-export-subdialog" role="dialog" aria-modal="true">
        <div class="custom-export__header">
          <h3>{{ isZh ? '新文件名' : 'New File Name' }}</h3>
          <button type="button" class="custom-export__close" @click="cancelRenamePrompt">✕</button>
        </div>
        <div class="custom-export__body">
          <label class="custom-export__label">{{ isZh ? '请输入导出文件的新名称：' : 'Enter new export file name:' }}</label>
          <input
            ref="renameInputEl"
            v-model="renameInputValue"
            type="text"
            class="custom-export__input"
            spellcheck="false"
            @keydown.enter.prevent="confirmRenamePrompt"
          />
        </div>
        <div class="custom-export__subfooter">
          <button
            type="button"
            class="custom-export__btn custom-export__btn--primary"
            @click="confirmRenamePrompt"
          >
            {{ isZh ? '确定(O)' : 'OK (O)' }}
          </button>
          <button
            type="button"
            class="custom-export__btn"
            @click="cancelRenamePrompt"
          >
            {{ isZh ? '取消(C)' : 'Cancel (C)' }}
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
  /* The #553 Word-template field makes the dialog taller on short windows. */
  max-height: min(70vh, 620px);
  overflow-y: auto;
}
.custom-export__hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-muted);
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
.custom-export__checkbox--disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.custom-export__width-row {
  position: relative;
  flex-wrap: wrap;
}
.custom-export__width-input {
  max-width: 150px;
  flex: 0 0 150px;
}
.custom-export__unit {
  font-size: 12px;
  color: var(--text-muted);
}
.custom-export__bubble {
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  margin-left: 4px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.35;
  color: #92400e;
  background: #fef3c7;
  border: 1px solid #f59e0b;
  box-shadow: 0 2px 8px rgba(245, 158, 11, 0.16);
}
.custom-export__bubble::before {
  content: '';
  position: absolute;
  left: -5px;
  top: 50%;
  width: 8px;
  height: 8px;
  background: #fef3c7;
  border-left: 1px solid #f59e0b;
  border-bottom: 1px solid #f59e0b;
  transform: translateY(-50%) rotate(45deg);
}
.custom-export-subbackdrop {
  position: fixed;
  inset: 0;
  z-index: 2300;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.custom-export-subdialog {
  width: min(460px, 100%);
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 20px 56px rgba(0, 0, 0, 0.36);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.custom-export__prompt-msg {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--text);
}
.custom-export__subfooter {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  background: var(--bg-elev);
}
</style>
