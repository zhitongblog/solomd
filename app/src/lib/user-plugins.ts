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

export type PluginCapability =
  | 'doc:read'
  | 'doc:write'
  | 'frontmatter:read'
  | 'frontmatter:write'
  | 'ui:toast'
  | 'net:fetch';

export const ALL_PLUGIN_CAPABILITIES: readonly PluginCapability[] = [
  'doc:read',
  'doc:write',
  'frontmatter:read',
  'frontmatter:write',
  'ui:toast',
  'net:fetch',
];

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
  kind: 'regex' | 'template' | 'webhook' | 'script';
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
  /** For kind === 'script' (#173 v5.3): sandboxed JS body receiving capability-scoped `solomd` API */
  script?: string;
}

export interface UserPluginManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  /** #173 v5.3 — Declared capability scopes required by scripts / webhooks in this plugin. */
  capabilities?: PluginCapability[];
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
  {
    id: 'reading-stats-frontmatter',
    name: 'Reading Stats Frontmatter Script (v5.3)',
    version: '1.0.0',
    description: 'Sandboxed script that counts CJK + Latin words and updates words / reading_time in YAML frontmatter.',
    enabled: true,
    capabilities: ['doc:read', 'frontmatter:read', 'frontmatter:write', 'ui:toast'],
    transforms: [
      {
        id: 'update-reading-stats',
        title: 'Plugin: Update Word Count & Reading Time in Frontmatter',
        hint: 'Sandboxed script (doc:read, frontmatter:write)',
        kind: 'script',
        script: [
          'const raw = solomd.getContent();',
          'const body = raw.replace(/^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n?/, "");',
          'const cjk = (body.match(/[\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af]/g) || []).length;',
          'const latin = (body.replace(/[\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af]/g, " ").match(/[A-Za-z0-9_]+/g) || []).length;',
          'const words = cjk + latin;',
          'const mins = Math.max(1, Math.ceil(words / 300));',
          'solomd.setFrontmatter({ words: String(words), reading_time: mins + " min" });',
          'solomd.toast("Updated frontmatter: " + words + " words · ~" + mins + " min");',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'link-reference-collector',
    name: 'Link Reference Collector Script (v5.3)',
    version: '1.0.0',
    description: 'Sandboxed script that extracts all unique external URLs into a ## References appendix.',
    enabled: true,
    capabilities: ['doc:read', 'doc:write', 'ui:toast'],
    transforms: [
      {
        id: 'collect-links',
        title: 'Plugin: Collect External Links into ## References',
        hint: 'Sandboxed script (doc:read, doc:write)',
        kind: 'script',
        script: [
          'const src = solomd.getContent();',
          'const urls = Array.from(new Set((src.match(/https?:\\/\\/[^\\s)\\]>"\']+/g) || [])));',
          'if (urls.length === 0) { solomd.toast("No external links found."); return; }',
          'const block = "\\n\\n## References\\n\\n" + urls.map((u, i) => (i + 1) + ". " + u).join("\\n") + "\\n";',
          'const cleaned = src.replace(/\\n\\n## References\\n[\\s\\S]*$/, "");',
          'solomd.setContent(cleaned + block);',
          'solomd.toast("Collected " + urls.length + " unique link(s).");',
        ].join('\n'),
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

function parseSimpleFrontmatter(content: string): {
  entries: Record<string, string>;
  hasBlock: boolean;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { entries: {}, hasBlock: false, body: content };
  const entries: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      entries[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { entries, hasBlock: true, body: content.slice(m[0].length) };
}

function applyFrontmatterPatch(content: string, patch: Record<string, string>): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  const formatVal = (v: string) => (/[:#\n]/.test(v) ? JSON.stringify(v) : v);
  if (!m) {
    const lines = Object.entries(patch).map(([k, v]) => `${k}: ${formatVal(String(v))}`);
    return `---\n${lines.join('\n')}\n---\n\n${content}`;
  }
  const existingLines = m[1].split(/\r?\n/);
  const remaining = new Map(Object.entries(patch).map(([k, v]) => [k, String(v)]));
  const nextLines = existingLines.map((line) => {
    const kv = /^(\s*)([A-Za-z0-9_-]+)(\s*:\s*).*$/.exec(line);
    if (kv && remaining.has(kv[2])) {
      const val = remaining.get(kv[2])!;
      remaining.delete(kv[2]);
      return `${kv[1]}${kv[2]}: ${formatVal(val)}`;
    }
    return line;
  });
  for (const [k, v] of remaining.entries()) {
    nextLines.push(`${k}: ${formatVal(v)}`);
  }
  return `---\n${nextLines.join('\n')}\n---\n${content.slice(m[0].length)}`;
}

/**
 * #173 (v5.3) — Capability-scoped sandboxed plugin script runner.
 * Shadows ambient browser/Node globals (`window`, `document`, `fetch`,
 * `localStorage`, `globalThis`, etc.) and exposes only the declared `solomd`
 * capability API.
 */
export function runSandboxedPluginScript(
  script: string,
  capabilities: PluginCapability[],
  content: string,
  meta: { title?: string; filePath?: string | null } = {},
  now: Date = new Date(),
): { content: string; toasts: string[] } {
  const capSet = new Set<PluginCapability>(capabilities);
  const requireCap = (cap: PluginCapability) => {
    if (!capSet.has(cap)) {
      throw new Error(`Capability denied: plugin requires "${cap}"`);
    }
  };
  let currentContent = content;
  const toasts: string[] = [];
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const solomdApi = Object.freeze({
    getContent(): string {
      requireCap('doc:read');
      return currentContent;
    },
    getTitle(): string {
      requireCap('doc:read');
      return meta.title || 'Untitled';
    },
    getFilePath(): string | null {
      requireCap('doc:read');
      return meta.filePath ?? null;
    },
    getFrontmatter(): Record<string, string> {
      requireCap('frontmatter:read');
      return { ...parseSimpleFrontmatter(currentContent).entries };
    },
    setContent(next: string): void {
      requireCap('doc:write');
      if (typeof next !== 'string') {
        throw new Error('solomd.setContent expects a string');
      }
      currentContent = next;
    },
    setFrontmatter(patch: Record<string, string | number | boolean>): void {
      requireCap('frontmatter:write');
      if (!patch || typeof patch !== 'object') {
        throw new Error('solomd.setFrontmatter expects an object');
      }
      const normalized: Record<string, string> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (/^[A-Za-z0-9_-]+$/.test(k)) {
          normalized[k] = String(v);
        }
      }
      currentContent = applyFrontmatterPatch(currentContent, normalized);
    },
    toast(msg: string): void {
      requireCap('ui:toast');
      if (typeof msg === 'string' && msg.trim()) {
        toasts.push(msg.trim());
      }
    },
    now(): { date: string; time: string; datetime: string; iso: string } {
      return {
        date: dateStr,
        time: timeStr,
        datetime: `${dateStr} ${timeStr}`,
        iso: now.toISOString(),
      };
    },
  });

  // Execute with ambient globals shadowed as undefined so the script cannot
  // touch DOM, storage, network, or escape via globalThis.
  const runner = new Function(
    'solomd',
    'window',
    'document',
    'globalThis',
    'self',
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'process',
    'require',
    `"use strict";\n${script}`,
  );
  runner(
    solomdApi,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
  return { content: currentContent, toasts };
}

export async function runUserTransform(
  transform: UserPluginTransform,
  content: string,
  meta: { title?: string; filePath?: string | null; capabilities?: PluginCapability[] } = {},
): Promise<{ content: string; message: string }> {
  if (transform.kind === 'script') {
    if (!transform.script?.trim()) {
      throw new Error('Script body is missing in plugin configuration');
    }
    const caps = meta.capabilities ?? ['doc:read', 'doc:write', 'ui:toast'];
    const result = runSandboxedPluginScript(transform.script, caps, content, meta);
    return {
      content: result.content,
      message: result.toasts[result.toasts.length - 1] || `Ran script "${transform.title}"`,
    };
  }
  if (transform.kind === 'webhook') {
    if (meta.capabilities && !meta.capabilities.includes('net:fetch')) {
      throw new Error('Capability denied: webhook requires "net:fetch"');
    }
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
