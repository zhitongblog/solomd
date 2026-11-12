/**
 * CodeMirror 6 LanguageTool checker — the grammar / style sibling of
 * `cm-spellcheck.ts`.
 *
 * Flow: on edit / scroll (debounced 1 s — LanguageTool is far slower than
 * Hunspell), collect the prose blocks around the viewport (or the whole note
 * with "check whole document"), convert them to AnnotatedText
 * (`lt-annotate.ts`), send the blocks we have no verdict for in batches, and
 * underline the matches.
 *
 * Results are cached per block *text* + config signature, so edits re-check
 * only the paragraph that changed, scrolling back costs nothing, and a reply
 * that lands after further typing is still valid for any block whose text it
 * describes. Underlines are mapped through edits immediately and dropped
 * where the edit touched them, so nothing stale lingers while typing.
 *
 * Failures (server down, bad key, rate limit) back off and report through
 * `reportLtError`, which also hands spelling back to Hunspell.
 */
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  closeHoverTooltips,
  hoverTooltip,
} from '@codemirror/view';
import type { DecorationSet, Tooltip } from '@codemirror/view';
import { useI18n } from '../i18n';
import {
  LT_REDRAW_EVENT,
  LT_SETTINGS_CHANGED_EVENT,
  issueLabel,
  isLtIgnored,
  ltAddWord,
  ltCheck,
  ltDisableRule,
  ltErrorCode,
  ltIgnore,
  matchWords,
  refreshPremiumWords,
  reportLtError,
  reportLtOk,
  resetLtHealth,
  runtimeConfig,
  type LtMatch,
  type LtRuntimeConfig,
} from './languagetool';
import {
  blockIndexFor,
  collectBlocks,
  frontMatterEnd,
  frontMatterLanguage,
  packBatches,
  type LtBlock,
} from './lt-annotate';

interface LtOptions {
  enabled: () => boolean;
}

/** A match placed in the document. */
export interface LtHit {
  from: number;
  to: number;
  text: string;
  match: LtMatch;
}

const DEBOUNCE_MS = 1000;
/** Characters checked beyond the viewport, so short scrolls are pre-warmed. */
const VIEWPORT_MARGIN = 3000;
const CACHE_LIMIT = 3000;
const BACKOFF_MS: Record<string, number> = {
  'rate-limited': 30_000,
  unreachable: 15_000,
  auth: 60_000,
  'no-credentials': 60_000,
};

/** Block-text cache shared by all editors (same paragraph in two panes = one
 *  request). Key: config signature + NUL + block source. Values hold
 *  block-relative offsets. */
const cache = new Map<string, LtMatch[]>();

