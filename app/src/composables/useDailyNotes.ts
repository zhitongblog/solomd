/**
 * F3 Daily Notes — open or create a daily note file for any date.
 *
 * Workflow:
 *   1. Resolve `<workspace>/<dailyNotesFolder>/<formatted>.md`.
 *   2. If the file already exists, open it.
 *   3. Otherwise materialize the configured template (or the built-in
 *      `defaultDailyTemplate` if the user left the setting empty), write it,
 *      then open the new file in the current window.
 *
 * We rely on `write_binary_file` to create the file because it also creates
 * any missing parent directory (which `write_file` does not). For an
 * existence check we attempt `read_file` first — cheaper than wiring a
 * dedicated `file_exists` Tauri command and good enough for daily notes.
 *
 * The settings fields (`dailyNotesFolder`, `dailyNotesFormat`,
 * `dailyNotesTemplate`) are read from `useSettingsStore`. The parent harness
 * is responsible for adding them — see SUMMARY.md for the contract.
 */

import { invoke } from '@tauri-apps/api/core';
import { sep } from '@tauri-apps/api/path';
import { useFiles } from './useFiles';
import { useWorkspaceStore } from '../stores/workspace';
import { useSettingsStore } from '../stores/settings';
import { useToastsStore } from '../stores/toasts';
import { useI18n } from '../i18n';
import {
  formatDailyFilename,
  applyTemplate,
  defaultDailyTemplate,
} from '../lib/daily-notes';

const DEFAULT_FOLDER = 'Daily';
const DEFAULT_FORMAT = 'YYYY-MM-DD.md';

interface DailySettings {
  dailyNotesFolder: string;
  dailyNotesFormat: string;
  dailyNotesTemplate: string;
}

/**
 * Pluck Daily-Notes settings off the settings store, defaulting whatever
 * isn't there yet (the parent harness adds these fields, but this composable
 * also has to function before that's wired up).
 */
function readDailySettings(): DailySettings {
  const s = useSettingsStore() as unknown as Record<string, unknown>;
  const folder = typeof s.dailyNotesFolder === 'string' ? s.dailyNotesFolder : '';
  const format = typeof s.dailyNotesFormat === 'string' ? s.dailyNotesFormat : '';
  const template = typeof s.dailyNotesTemplate === 'string' ? s.dailyNotesTemplate : '';
  return {
    dailyNotesFolder: folder.trim() || DEFAULT_FOLDER,
    dailyNotesFormat: format.trim() || DEFAULT_FORMAT,
    dailyNotesTemplate: template,
  };
}

function joinPath(...parts: string[]): string {
  // `sep()` is a string accessor on @tauri-apps/api/path. On macOS/Linux it's
  // '/', on Windows '\\'. We strip leading/trailing separators on inner parts
  // so user-typed `Daily/` or `/Daily` both work.
  const s = sep();
  return parts
    .filter((p) => !!p)
    .map((p, i) => {
      if (i === 0) return p.replace(/[/\\]+$/g, '');
      return p.replace(/^[/\\]+/g, '').replace(/[/\\]+$/g, '');
    })
    .join(s);
}

function shiftDate(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function stem(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await invoke('read_file', { path });
    return true;
  } catch {
    return false;
  }
}

export function useDailyNotes() {
  const files = useFiles();
  const workspace = useWorkspaceStore();
  const toasts = useToastsStore();
  const { lang } = useI18n();

  /**
   * Resolve `(folder, fullPath, filename)` for a given date based on current
   * settings + workspace folder. Returns null if there is no workspace open.
   */
  function resolveDailyPath(date: Date): {
    folder: string;
    filename: string;
    fullPath: string;
  } | null {
    const ws = workspace.currentFolder;
    if (!ws) return null;
    const cfg = readDailySettings();
    const filename = formatDailyFilename(date, cfg.dailyNotesFormat);
    const dir = joinPath(ws, cfg.dailyNotesFolder);
    const fullPath = joinPath(dir, filename);
    return { folder: dir, filename, fullPath };
  }

  async function openDateNote(date: Date): Promise<void> {
    const resolved = resolveDailyPath(date);
    if (!resolved) {
      toasts.warning('Open a folder first to use daily notes.');
      return;
    }
    const { fullPath, filename } = resolved;

    if (await fileExists(fullPath)) {
      await files.openPath(fullPath, { bypassNewWindow: true });
      return;
    }

    // Materialize template. Empty user template → fall back to the built-in.
    const cfg = readDailySettings();
    const tmpl = cfg.dailyNotesTemplate.trim()
      ? cfg.dailyNotesTemplate
      : defaultDailyTemplate(lang.value === 'zh' ? 'zh' : 'en');

    const prevStem = stem(formatDailyFilename(shiftDate(date, -1), cfg.dailyNotesFormat));
    const nextStem = stem(formatDailyFilename(shiftDate(date, 1), cfg.dailyNotesFormat));
    const body = applyTemplate(tmpl, date, prevStem, nextStem);

    try {
      // `write_binary_file` is used here (rather than `write_file`) because
      // it creates missing parent directories for us.
      const bytes = Array.from(new TextEncoder().encode(body));
      await invoke('write_binary_file', { path: fullPath, data: bytes });
    } catch (e) {
      toasts.error(`Failed to create ${filename}: ${e}`);
      return;
    }

    await files.openPath(fullPath, { bypassNewWindow: true });
  }

  async function openTodayNote(): Promise<void> {
    return openDateNote(new Date());
  }

  async function openYesterday(): Promise<void> {
    return openDateNote(shiftDate(new Date(), -1));
  }

  async function openTomorrow(): Promise<void> {
    return openDateNote(shiftDate(new Date(), 1));
  }

  return {
    openDateNote,
    openTodayNote,
    openYesterday,
    openTomorrow,
    resolveDailyPath,
  };
}
