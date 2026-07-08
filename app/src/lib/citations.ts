/**
 * F5 citations: parse `.bib` and `.csl-json` reference databases into a
 * common shape used by autocomplete and inline preview rendering.
 *
 * The BibTeX parser here is **deliberately naive** — full BibTeX is its own
 * little programming language (string concatenation, @string macros,
 * crossref, etc.) and pandoc handles all of that on export. Our job is
 * limited to:
 *
 *   1. extracting citation keys for autocomplete,
 *   2. pulling enough author/year/title to render a useful completion
 *      detail and a `(Author Year)` style inline preview.
 *
 * Anything we miss (string macros, abbrev journals, etc.) is fine — pandoc
 * will read the file directly at export time.
 */

export interface CitationEntry {
  /** Citation key (the `@key` users type). */
  key: string;
  /** BibTeX type (article, book, inproceedings, …) or CSL `type`. */
  type: string;
  author?: string;
  title?: string;
  year?: string;
  journal?: string;
  booktitle?: string;
  publisher?: string;
  editor?: string;
  doi?: string;
  url?: string;
}

// ---------------------------------------------------------------------------
// BibTeX parsing
// ---------------------------------------------------------------------------

/**
 * Strip enclosing `{...}` or `"..."` and unwrap inner `{...}` groups (used
 * for protecting capitalisation). We do it iteratively so `{{Smith}}` →
 * `Smith`. We also collapse runs of whitespace because BibTeX files line-
 * wrap field values frequently.
 */
function cleanBibValue(raw: string): string {
  let v = raw.trim();
  // Strip outer wrappers repeatedly: `{ {x} }` → `x`.
  // Only one layer of quotes vs braces though.
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  while (v.startsWith('{') && v.endsWith('}')) {
    // Make sure outer braces actually wrap the whole string (not e.g.
    // `{Smith} and {Jones}`).
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < v.length; i++) {
      const c = v[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0 && i < v.length - 1) {
          wraps = false;
          break;
        }
      }
    }
    if (!wraps) break;
    v = v.slice(1, -1);
  }
  // Strip remaining inner braces (capitalisation guards).
  v = v.replace(/[{}]/g, '');
  // Collapse whitespace.
  v = v.replace(/\s+/g, ' ').trim();
  return v;
}

/**
 * Walk a single `@type{key, …}` entry. Returns the entry plus the index of
 * the closing brace (so the outer loop can resume). `start` should point at
 * the `@`.
 */
function parseBibEntry(
  src: string,
  start: number
): { entry: CitationEntry | null; end: number } {
  // Match `@type{` (or `@type(` — rare but legal).
  const head = /@(\w+)\s*[\{(]/y;
  head.lastIndex = start;
  const m = head.exec(src);
  if (!m) return { entry: null, end: start + 1 };
  const type = m[1].toLowerCase();
  // Skip BibTeX directives like @comment, @preamble, @string.
  if (type === 'comment' || type === 'preamble' || type === 'string') {
    // Find matching closing brace at depth 0.
    return { entry: null, end: skipBraces(src, head.lastIndex - 1) };
  }
  let i = head.lastIndex;
  // The first comma separates the key from fields.
  let commaIdx = -1;
  let depth = 1;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}' || c === ')') {
      depth--;
      if (depth === 0) {
        commaIdx = -1;
        return {
          entry: { key: src.slice(i, j).trim(), type },
          end: j + 1,
        };
      }
    } else if (c === ',' && depth === 1) {
      commaIdx = j;
      break;
    }
  }
  if (commaIdx < 0) return { entry: null, end: i };
  const key = src.slice(i, commaIdx).trim();
  const entry: CitationEntry = { key, type };

  // Now parse field=value pairs until matching closing brace.
  let p = commaIdx + 1;
  while (p < src.length) {
    // Skip leading whitespace + commas.
    while (p < src.length && /[\s,]/.test(src[p])) p++;
    if (p >= src.length) break;
    if (src[p] === '}' || src[p] === ')') {
      return { entry, end: p + 1 };
    }
    // Read field name.
    const fieldStart = p;
    while (p < src.length && /[\w-]/.test(src[p])) p++;
    if (p === fieldStart) {
      p++;
      continue;
    }
    const field = src.slice(fieldStart, p).toLowerCase();
    // Skip whitespace + `=`.
    while (p < src.length && /\s/.test(src[p])) p++;
    if (src[p] !== '=') {
      // malformed — skip to next comma at depth 1
      while (p < src.length && src[p] !== ',' && src[p] !== '}') p++;
      continue;
    }
    p++;
    while (p < src.length && /\s/.test(src[p])) p++;
    // Read the value: `{...}`, `"..."`, or a bare number/word.
    let valueStart = p;
    let valueEnd = p;
    if (src[p] === '{') {
      let d = 1;
      p++;
      const vs = p - 1;
      while (p < src.length && d > 0) {
        const c = src[p];
        if (c === '{') d++;
        else if (c === '}') d--;
        if (d === 0) break;
        p++;
      }
      valueStart = vs;
      valueEnd = p + 1;
      p++;
    } else if (src[p] === '"') {
      const vs = p;
      p++;
      while (p < src.length && src[p] !== '"') {
        if (src[p] === '\\') p++;
        p++;
      }
      valueStart = vs;
      valueEnd = p + 1;
      p++;
    } else {
      const vs = p;
      while (p < src.length && !/[,}\)\s]/.test(src[p])) p++;
      valueStart = vs;
      valueEnd = p;
    }
    const value = cleanBibValue(src.slice(valueStart, valueEnd));
    assignBibField(entry, field, value);
  }
  return { entry, end: p };
}

