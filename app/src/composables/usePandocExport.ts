/**
 * F5 — composable that drives Pandoc-backed export (EPUB / ODT / LaTeX /
 * RTF / custom template) and lazy-loads the user's bibliography for
 * citation autocomplete.
 *
 * Pandoc itself is **not bundled** — we look it up on PATH via the Rust
 * `pandoc_detect` command. If missing, the export call returns a structured
 * error which we surface as a toast with a hint to install pandoc.
 *
 * The composable expects two settings fields on the settings store:
 *
 *   - `workspaceBibliography: string` — path to a `.bib` or `.csl-json`.
 *   - `workspaceCsl: string` — path to a CSL style file (default Chicago).
 *
 * These are not yet on `stores/settings.ts` — adding them is the parent's
 * job (see SUMMARY.md). Until they exist, this file references them via a
 * `// @ts-ignore` shim so it still type-checks.
 */
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useTabsStore } from '../stores/tabs';
import { useToastsStore } from '../stores/toasts';
// NOTE: the parent must add `workspaceBibliography: string` and
// `workspaceCsl: string` fields (defaults `''`) to `stores/settings.ts`
// before this file's exportTo / loadCitations will pick them up. We import
// the existing store so the shape can be augmented later without changing
// imports here.
import { useSettingsStore } from '../stores/settings';
import { track } from '../lib/telemetry';
import {
  parseBibFile,
  parseCslJson,
  type CitationEntry,
} from '../lib/citations';

export interface PandocInfo {
  path: string;
  version: string;
}

export type PandocFormat = 'epub' | 'odt' | 'latex' | 'rtf' | 'custom';

interface ExportOptions {
  /** Path to a custom pandoc template (used for `format === 'custom'`). */
  template?: string;
  /** Extra pandoc CLI args appended verbatim. */
  extraArgs?: string[];
}

interface FormatSpec {
  ext: string;
  filterName: string;
  /** Extra args passed to pandoc on top of the standard set. */
  extraArgs: string[];
}

const FORMATS: Record<Exclude<PandocFormat, 'custom'>, FormatSpec> = {
  epub: { ext: 'epub', filterName: 'EPUB', extraArgs: [] },
  odt: { ext: 'odt', filterName: 'OpenDocument Text', extraArgs: [] },
  // standalone forces a complete LaTeX document (preamble + \begin{document}).
  latex: { ext: 'tex', filterName: 'LaTeX', extraArgs: ['--standalone'] },
  rtf: { ext: 'rtf', filterName: 'Rich Text Format', extraArgs: ['--standalone'] },
};

// ---------------------------------------------------------------------------
// Front-matter helpers
// ---------------------------------------------------------------------------

/**
 * Pull `bibliography:` / `csl:` from the YAML front matter of the active
 * doc. We do a simple regex parse rather than pulling in a YAML library —
 * pandoc itself reads the front matter on export, so this only matters for
 * choosing which file to pass via `--bibliography=`.
 */
function parseFrontMatterCitationFields(content: string): {
  bibliography?: string;
  csl?: string;
} {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const yaml = m[1];
  const out: { bibliography?: string; csl?: string } = {};
  const bibMatch = yaml.match(/^bibliography\s*:\s*(.+?)\s*$/m);
  if (bibMatch) out.bibliography = stripYamlQuotes(bibMatch[1]);
  const cslMatch = yaml.match(/^csl\s*:\s*(.+?)\s*$/m);
  if (cslMatch) out.csl = stripYamlQuotes(cslMatch[1]);
  return out;
}

function stripYamlQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Citation cache
// ---------------------------------------------------------------------------

interface CitationCache {
  path: string;
  entries: CitationEntry[];
}

let citationCache: CitationCache | null = null;

