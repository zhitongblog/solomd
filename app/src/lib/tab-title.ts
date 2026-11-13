/**
 * Derive a human-readable tab title from the document's first non-empty line
 * when `tabTitleFromFirstLine` is enabled in Settings.
 *
 * Useful when SoloMD is launched as an external editor by third-party tools
 * that pass temporary / UUID / hash filenames (`a8f3c91b-4d2e.md`).
 */

const MAX_TITLE_CHARS = 48;

export function extractFirstLineTitle(content: string | undefined | null): string {
  if (!content) return '';
  const lines = content.slice(0, 8192).split(/\r?\n/);
  let i = 0;
  let fmTitle = '';

  // Skip leading YAML frontmatter if present on line 0 (`---\n...\n---`), OR
  // headless/dangling frontmatter (`inbox: true\n---`) left behind if the
  // opening `---` fence was accidentally deleted.
  if (lines[0]?.replace(/^\uFEFF/, '').trim() === '---') {
    i = 1;
    let closed = false;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (t === '---' || t === '...') {
        closed = true;
        i++;
        break;
      }
      const m = /^title\s*:\s*(.+)$/i.exec(t);
      if (m && !fmTitle) {
        fmTitle = m[1].trim().replace(/^["']|["']$/g, '').trim();
      }
      i++;
    }
    if (!closed) i = 1;
  } else {
    let j = 0;
    let sawYamlKey = false;
    const scanLimit = Math.min(lines.length, 25);
    while (j < scanLimit) {
      const t = lines[j].trim();
      if (t === '---' || t === '...') {
        if (sawYamlKey) {
          i = j + 1;
        }
        break;
      }
      if (/^[a-zA-Z0-9_-]+\s*:\s*(?:.*)?$/.test(t)) {
        sawYamlKey = true;
        const m = /^title\s*:\s*(.+)$/i.exec(t);
        if (m && !fmTitle) {
          fmTitle = m[1].trim().replace(/^["']|["']$/g, '').trim();
        }
        j++;
        continue;
      }
      break;
    }
  }

  for (; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    // Skip fence lines and thematic breaks.
    if (/^(`{3,}|~{3,})/.test(raw)) continue;
    if (/^(---|\*\*\*|___)\s*$/.test(raw)) continue;

    // Strip block-level Markdown prefixes (headings, blockquotes, lists, tasks).
    let cleaned = raw
      .replace(/^(?:>\s*)+/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/\s+#+\s*$/, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');

    // Strip inline Markdown wrappers (`![alt](url)`, `[label](url)`, `**`, `==`, `~~`, `` ` ``, HTML tags).
    cleaned = cleaned
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias || target)
      .replace(/<[^>]+>/g, '')
      .replace(/(\*\*|__|==|~~|`)/g, '')
      .replace(/^\*+|\*+$/g, '')
      .trim();

    if (!cleaned) continue;
    if (cleaned.length > MAX_TITLE_CHARS) {
      return `${cleaned.slice(0, MAX_TITLE_CHARS).trimEnd()}…`;
    }
    return cleaned;
  }

  if (fmTitle) {
    return fmTitle.length > MAX_TITLE_CHARS
      ? `${fmTitle.slice(0, MAX_TITLE_CHARS).trimEnd()}…`
      : fmTitle;
  }
  return '';
}

export function displayTabTitle(
  tab: { fileName: string; content?: string } | null | undefined,
  useFirstLine: boolean,
): string {
  if (!tab) return '';
  if (!useFirstLine) return tab.fileName;
  return extractFirstLineTitle(tab.content) || tab.fileName;
}

export function displayTabTooltip(
  tab: { fileName: string; filePath?: string | null; content?: string } | null | undefined,
  useFirstLine: boolean,
): string {
  if (!tab) return '';
  const base = tab.filePath || tab.fileName;
  if (!useFirstLine) return base;
  const first = extractFirstLineTitle(tab.content);
  if (!first || first === tab.fileName) return base;
  return `${first} — ${base}`;
}
