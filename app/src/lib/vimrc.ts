/**
 * #492 — Minimal `.vimrc` key-mapping parser & applier for CodeMirror Vim mode.
 *
 * Supports standard Vim mapping directives (one per line, `#` or `"` comments
 * ignored):
 *   - `map <lhs> <rhs>` / `noremap <lhs> <rhs>`
 *   - `nmap <lhs> <rhs>` / `nnoremap <lhs> <rhs>`
 *   - `imap <lhs> <rhs>` / `inoremap <lhs> <rhs>`
 *   - `vmap <lhs> <rhs>` / `vnoremap <lhs> <rhs>`
 */

export type VimMapContext = 'normal' | 'insert' | 'visual';

export interface ParsedVimMapping {
  recursive: boolean;
  lhs: string;
  rhs: string;
  context?: VimMapContext;
}

export interface VimMapperLike {
  map: (lhs: string, rhs: string, ctx?: VimMapContext) => void;
  noremap: (lhs: string, rhs: string, ctx?: VimMapContext) => void;
}

const CMD_CONTEXT: Record<string, { recursive: boolean; context?: VimMapContext }> = {
  map: { recursive: true },
  noremap: { recursive: false },
  nmap: { recursive: true, context: 'normal' },
  nnoremap: { recursive: false, context: 'normal' },
  imap: { recursive: true, context: 'insert' },
  inoremap: { recursive: false, context: 'insert' },
  vmap: { recursive: true, context: 'visual' },
  vnoremap: { recursive: false, context: 'visual' },
};

/**
 * Parse a multi-line `.vimrc` snippet into structured key mappings.
 */
export function parseVimrcMappings(vimrc: string): ParsedVimMapping[] {
  if (!vimrc || !vimrc.trim()) return [];
  const out: ParsedVimMapping[] = [];
  const lines = vimrc.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('"') || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([a-z]+)\s+(\S+)\s+(.+)$/i);
    if (!match) continue;
    const cmd = match[1].toLowerCase();
    const spec = CMD_CONTEXT[cmd];
    if (!spec) continue;
    const lhs = match[2].trim();
    const rhs = match[3].trim();
    if (!lhs || !rhs) continue;
    out.push({
      recursive: spec.recursive,
      lhs,
      rhs,
      ...(spec.context ? { context: spec.context } : {}),
    });
  }
  return out;
}

const appliedEntries: Array<{ lhs: string; context?: VimMapContext }> = [];

/**
 * Apply user `.vimrc` mappings to the `@replit/codemirror-vim` `Vim` API.
 */
export function applyVimrcMappings(
  vimrc: string,
  vimApi: VimMapperLike & { unmap?: (lhs: string, ctx?: VimMapContext) => void },
): number {
  if (typeof vimApi.unmap === 'function') {
    while (appliedEntries.length > 0) {
      const prev = appliedEntries.pop()!;
      try {
        vimApi.unmap(prev.lhs, prev.context);
      } catch {
        // Ignore unmap errors
      }
    }
  } else {
    appliedEntries.length = 0;
  }

  const mappings = parseVimrcMappings(vimrc);
  let count = 0;
  for (const m of mappings) {
    try {
      if (m.recursive) {
        vimApi.map(m.lhs, m.rhs, m.context);
      } else {
        vimApi.noremap(m.lhs, m.rhs, m.context);
      }
      appliedEntries.push({ lhs: m.lhs, context: m.context });
      count++;
    } catch {
      // Ignore invalid mapping syntax
    }
  }
  return count;
}