function assignBibField(entry: CitationEntry, field: string, value: string) {
  switch (field) {
    case 'author':
      entry.author = value;
      break;
    case 'title':
      entry.title = value;
      break;
    case 'year':
      entry.year = value;
      break;
    case 'date':
      // BibLaTeX uses `date = {2021-05-12}` → keep just the year.
      if (!entry.year) {
        const m = value.match(/(\d{4})/);
        if (m) entry.year = m[1];
      }
      break;
    case 'journal':
    case 'journaltitle':
      entry.journal = value;
      break;
    case 'booktitle':
      entry.booktitle = value;
      break;
    case 'publisher':
      entry.publisher = value;
      break;
    case 'editor':
      entry.editor = value;
      break;
    case 'doi':
      entry.doi = value;
      break;
    case 'url':
      entry.url = value;
      break;
  }
}

/** Find matching `}` (or `)`) starting at the given open-brace index. */
function skipBraces(src: string, openIdx: number): number {
  const open = src[openIdx];
  const close = open === '(' ? ')' : '}';
  let depth = 1;
  for (let i = openIdx + 1; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

export function parseBibFile(content: string): CitationEntry[] {
  const out: CitationEntry[] = [];
  // Strip BibTeX % comments line by line — pandoc treats `%` as a comment
  // start when not inside braces.
  const stripped = content
    .split('\n')
    .map((line) => {
      // Naive: only strip if `%` is the first non-whitespace char OR
      // appears outside any obvious quoted region. Field values rarely
      // contain `%`, so this is fine.
      const t = line.trimStart();
      if (t.startsWith('%')) return '';
      return line;
    })
    .join('\n');
  let i = 0;
  while (i < stripped.length) {
    const at = stripped.indexOf('@', i);
    if (at < 0) break;
    const { entry, end } = parseBibEntry(stripped, at);
    if (entry && entry.key) out.push(entry);
    i = Math.max(end, at + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CSL-JSON parsing
// ---------------------------------------------------------------------------

interface CslJsonItem {
  id: string;
  type?: string;
  title?: string;
  author?: Array<{ family?: string; given?: string; literal?: string }>;
  editor?: Array<{ family?: string; given?: string; literal?: string }>;
  issued?: { 'date-parts'?: number[][]; literal?: string; raw?: string };
  'container-title'?: string;
  publisher?: string;
  DOI?: string;
  URL?: string;
}

function formatCslName(n: { family?: string; given?: string; literal?: string }): string {
  if (n.literal) return n.literal;
  if (n.family && n.given) return `${n.given} ${n.family}`;
  return n.family || n.given || '';
}

function formatCslNames(arr: Array<{ family?: string; given?: string; literal?: string }> | undefined): string | undefined {
  if (!arr || arr.length === 0) return undefined;
  return arr.map(formatCslName).filter(Boolean).join(' and ');
}

function cslIssuedYear(issued: CslJsonItem['issued']): string | undefined {
  if (!issued) return undefined;
  if (issued['date-parts'] && issued['date-parts'][0] && issued['date-parts'][0][0]) {
    return String(issued['date-parts'][0][0]);
  }
  if (issued.literal) {
    const m = issued.literal.match(/(\d{4})/);
    if (m) return m[1];
  }
  if (issued.raw) {
    const m = issued.raw.match(/(\d{4})/);
    if (m) return m[1];
  }
  return undefined;
}

export function parseCslJson(content: string): CitationEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: CitationEntry[] = [];
  for (const raw of parsed as CslJsonItem[]) {
    if (!raw || typeof raw !== 'object' || !raw.id) continue;
    const entry: CitationEntry = {
      key: String(raw.id),
      type: (raw.type || 'misc').toString(),
    };
    const author = formatCslNames(raw.author);
    if (author) entry.author = author;
    const editor = formatCslNames(raw.editor);
    if (editor) entry.editor = editor;
    if (raw.title) entry.title = String(raw.title);
    const year = cslIssuedYear(raw.issued);
    if (year) entry.year = year;
    if (raw['container-title']) {
      const ct = String(raw['container-title']);
      // CSL doesn't distinguish journal vs booktitle. We put it in `journal`
      // for article-likes, `booktitle` for chapter-likes.
      if (
        entry.type === 'article-journal' ||
        entry.type === 'article' ||
        entry.type === 'article-magazine' ||
        entry.type === 'article-newspaper'
      ) {
        entry.journal = ct;
      } else {
        entry.booktitle = ct;
      }
    }
    if (raw.publisher) entry.publisher = String(raw.publisher);
    if (raw.DOI) entry.doi = String(raw.DOI);
    if (raw.URL) entry.url = String(raw.URL);
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Render a `(Author Year)` style inline preview. Falls back gracefully when
 * fields are missing — the goal is "give the user enough to recognise the
 * citation", not bibliographic correctness (pandoc handles that on export).
 */
export function formatInline(entry: CitationEntry): string {
  const author = shortAuthor(entry.author);
  const year = entry.year || 'n.d.';
  if (author) return `(${author} ${year})`;
  return `(${entry.key} ${year})`;
}

/** "Smith, John and Doe, Jane" → "Smith"; "Smith and Jones" → "Smith & Jones". */
function shortAuthor(author?: string): string | undefined {
  if (!author) return undefined;
  const parts = author.split(/\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const surnames = parts.map(extractSurname);
  if (surnames.length === 1) return surnames[0];
  if (surnames.length === 2) return `${surnames[0]} & ${surnames[1]}`;
  return `${surnames[0]} et al.`;
}

function extractSurname(name: string): string {
  // BibTeX forms: "Last, First" OR "First Last" OR a literal like
  // "{The Beatles}" (already brace-stripped).
  if (name.includes(',')) return name.split(',')[0].trim();
  const tokens = name.trim().split(/\s+/);
  return tokens[tokens.length - 1] || name;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Lightweight fuzzy match over key + author + title + year. Not a true
 * fuzzy algorithm (no Levenshtein) — substring + prefix scoring is enough
 * for picking a citation from a few hundred refs.
 */
export function searchCitations(entries: CitationEntry[], query: string): CitationEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice(0, 50);
  const ranked: Array<{ e: CitationEntry; score: number }> = [];
  for (const e of entries) {
    const keyLc = e.key.toLowerCase();
    const authorLc = (e.author || '').toLowerCase();
    const titleLc = (e.title || '').toLowerCase();
    const yearLc = (e.year || '').toLowerCase();
    let score = 0;
    if (keyLc === q) score = 200;
    else if (keyLc.startsWith(q)) score = 150;
    else if (keyLc.includes(q)) score = 100;
    if (authorLc.startsWith(q)) score = Math.max(score, 90);
    else if (authorLc.includes(q)) score = Math.max(score, 60);
    if (titleLc.startsWith(q)) score = Math.max(score, 80);
    else if (titleLc.includes(q)) score = Math.max(score, 50);
    if (yearLc === q) score = Math.max(score, 70);
    if (score > 0) ranked.push({ e, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.e.key.localeCompare(b.e.key));
  return ranked.slice(0, 50).map((r) => r.e);
}
