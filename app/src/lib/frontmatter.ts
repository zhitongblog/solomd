/**
 * F2 — Frontmatter splice helpers for the Type-driven sidebar.
 *
 * SoloMD keeps "types" 100% Markdown-native (Tolaria-compatible): membership
 * and type-definition metadata all live in a note's YAML frontmatter block.
 * Editing that metadata must NOT clobber the rest of the file — so instead of
 * re-serializing whole documents we splice ONLY the leading `---\n…\n---`
 * frontmatter block and leave the body bytes untouched.
 *
 * Two surfaces use this:
 *   - `patchTypeDef(name, patch)` in stores/types.ts — edit a type-definition
 *     note's presentation keys (icon/color/order/…).
 *   - `setMemberType(path, name)` — set/replace a member note's `type:` field.
 *
 * We use `js-yaml` (already a dependency, see lib/markdown.ts) to parse the
 * existing block into an object, apply the patch, then re-dump just that block.
 * Comments inside the frontmatter are not preserved (js-yaml limitation) — the
 * type-definition notes are app-managed so this is acceptable; for member
 * notes we keep the edit surface to the single `type` key to minimise churn.
 */
import yaml from 'js-yaml';

/** Matches a leading YAML frontmatter block: `---\n …\n---\n`. */
const FM_RE = /^(﻿)?(---\r?\n[\s\S]*?\r?\n---)(\r?\n|$)/;

export interface SplitDoc {
  /** A leading BOM, if the file had one (preserved on write). */
  bom: string;
  /** Parsed frontmatter object (empty object when there was no block). */
  data: Record<string, unknown>;
  /** Whether the source actually had a frontmatter block. */
  hadBlock: boolean;
  /** Everything after the frontmatter block (verbatim). */
  body: string;
}

/**
 * Split a document into its frontmatter object and the untouched body.
 * Never throws: malformed YAML yields `data: {}` + the whole text as body so
 * callers can still operate (they'll just rewrite the block cleanly).
 */
export function splitFrontmatter(text: string): SplitDoc {
  const m = FM_RE.exec(text);
  if (!m) {
    const bom = text.startsWith('﻿') ? '﻿' : '';
    return { bom, data: {}, hadBlock: false, body: bom ? text.slice(1) : text };
  }
  const bom = m[1] ?? '';
  const inner = m[2].replace(/^---\r?\n/, '').replace(/\r?\n---$/, '');
  let data: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(inner);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  const body = text.slice(m[0].length);
  return { bom, data, hadBlock: true, body };
}

/** Serialize a frontmatter object into a `---\n…\n---` block (no trailing nl). */
export function dumpFrontmatter(data: Record<string, unknown>): string {
  const yamlStr = yaml
    .dump(data, { lineWidth: -1, noRefs: true, skipInvalid: true })
    .replace(/\n$/, '');
  return `---\n${yamlStr}\n---`;
}

/**
 * Apply `patch` to a document's frontmatter and return the new full text.
 *
 * - Keys whose patched value is `undefined` are DELETED from the frontmatter.
 * - All other body bytes are preserved exactly.
 * - When the source had no frontmatter block, one is created and the original
 *   body is kept after a blank-line separator.
 */
export function patchFrontmatter(
  text: string,
  patch: Record<string, unknown>,
): string {
  const { bom, data, hadBlock, body } = splitFrontmatter(text);
  const next: Record<string, unknown> = { ...data };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  const block = dumpFrontmatter(next);
  if (hadBlock) {
    // `body` begins right after the closing `---` (its newline was consumed by
    // FM_RE group 3), so re-attach with a single newline.
    return `${bom}${block}\n${body}`;
  }
  // No prior block: insert one, keep the original body after a blank separator.
  const sep = body.length ? (body.startsWith('\n') ? '\n' : '\n\n') : '\n';
  return `${bom}${block}${sep}${body}`;
}