function cacheGet(key: string): LtMatch[] | undefined {
  const v = cache.get(key);
  if (v) {
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

function cacheSet(key: string, v: LtMatch[]) {
  cache.set(key, v);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

let backoffUntil = 0;

/** Premium's AI rules (`QB_NEW_DE_…_ORTHOGRAPHY_SPELLING`, …) report typos as
 *  `issueType: grammar`. Treat them as spelling so they get the spelling
 *  underline and "Add to dictionary". */
export function normalizeMatch(m: LtMatch): LtMatch {
  if (m.issueType !== 'misspelling' && (m.categoryId === 'TYPOS' || /SPELLING|SPELLER/.test(m.ruleId))) {
    return { ...m, issueType: 'misspelling' };
  }
  return m;
}

function markFor(m: LtMatch): Decoration {
  const kind = m.issueType === 'misspelling'
    ? 'spelling'
    : m.issueType === 'grammar'
      ? 'grammar'
      : m.issueType === 'style' || m.issueType === 'locale-violation' || m.issueType === 'register'
        ? 'style'
        : 'other';
  return Decoration.mark({
    class: `cm-lt cm-lt-${kind}`,
    attributes: { 'data-lt-rule': m.ruleId },
    ltMatch: m,
  });
}

class LtPlugin {
  decorations: DecorationSet = Decoration.none;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerun = false;
  private destroyed = false;

  private onSettings = () => {
    resetLtHealth();
    backoffUntil = 0;
    this.schedule(0);
  };
  private onRedraw = () => this.render();

  constructor(private view: EditorView, private opts: LtOptions) {
    window.addEventListener(LT_SETTINGS_CHANGED_EVENT, this.onSettings);
    window.addEventListener(LT_REDRAW_EVENT, this.onRedraw);
    void refreshPremiumWords();
    this.schedule(300);
  }

  update(u: ViewUpdate) {
    if (u.docChanged) {
      let deco = this.decorations.map(u.changes);
      u.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
        deco = deco.update({
          filter: (from, to) => to < fromB || from > toB,
          filterFrom: fromB,
          filterTo: toB,
        });
      });
      this.decorations = deco;
    }
    if (u.docChanged || u.viewportChanged) this.schedule(DEBOUNCE_MS);
  }

  destroy() {
    this.destroyed = true;
    window.removeEventListener(LT_SETTINGS_CHANGED_EVENT, this.onSettings);
    window.removeEventListener(LT_REDRAW_EVENT, this.onRedraw);
    if (this.timer) clearTimeout(this.timer);
  }

  /** The underlined match covering `pos`, if any. */
  hitAt(pos: number, side: -1 | 1 = 1): LtHit | null {
    let hit: LtHit | null = null;
    this.decorations.between(pos, pos, (from, to, deco) => {
      if ((side < 0 ? from < pos : from <= pos) && (side > 0 ? to > pos : to >= pos)) {
        const match = deco.spec.ltMatch as LtMatch | undefined;
        if (match) {
          hit = { from, to, text: this.view.state.sliceDoc(from, to), match };
          return false;
        }
      }
      return undefined;
    });
    return hit;
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.destroyed) void this.run();
    }, ms);
  }

  private blocksAndConfig(): { blocks: LtBlock[]; cfg: LtRuntimeConfig } | null {
    if (!this.opts.enabled()) return null;
    const state = this.view.state;
    const head = state.sliceDoc(0, Math.min(state.doc.length, 4000));
    const cfg = runtimeConfig(frontMatterLanguage(head));
    if (!cfg) return null;
    const ranges = cfg.wholeDoc
      ? [{ from: 0, to: state.doc.length }]
      : this.view.visibleRanges.map((r) => ({
          from: Math.max(0, r.from - VIEWPORT_MARGIN),
          to: Math.min(state.doc.length, r.to + VIEWPORT_MARGIN),
        }));
    const maxTo = ranges.reduce((m, r) => Math.max(m, r.to), 0);
    const tree = ensureSyntaxTree(state, maxTo, 100) ?? syntaxTree(state);
    const skip = frontMatterEnd(head);
    const seen = new Set<number>();
    const blocks: LtBlock[] = [];
    for (const r of ranges) {
      for (const b of collectBlocks(tree, (a, z) => state.sliceDoc(a, z), r.from, r.to, skip)) {
        if (!seen.has(b.from)) {
          seen.add(b.from);
          blocks.push(b);
        }
      }
    }
    blocks.sort((a, b) => a.from - b.from);
    return { blocks, cfg };
  }

  private async run() {
    if (this.running) {
      this.rerun = true;
      return;
    }
    const ctx = this.blocksAndConfig();
    if (!ctx) {
      if (this.decorations.size) {
        this.decorations = Decoration.none;
        this.redraw();
      }
      return;
    }
    const { blocks, cfg } = ctx;
    // Draw what we already know right away.
    this.render(ctx);

    const key = (b: LtBlock) => `${cfg.signature}\u0000${b.source}`;
    const missing: LtBlock[] = [];
    const queued = new Set<string>();
    for (const b of blocks) {
      const k = key(b);
      if (!cache.has(k) && !queued.has(k)) {
        queued.add(k);
        missing.push(b);
      }
    }
    if (!missing.length || Date.now() < backoffUntil) return;

    // Visible blocks first, so the screen fills in before off-screen text.
    const vis = this.view.visibleRanges;
    const onScreen = (b: LtBlock) => vis.some((r) => b.to >= r.from && b.from <= r.to);
    missing.sort((a, b) => Number(onScreen(b)) - Number(onScreen(a)));

    this.running = true;
    try {
      for (const batch of packBatches(missing, cfg.batchChars)) {
        if (this.destroyed) return;
        const res = await ltCheck(batch.annotation, cfg);
        const perBlock: LtMatch[][] = batch.blocks.map(() => []);
        for (const m of res.matches) {
          if (m.length <= 0) continue;
          const i = blockIndexFor(batch, m.offset, m.length);
          if (i >= 0) perBlock[i].push(normalizeMatch({ ...m, offset: m.offset - batch.starts[i] }));
        }
        batch.blocks.forEach((b, i) => cacheSet(key(b), perBlock[i]));
        reportLtOk();
        this.render();
      }
    } catch (err) {
      reportLtError(err);
      backoffUntil = Date.now() + (BACKOFF_MS[ltErrorCode(err)] ?? 10_000);
      this.render();
    } finally {
      this.running = false;
      if (this.rerun && !this.destroyed) {
        this.rerun = false;
        this.schedule(DEBOUNCE_MS);
      }
    }
  }

  /** Rebuild decorations from the cache for the current document. */
  private render(ctx = this.blocksAndConfig()) {
    if (this.destroyed) return;
    if (!ctx) {
      this.decorations = Decoration.none;
      this.redraw();
      return;
    }
    const { blocks, cfg } = ctx;
    const doc = this.view.state.doc;
    const marks: { from: number; to: number; m: LtMatch }[] = [];
    for (const b of blocks) {
      const hits = cacheGet(`${cfg.signature}\u0000${b.source}`);
      if (!hits) continue;
      for (const m of hits) {
        const from = b.from + m.offset;
        const to = from + m.length;
        if (to > doc.length || to <= from) continue;
        if (isLtIgnored(m, b.source.slice(m.offset, m.offset + m.length))) continue;
        marks.push({ from, to, m });
      }
    }
    marks.sort((a, b) => a.from - b.from || a.to - b.to);
    const builder = new RangeSetBuilder<Decoration>();
    for (const { from, to, m } of marks) builder.add(from, to, markFor(m));
    this.decorations = builder.finish();
    this.redraw();
  }

  /** See `cm-spellcheck.ts` — decorations changed outside an update cycle. */
  private redraw() {
    if (this.destroyed) return;
    try {
      this.view.dispatch({});
    } catch {
      this.view.requestMeasure();
    }
  }
}

