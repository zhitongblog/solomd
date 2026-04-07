import { useFiles } from './useFiles';
import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import { useExport } from './useExport';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

export interface Command {
  id: string;
  title: string;
  hint?: string;
  shortcut?: string;
  run: () => void | Promise<void>;
}

export function useCommands(): Command[] {
  const files = useFiles();
  const settings = useSettingsStore();
  const tabs = useTabsStore();
  const exporter = useExport();

  return [
    { id: 'file.new', title: 'New Markdown File', shortcut: 'Ctrl+N', run: () => files.newFile() },
    { id: 'file.newText', title: 'New Plain Text File', shortcut: 'Ctrl+Alt+N', run: () => files.newTextFile() },
    { id: 'file.open', title: 'Open File…', shortcut: 'Ctrl+O', run: () => files.openFile() },
    { id: 'file.save', title: 'Save', shortcut: 'Ctrl+S', run: () => files.saveActive() },
    { id: 'file.saveAs', title: 'Save As…', shortcut: 'Ctrl+Shift+S', run: () => files.saveActiveAs() },
    {
      id: 'file.openFolder',
      title: 'Open Folder…',
      hint: 'Browse files in the sidebar',
      run: () => files.openFolder(),
    },
    { id: 'file.closeTab', title: 'Close Tab', shortcut: 'Ctrl+W', run: () => tabs.activeId && files.closeTabSafe(tabs.activeId) },

    { id: 'view.editor', title: 'View: Edit Only', run: () => settings.setViewMode('edit') },
    { id: 'view.split', title: 'View: Split', run: () => settings.setViewMode('split') },
    { id: 'view.preview', title: 'View: Preview Only', run: () => settings.setViewMode('preview') },
    { id: 'view.cycleView', title: 'View: Cycle Mode', shortcut: 'Ctrl+Shift+P', run: () => settings.cycleViewMode() },
    { id: 'view.toggleOutline', title: 'View: Toggle Outline', shortcut: 'Ctrl+Shift+O', run: () => settings.toggleOutline() },
    { id: 'view.toggleFileTree', title: 'View: Toggle File Tree', shortcut: 'Ctrl+B', run: () => settings.toggleFileTree() },
    { id: 'view.toggleWrap', title: 'View: Toggle Word Wrap', run: () => settings.toggleWordWrap() },
    { id: 'view.toggleLineNumbers', title: 'View: Toggle Line Numbers', run: () => settings.toggleLineNumbers() },
    { id: 'view.toggleTheme', title: 'View: Toggle Theme', run: () => settings.toggleTheme() },
    { id: 'view.toggleLivePreview', title: 'View: Toggle Live Preview / Raw Source (Markdown)', run: () => settings.toggleLivePreview() },

    { id: 'export.html', title: 'Export to HTML…', run: () => exporter.exportHtml() },
    { id: 'export.docx', title: 'Export to Word (DOCX)…', run: () => exporter.exportDocx() },
    { id: 'export.pdf', title: 'Export to PDF…', run: () => exporter.exportPdf() },
    { id: 'export.pdfPrint', title: 'Export to PDF via System Print…', shortcut: 'Ctrl+P', run: () => exporter.exportPdfPrint() },
    { id: 'export.copyHtml', title: 'Copy as HTML', run: () => exporter.copyAsHtml() },
    { id: 'export.copyPlain', title: 'Copy as Plain Text', run: () => exporter.copyAsPlainText() },
    { id: 'export.copyMd', title: 'Copy as Markdown', run: () => exporter.copyAsMarkdown() },

    {
      id: 'help.markdown',
      title: 'Markdown Cheatsheet',
      shortcut: 'F1 / Ctrl+/',
      hint: 'Quick reference for Markdown syntax',
      run: () => {
        // Triggered via App-level event since useCommands has no DOM access.
        window.dispatchEvent(new CustomEvent('solomd:open-help'));
      },
    },
    {
      id: 'window.new',
      title: 'New Window',
      shortcut: 'Ctrl+Shift+N',
      run: async () => {
        const label = `solomd-${Date.now()}`;
        try {
          const win = new WebviewWindow(label, {
            url: '/',
            title: 'SoloMD',
            width: 1000,
            height: 700,
          });
          win.once('tauri://error', (e) => console.error('window error', e));
        } catch (e) {
          console.error('failed to create window', e);
        }
      },
    },
  ];
}