function detectCitationFormat(path: string): 'bib' | 'csl-json' {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.csl-json') || lower.endsWith('.cslj')) {
    return 'csl-json';
  }
  return 'bib';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function usePandocExport() {
  const tabs = useTabsStore();
  const toasts = useToastsStore();
  const settings = useSettingsStore();

  async function detectPandoc(): Promise<PandocInfo | null> {
    try {
      const info = await invoke<PandocInfo | null>('pandoc_detect');
      return info ?? null;
    } catch (e) {
      console.error('[pandoc_detect]', e);
      return null;
    }
  }

  function activeContext(): { content: string; baseName: string } | null {
    const tab = tabs.activeTab;
    if (!tab) {
      toasts.error('No active document');
      return null;
    }
    const name = (tab as { fileName?: string; title?: string }).fileName
      ?? (tab as { title?: string }).title
      ?? 'Untitled';
    return {
      content: tab.content ?? '',
      baseName: name.replace(/\.[^.]+$/, ''),
    };
  }

  /**
   * Resolve bibliography + csl paths, preferring per-doc front matter over
   * workspace settings. Empty strings → undefined so the Rust side knows
   * to skip the `--citeproc` flags entirely.
   */
  function resolveCitationFlags(content: string): {
    bibliography?: string;
    csl?: string;
  } {
    const fm = parseFrontMatterCitationFields(content);
    // Read settings via cast: parent may not yet have added the fields.
    const s = settings as unknown as {
      workspaceBibliography?: string;
      workspaceCsl?: string;
    };
    const bib = (fm.bibliography || s.workspaceBibliography || '').trim();
    const csl = (fm.csl || s.workspaceCsl || '').trim();
    return {
      bibliography: bib || undefined,
      csl: csl || undefined,
    };
  }

  async function exportTo(
    format: PandocFormat,
    activeContent?: string,
    opts: ExportOptions = {}
  ): Promise<void> {
    const ctx = activeContext();
    if (!ctx) return;
    const content = activeContent ?? ctx.content;

    // Detect pandoc up front so the user gets a clear "install pandoc"
    // error before we open the save dialog.
    const info = await detectPandoc();
    if (!info) {
      toasts.error(
        'Pandoc not found. Install it from https://pandoc.org/installing.html and retry.'
      );
      return;
    }

    let ext = 'out';
    let filterName = 'File';
    const extraArgs: string[] = [];
    if (format === 'custom') {
      // For custom templates we let pandoc choose by extension — user
      // must pick a sensible filename (.docx, .pdf, .html, …) in the
      // dialog. Default to .out so they're forced to think about it.
      ext = '*';
      filterName = 'Pandoc output';
      if (opts.template) extraArgs.push(`--template=${opts.template}`);
    } else {
      const spec = FORMATS[format];
      ext = spec.ext;
      filterName = spec.filterName;
      extraArgs.push(...spec.extraArgs);
    }
    if (opts.extraArgs) extraArgs.push(...opts.extraArgs);

    const filters =
      ext === '*'
        ? [{ name: 'All Files', extensions: ['*'] }]
        : [{ name: filterName, extensions: [ext] }];
    const outputPath = await saveDialog({
      defaultPath: `${ctx.baseName}.${ext === '*' ? 'out' : ext}`,
      filters,
    });
    if (!outputPath) return;

    const { bibliography, csl } = resolveCitationFlags(content);

    track('file_exported', { format: `pandoc_${format}` });
    const tid = toasts.info(`Exporting via Pandoc (${format})…`, 0);
    try {
      await invoke('pandoc_export', {
        args: {
          input_markdown: content,
          format,
          output_path: outputPath,
          bibliography: bibliography ?? null,
          csl: csl ?? null,
          template: opts.template ?? null,
          extra_args: extraArgs,
        },
      });
      toasts.dismiss(tid);
      toasts.success(`Exported to ${format.toUpperCase()}`);
    } catch (e) {
      toasts.dismiss(tid);
      const msg = typeof e === 'string' ? e : (e as Error)?.message || String(e);
      toasts.error(`Pandoc export failed: ${msg}`);
    }
  }

  /**
   * Read the workspace bibliography from disk, parse it, and cache by
   * path. Returns an empty array if no bibliography is configured or the
   * file can't be read.
   */
  async function loadCitations(): Promise<CitationEntry[]> {
    const s = settings as unknown as { workspaceBibliography?: string };
    const path = (s.workspaceBibliography || '').trim();
    if (!path) {
      citationCache = null;
      return [];
    }
    if (citationCache && citationCache.path === path) {
      return citationCache.entries;
    }
    try {
      // The Rust `read_file` command returns `{ content, encoding, … }`.
      const result = await invoke<{ content: string }>('read_file', { path });
      const content = result?.content ?? '';
      const entries =
        detectCitationFormat(path) === 'csl-json'
          ? parseCslJson(content)
          : parseBibFile(content);
      citationCache = { path, entries };
      return entries;
    } catch (e) {
      console.error('[loadCitations]', e);
      citationCache = null;
      return [];
    }
  }

  /** Force the next `loadCitations()` call to re-read from disk. */
  function invalidateCitationsCache() {
    citationCache = null;
  }

  return {
    detectPandoc,
    exportTo,
    loadCitations,
    invalidateCitationsCache,
  };
}