let pluginRef: ViewPlugin<LtPlugin> | null = null;

/** The LanguageTool match under `pos` in `view`, for the context menu. */
export function languagetoolHitAt(view: EditorView, pos: number): LtHit | null {
  if (!pluginRef) return null;
  return view.plugin(pluginRef)?.hitAt(pos) ?? null;
}

/** Replace a hit with `text` — one undoable edit, only if the text is still
 *  what was flagged. */
export function applyLtReplacement(view: EditorView, hit: LtHit, text: string): boolean {
  if (view.state.sliceDoc(hit.from, hit.to) !== hit.text) return false;
  view.dispatch({
    changes: { from: hit.from, to: hit.to, insert: text },
    selection: { anchor: hit.from + text.length },
    userEvent: 'input.languagetool',
  });
  view.focus();
  return true;
}

function buildTooltipDom(view: EditorView, hit: LtHit, close: () => void): HTMLElement {
  const { t } = useI18n();
  const m = hit.match;
  const root = document.createElement('div');
  root.className = 'cm-lt-tooltip';

  const head = document.createElement('div');
  head.className = 'cm-lt-tooltip__head';
  head.textContent = m.shortMessage || issueLabel(m.issueType);
  root.appendChild(head);

  if (m.message && m.message !== m.shortMessage) {
    const msg = document.createElement('div');
    msg.className = 'cm-lt-tooltip__msg';
    msg.textContent = m.message;
    root.appendChild(msg);
  }

  if (m.replacements.length) {
    const row = document.createElement('div');
    row.className = 'cm-lt-tooltip__repl';
    for (const r of m.replacements) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cm-lt-tooltip__fix';
      b.textContent = r === '' ? t('languagetool.remove') : r;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        applyLtReplacement(view, hit, r);
        close();
      });
      row.appendChild(b);
    }
    root.appendChild(row);
  }

  const actions = document.createElement('div');
  actions.className = 'cm-lt-tooltip__actions';
  const action = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cm-lt-tooltip__action';
    b.textContent = label;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      fn();
      close();
    });
    actions.appendChild(b);
  };
  if (m.issueType === 'misspelling') {
    const words = matchWords(hit.text);
    if (words.length === 1) action(t('spellcheck.addToDict'), () => void ltAddWord(words[0]));
    else for (const w of words) action(t('languagetool.addWord', { word: w }), () => void ltAddWord(w));
  }
  action(t('languagetool.ignore'), () => ltIgnore(m, hit.text));
  if (m.ruleId) action(t('languagetool.disableRule'), () => ltDisableRule(m.ruleId));
  root.appendChild(actions);

  const rule = document.createElement('div');
  rule.className = 'cm-lt-tooltip__rule';
  rule.textContent = `LanguageTool · ${m.ruleDescription || m.ruleId}`;
  root.appendChild(rule);
  return root;
}

