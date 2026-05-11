import { invoke } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import { useSettingsStore } from '../stores/settings';

/**
 * Open a file in the user-configured external editor, or fall back to the
 * OS default handler when no custom editor is set.
 */
export async function openInExternalEditor(filePath: string): Promise<void> {
  const settings = useSettingsStore();
  const editor = settings.externalEditorPath.trim();
  if (editor) {
    await invoke('open_in_external_editor', { editor, filePath });
  } else {
    await openPath(filePath);
  }
}
