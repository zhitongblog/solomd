/**
 * Give the keyboard to the editor of the focused pane.
 *
 * The CodeMirror path never focused itself when it mounted, so after launch,
 * after a split and after the slideshow window closed the caret was nowhere
 * and typing went to <body> until the user clicked (Linux regression run;
 * the same code runs on every desktop). The plain Windows editor already
 * focuses on mount (`focusPlainEditor`).
 *
 * `onlyIfIdle` (the default) leaves focus alone when something else already
 * has it — a settings field, the find bar, a dialog — so this never steals
 * the keyboard from a place the user chose.
 */

const EDITOR_TARGETS = '.cm-content, .plain-block--active textarea, .plain-editor';

function isIdleFocus(): boolean {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement;
}

function modalOpen(): boolean {
  return !!document.querySelector('[aria-modal="true"], dialog[open]');
}

/**
 * The editable element of the focused pane, or (unless `strict`) of the first
 * editor on the page.
 */
export function activeEditorTarget(focusedPaneId?: string | null, strict = false): HTMLElement | null {
  const pane = focusedPaneId
    ? document.querySelector(`[data-pane-id="${CSS.escape(focusedPaneId)}"]`)
    : null;
  const inPane = pane?.querySelector<HTMLElement>(EDITOR_TARGETS) ?? null;
  if (inPane || strict) return inPane;
  return document.querySelector<HTMLElement>(EDITOR_TARGETS);
}

export function focusActiveEditor(
  focusedPaneId?: string | null,
  opts: { onlyIfIdle?: boolean; strict?: boolean } = {},
): boolean {
  const onlyIfIdle = opts.onlyIfIdle ?? true;
  if (modalOpen() || (onlyIfIdle && !isIdleFocus())) return false;
  const target = activeEditorTarget(focusedPaneId, opts.strict);
  if (!target) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}

/**
 * Retry `focusActiveEditor` for a short while: at launch and right after a
 * split the editor mounts a few frames (or an async chunk) later.
 */
export function focusActiveEditorSoon(
  getPaneId: () => string | null | undefined,
  opts: { onlyIfIdle?: boolean; strict?: boolean; timeoutMs?: number } = {},
): void {
  const deadline = Date.now() + (opts.timeoutMs ?? 3000);
  const tick = () => {
    const target = activeEditorTarget(getPaneId(), opts.strict);
    if (target) {
      focusActiveEditor(getPaneId(), opts);
      return;
    }
    if (Date.now() < deadline) setTimeout(tick, 50);
  };
  setTimeout(tick, 0);
}