export function languagetoolExtension(opts: LtOptions): Extension {
  const plugin = ViewPlugin.define((view) => new LtPlugin(view, opts), {
    decorations: (v) => v.decorations,
  });
  pluginRef = plugin;

  const tooltip = hoverTooltip(
    (view, pos, side): Tooltip | null => {
      const hit = view.plugin(plugin)?.hitAt(pos, side);
      if (!hit) return null;
      return {
        pos: hit.from,
        end: hit.to,
        above: true,
        create: (v) => ({
          dom: buildTooltipDom(v, hit, () => v.dispatch({ effects: closeHoverTooltips })),
        }),
      };
    },
    { hoverTime: 350, hideOnChange: true },
  );

  return [plugin, tooltip, languagetoolTheme];
}

export const languagetoolTheme: Extension = EditorView.theme({
  '.cm-lt': {
    textDecorationSkipInk: 'none',
    textDecorationThickness: '1.5px',
    textUnderlineOffset: '2px',
    cursor: 'inherit',
  },
  '.cm-lt-spelling': { textDecoration: 'underline wavy #e5484d' },
  '.cm-lt-grammar': { textDecoration: 'underline wavy #f59e0b' },
  '.cm-lt-style': { textDecoration: 'underline wavy #3b82f6' },
  '.cm-lt-other': { textDecoration: 'underline dotted #8b5cf6' },
  '.cm-tooltip.cm-tooltip-hover:has(.cm-lt-tooltip)': {
    border: '1px solid var(--border)',
    borderRadius: '8px',
    background: 'var(--bg-elev, var(--bg))',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
  },
  '.cm-lt-tooltip': {
    maxWidth: '360px',
    padding: '8px 10px',
    fontSize: '12.5px',
    lineHeight: '1.45',
    color: 'var(--text)',
    fontFamily: 'var(--ui-font, system-ui, sans-serif)',
  },
  '.cm-lt-tooltip__head': { fontWeight: '600', marginBottom: '2px' },
  '.cm-lt-tooltip__msg': { color: 'var(--text-muted, inherit)', marginBottom: '6px' },
  '.cm-lt-tooltip__repl': { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '6px' },
  '.cm-lt-tooltip__fix': {
    border: '0',
    borderRadius: '5px',
    padding: '2px 8px',
    font: 'inherit',
    fontWeight: '600',
    color: 'var(--accent-fg, #fff)',
    background: 'var(--accent, #3b82f6)',
    cursor: 'pointer',
  },
  '.cm-lt-tooltip__actions': { display: 'flex', flexWrap: 'wrap', gap: '10px' },
  '.cm-lt-tooltip__action': {
    border: '0',
    padding: '0',
    background: 'transparent',
    font: 'inherit',
    color: 'var(--accent, #3b82f6)',
    cursor: 'pointer',
  },
  '.cm-lt-tooltip__action:hover': { textDecoration: 'underline' },
  '.cm-lt-tooltip__rule': { marginTop: '6px', fontSize: '11px', color: 'var(--text-faint, #888)' },
});
