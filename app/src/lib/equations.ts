/**
 * Equation numbering and cross-references.
 *
 * LaTeX has had `\label` / `\eqref` forever and KaTeX does not implement them:
 * a labelled equation renders as an error, and a cross-reference renders as
 * the literal text `\eqref{maxwell}`. So anyone writing a document with
 * numbered equations has been numbering them by hand and hoping nobody
 * inserts one in the middle.
 *
 * This is a source-to-source pass, run before markdown-it (`preprocessMarkdown`)
 * so every consumer gets it at once — preview, PDF, Word, image export:
 *
 *   - Each display block containing `\label{x}` gets the next number, written
 *     as `\tag{n}` (which KaTeX *does* support) and an `<a id="eq-x">` anchor.
 *   - `\eqref{x}` in the prose becomes a link `[(n)](#eq-x)`; `\ref{x}` the
 *     same without the parentheses.
 *   - A block that already carries an explicit `\tag{...}` keeps it and does
 *     not consume a number — the author overrode it on purpose.
 *
 * A reference to a label that does not exist is left exactly as written. A
 * silent `(?)` would hide the typo; the raw text is a visible one.
 */

export interface EquationRef {
  label: string;
  /** What a reference renders as — usually a number, or the author's `\tag`. */
  display: string;
}

const LABEL_RE = /\\label\s*\{([^}]+)\}/;
const TAG_RE = /\\tag\s*\{([^}]*)\}/;

/** Display-math spans (`$$ … $$`), skipping fenced code. */
interface MathBlock {
  start: number;
  end: number;
}

function findMathBlocks(lines: string[]): MathBlock[] {
  const out: MathBlock[] = [];
  let inFence = false;
  let mathStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (mathStart < 0 && (t.startsWith('```') || t.startsWith('~~~'))) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (mathStart < 0) {
      if (!t.startsWith('$$')) continue;
      // `$$x$$` on one line is a complete block.
      if (t.length > 2 && t.endsWith('$$')) {
        out.push({ start: i, end: i });
        continue;
      }
      mathStart = i;
      continue;
    }
    if (t.endsWith('$$')) {
      out.push({ start: mathStart, end: i });
      mathStart = -1;
    }
  }
  return out;
}

/**
 * Number the labelled equations and resolve the references to them.
 *
 * Returns the rewritten source plus the label → display map, which the editor
 * uses for autocomplete.
 */
export function numberEquations(source: string): { text: string; refs: EquationRef[] } {
  if (!source.includes('\\label') && !source.includes('\\eqref') && !source.includes('\\ref')) {
    return { text: source, refs: [] };
  }
  const lines = source.split('\n');
  const blocks = findMathBlocks(lines);
  const refs: EquationRef[] = [];
  const byLabel = new Map<string, string>();

  let counter = 0;
  // Anchors are inserted before their block, so collect and apply afterwards
  // rather than shifting line indices mid-scan.
  const anchors = new Map<number, string>();

  for (const block of blocks) {
    const body = lines.slice(block.start, block.end + 1).join('\n');
    const label = LABEL_RE.exec(body);
    if (!label) continue;
    const name = label[1].trim();
    const existingTag = TAG_RE.exec(body);
    const display = existingTag ? existingTag[1].trim() : String(++counter);

    let rewritten = body.replace(LABEL_RE, existingTag ? '' : `\\tag{${display}}`);
    // `\label` sat on its own line often enough that removing it can leave a
    // blank line inside the math, which KaTeX renders as extra height.
    rewritten = rewritten
      .split('\n')
      .filter((l, idx, arr) => !(l.trim() === '' && idx > 0 && idx < arr.length - 1))
      .join('\n');

    for (let i = block.start; i <= block.end; i++) lines[i] = '';
    lines[block.start] = rewritten;
    anchors.set(block.start, name);

    // Later duplicates of a label keep their own number; the first one wins
    // for references, which is the only defensible reading of a duplicate.
    if (!byLabel.has(name)) {
      byLabel.set(name, display);
      refs.push({ label: name, display });
    }
  }

  const withAnchors: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const anchor = anchors.get(i);
    if (anchor) withAnchors.push(`<a id="eq-${anchor}"></a>`);
    // Blocks collapse to one line above; drop the emptied continuation lines.
    if (lines[i] === '' && anchors.has(i)) continue;
    withAnchors.push(lines[i]);
  }

  let text = withAnchors.join('\n');
  text = replaceReferences(text, byLabel);
  return { text, refs };
}

/** `\eqref{x}` → `[(n)](#eq-x)`, `\ref{x}` → `[n](#eq-x)`, outside code. */
function replaceReferences(text: string, byLabel: Map<string, string>): string {
  if (byLabel.size === 0) return text;
  const lines = text.split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      const t = line.trim();
      if (t.startsWith('```') || t.startsWith('~~~')) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(
        /\\(eqref|ref)\s*\{([^}]+)\}/g,
        (whole, kind: string, name: string) => {
          const display = byLabel.get(name.trim());
          if (!display) return whole;
          return kind === 'eqref'
            ? `[(${display})](#eq-${name.trim()})`
            : `[${display}](#eq-${name.trim()})`;
        },
      );
    })
    .join('\n');
}

/** Labels defined in a document, for `\eqref{` autocomplete. */
export function collectLabels(source: string): EquationRef[] {
  return numberEquations(source).refs;
}

// ---------------------------------------------------------------------------
// Locating the formula under the caret (for the formula editor).
// ---------------------------------------------------------------------------

export interface MathSpan {
  /** Character offsets of the whole span, delimiters included. */
  from: number;
  to: number;
  /** The LaTeX between the delimiters, trimmed. */
  body: string;
  /** `$$…$$` (block) vs `$…$` (inline). */
  display: boolean;
}

/**
 * The math span containing `offset`, or null.
 *
 * Scans delimiters rather than parsing: the editor needs an answer for a
 * half-typed formula too, and a parser would refuse those. `$$` is checked
 * before `$` so a block is never mistaken for two empty inline spans, and a
 * `\$` escape is skipped so prices in prose do not open a formula.
 */
export function findMathSpanAt(text: string, offset: number): MathSpan | null {
  const spans: MathSpan[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] !== '$') {
      i++;
      continue;
    }
    const isBlock = text[i + 1] === '$';
    const delim = isBlock ? '$$' : '$';
    const start = i;
    let j = i + delim.length;
    let close = -1;
    while (j < text.length) {
      if (text[j] === '\\') {
        j += 2;
        continue;
      }
      if (text.startsWith(delim, j)) {
        // For inline math, `$$` here means the span was empty — not a match.
        close = j;
        break;
      }
      j++;
    }
    if (close < 0) break;
    const end = close + delim.length;
    spans.push({
      from: start,
      to: end,
      body: text.slice(start + delim.length, close).trim(),
      display: isBlock,
    });
    i = end;
  }
  return spans.find((s) => offset >= s.from && offset <= s.to) ?? null;
}
