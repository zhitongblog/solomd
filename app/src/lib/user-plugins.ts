/**
 * user-plugins.ts — Lightweight User Extensions & Declarative Scripts (#173)
 *
 * Allows users to extend SoloMD without compiling source code via declarative
 * JSON plugin manifests stored in localStorage (`solomd.userPlugins.v1`) and/or
 * `<workspace>/.solomd/plugins/*.json`:
 *   1. Custom `/` Slash Commands (with `${date}`, `${time}`, `${datetime}`,
 *      `${cursor}`, `${selection}`, `${uuid}` placeholders).
 *   2. Custom Text Transforms (Regex find/replace pipelines or Template wrappers
 *      registered directly in the Command Palette `Cmd/Ctrl+P`).
 *   3. Custom Webhook / HTTP Publishers (POST/PUT current note markdown +
 *      metadata to a custom blog API, webhook, or automation endpoint).
 */

import { invoke } from '@tauri-apps/api/core';
import type { SlashBlock } from './slash-blocks';

export interface UserPluginSlashCommand {
  id: string;
  icon?: string;
  label: string;
  hint?: string;
  snippet: string;
  keywords?: string[];
}

export interface UserPluginTransform {
  id: string;
  title: string;
  hint?: string;
  kind: 'regex' | 'template' | 'webhook';
  /** For kind === 'regex': regular expression pattern */
  find?: string;
  /** For kind === 'regex': replacement string */
  replace?: string;
  /** For kind === 'regex': regex flags (default 'gm') */
  flags?: string;
  /** For kind === 'template': template using ${content}, ${title}, ${date}, ${time} */
  template?: string;
  /** For kind === 'webhook': HTTP endpoint to POST/PUT note payload */
  webhookUrl?: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
}

export interface UserPluginManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  slashCommands?: UserPluginSlashCommand[];
  transforms?: UserPluginTransform[];
}

const STORAGE_KEY = 'solomd.userPlugins.v1';

export const STARTER_PLUGIN_PRESETS: UserPluginManifest[] = [
  {
    id: 'callout-pack',
    name: 'GitHub Alerts & Callouts Pack',
    version: '1.0.0',
    description: 'Adds /note, /tip, /important, /warning, and /caution slash commands.',
    enabled: true,
    slashCommands: [
      {
        id: 'note',
        icon: 'ℹ',
        label: 'Callout: Note',
        hint: '> [!NOTE]',
        snippet: '> [!NOTE]\n> ${cursor}',
        keywords: ['note', 'callout', 'alert', 'info'],
      },
      {
        id: 'tip',
        icon: '💡',
        label: 'Callout: Tip',
        hint: '> [!TIP]',
        snippet: '> [!TIP]\n> ${cursor}',
        keywords: ['tip', 'callout', 'alert', 'hint'],
      },
      {
        id: 'warning',
        icon: '⚠',
        label: 'Callout: Warning',
        hint: '> [!WARNING]',
        snippet: '> [!WARNING]\n> ${cursor}',
        keywords: ['warning', 'callout', 'alert', 'warn'],
      },
    ],
  },
  {
    id: 'timestamp-meeting-pack',
    name: 'Timestamps & Meeting Notes Pack',
    version: '1.0.0',
    description: 'Adds /now, /today, /meeting slash commands and a date-header transform.',
    enabled: true,
    slashCommands: [
      {
        id: 'today',
        icon: '📅',
        label: 'Insert Today Date',
        hint: 'YYYY-MM-DD',
        snippet: '${date}${cursor}',
        keywords: ['date', 'today', 'riqi'],
      },
      {
        id: 'now',
        icon: '🕒',
        label: 'Insert Current Timestamp',
        hint: 'YYYY-MM-DD HH:mm',
        snippet: '${datetime}${cursor}',
        keywords: ['now', 'time', 'timestamp', 'shijian'],
      },
      {
        id: 'meeting',
        icon: '📋',
        label: 'Meeting Notes Template',
        hint: '## Meeting (${date})',
        snippet:
          '## Meeting Notes (${date})\n\n- **Attendees**: ${cursor}\n- **Agenda**:\n  1. \n- **Action Items**:\n  - [ ] ',
        keywords: ['meeting', 'minutes', 'agenda', 'huiyi'],
      },
    ],
    transforms: [
      {
        id: 'prepend-date-stamp',
        title: 'Plugin: Prepend Last-Updated Stamp',
        hint: 'Insert > Updated: YYYY-MM-DD HH:mm at top of note',
        kind: 'template',
        template: '> Updated: ${datetime}\n\n${content}',
      },
    ],
  },
];

export function formatDynamicTokens(raw: string, now: Date = new Date()): string {
  if (!raw.includes('${')) return raw;
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const min = pad(now.getMinutes());
  const dateStr = `${yyyy}-${mm}-${dd}`;
  const timeStr = `${hh}:${min}`;
  const datetimeStr = `${dateStr} ${timeStr}`;
  return raw
    .split('${date}').join(dateStr)
    .split('${time}').join(timeStr)
    .split('${datetime}').join(datetimeStr);
}

let memoryFallbackPlugins: string | null = null;

function readRawStorage(): string | null {
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
      return localStorage.getItem(STORAGE_KEY);
    }
  } catch {
    /* Node 25 without --localstorage-file throws SecurityError */
  }
  return memoryFallbackPlugins;
}

function writeRawStorage(val: string): void {
  memoryFallbackPlugins = val;
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
      localStorage.setItem(STORAGE_KEY, val);
    }
  } catch {
    /* ignore storage quota or Node SecurityError */
  }
}

export function getUserPlugins(): UserPluginManifest[] {
  try {
    const raw = readRawStorage();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is UserPluginManifest =>
        p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string',
    );
  } catch {
    return [];
  }
}

export function saveUserPlugins(plugins: UserPluginManifest[]): void {
  writeRawStorage(JSON.stringify(plugins));
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('solomd:user-plugins-updated'));
    }
  } catch {
    /* ignore */
  }
}

export function getActiveUserSlashBlocks(): SlashBlock[] {
  const plugins = getUserPlugins();
  const out: SlashBlock[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (!plugin.enabled || !Array.isArray(plugin.slashCommands)) continue;
    for (const cmd of plugin.slashCommands) {
      if (!cmd.id || !cmd.label || typeof cmd.snippet !== 'string') continue;
      const blockId = `plugin_${plugin.id}_${cmd.id}`;
      if (seen.has(blockId)) continue;
      seen.add(blockId);
      out.push({
        id: cmd.id,
        icon: cmd.icon || '⚡',
        label: cmd.label,
        hint: cmd.hint || plugin.name,
        snippet: formatDynamicTokens(cmd.snippet),
        keywords: cmd.keywords ?? [cmd.id, plugin.id],
      });
    }
  }
  return out;
}

export function applyUserTransformSync(
  transform: UserPluginTransform,
  content: string,
  meta: { title?: string; filePath?: string | null } = {},
  now: Date = new Date(),
): string {
  if (transform.kind === 'regex') {
    if (!transform.find) return content;
    const re = new RegExp(transform.find, transform.flags || 'gm');
    const replacement = formatDynamicTokens(transform.replace ?? '', now);
    return content.replace(re, replacement);
  }
  if (transform.kind === 'template') {
    const tpl = transform.template ?? '${content}';
    return formatDynamicTokens(tpl, now)
      .split('${title}')
      .join(meta.title || 'Untitled')
      .split('${path}')
      .join(meta.filePath || '')
      .split('${content}')
      .join(content);
  }
  return content;
}

export async function runUserTransform(
  transform: UserPluginTransform,
  content: string,
  meta: { title?: string; filePath?: string | null } = {},
): Promise<{ content: string; message: string }> {
  if (transform.kind === 'webhook') {
    if (!transform.webhookUrl) {
      throw new Error('Webhook URL is missing in plugin configuration');
    }
    const resp = await fetch(transform.webhookUrl, {
      method: transform.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(transform.headers || {}),
      },
      body: JSON.stringify({
        title: meta.title || 'Untitled',
        filePath: meta.filePath || null,
        content,
        timestamp: new Date().toISOString(),
      }),
    });
    if (!resp.ok) {
      throw new Error(`Webhook HTTP ${resp.status}`);
    }
    return {
      content,
      message: `Published to ${transform.webhookUrl} (HTTP ${resp.status})`,
    };
  }
  const next = applyUserTransformSync(transform, content, meta);
  return {
    content: next,
    message: `Applied "${transform.title}"`,
  };
}

/**
 * Load `.solomd/plugins/*.json` from the active workspace directory and merge
 * any discovered manifests into the user plugins store.
 */
export async function syncWorkspacePlugins(workspaceDir: string): Promise<UserPluginManifest[]> {
  if (!workspaceDir) return getUserPlugins();
  const sep = workspaceDir.includes('\\') ? '\\' : '/';
  const pluginsDir = `${workspaceDir.replace(/[\\/]+$/, '')}${sep}.solomd${sep}plugins`;
  try {
    const exists = await invoke<boolean>('fs_dir_exists', { path: pluginsDir });
    if (!exists) return getUserPlugins();
    const entries = await invoke<Array<{ name: string; path: string; is_dir: boolean }>>(
      'list_dir',
      { path: pluginsDir, showHidden: true },
    );
    const current = getUserPlugins();
    const byId = new Map<string, UserPluginManifest>(current.map((p) => [p.id, p]));
    let changed = false;
    for (const entry of entries) {
      if (entry.is_dir || !entry.name.endsWith('.json')) continue;
      try {
        const res = await invoke<{ content: string }>('read_file', { path: entry.path });
        const parsed = JSON.parse(res.content) as UserPluginManifest;
        if (parsed && typeof parsed.id === 'string' && typeof parsed.name === 'string') {
          const prev = byId.get(parsed.id);
          byId.set(parsed.id, {
            ...parsed,
            enabled: prev ? prev.enabled : parsed.enabled !== false,
          });
          changed = true;
        }
      } catch {
        /* skip malformed json */
      }
    }
    const merged = Array.from(byId.values());
    if (changed) saveUserPlugins(merged);
    return merged;
  } catch {
    return getUserPlugins();
  }
}

export async function writePluginToWorkspace(
  workspaceDir: string,
  plugin: UserPluginManifest,
): Promise<string> {
  const sep = workspaceDir.includes('\\') ? '\\' : '/';
  const base = workspaceDir.replace(/[\\/]+$/, '');
  const solomdDir = `${base}${sep}.solomd`;
  const pluginsDir = `${solomdDir}${sep}plugins`;
  try {
    await invoke('fs_create_dir', { path: solomdDir });
  } catch {}
  try {
    await invoke('fs_create_dir', { path: pluginsDir });
  } catch {}
  const safeId = plugin.id.replace(/[^a-zA-Z0-9_-]/g, '-');
  const filePath = `${pluginsDir}${sep}${safeId}.json`;
  await invoke('write_file', {
    path: filePath,
    content: JSON.stringify(plugin, null, 2) + '\n',
    encoding: 'UTF-8',
    hadBom: false,
  });
  return filePath;
}
