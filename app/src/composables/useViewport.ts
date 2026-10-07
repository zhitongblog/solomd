/**
 * Phone-shaped viewport detection (#168).
 *
 * "在手机上的操作逻辑是 pc 的…所有 UI 都挤到一块了" — the desktop shell puts the
 * file tree, the editor and the right sidebar side by side. At 390 CSS px the
 * two side panes leave the editor a sliver, which is the whole complaint.
 *
 * The phone layout keys off ONE reactive flag rather than a mix of media
 * queries and UA sniffing, so the CSS and the behaviour (auto-closing a drawer
 * after picking a file, never opening both at once) can never disagree.
 *
 * The flag is a function of the viewport, never of the UA. `isMobile()` is
 * true on iPad and on Android tablets, and routing those to the phone shell
 * would break the one thing the reporter said already worked ("平板挺好").
 * Two cases count as a phone:
 *
 *   - width ≤ 600 — every phone in portrait, and a desktop window dragged
 *     narrow, which is also how this layout gets tested;
 *   - height ≤ 480 with a coarse pointer — a phone in landscape, where the
 *     width would pass for a desktop but there is no vertical room for
 *     stacked chrome. A short *mouse-driven* window is not included; that's
 *     a desktop user who resized, not a phone.
 *
 * iPad portrait (820×1180) and landscape (1180×820) match neither.
 */
import { onScopeDispose, readonly, ref } from 'vue';

/** Below this the three-column shell stops fitting. */
export const NARROW_BREAKPOINT_PX = 600;
/** A phone held sideways: wide enough, but no vertical room. */
export const SHORT_BREAKPOINT_PX = 480;

const MEDIA_QUERY =
  `(max-width: ${NARROW_BREAKPOINT_PX}px), ` +
  `((max-height: ${SHORT_BREAKPOINT_PX}px) and (pointer: coarse))`;

// Module-level singleton: one matchMedia listener for the whole app, and every
// caller observes the same value.
const narrow = ref(false);
let mql: MediaQueryList | null = null;

/**
 * Mirrored onto <html> as well as the reactive ref: modals, dropdowns and
 * the command palette are `<Teleport>`-ed to <body>, outside the app root,
 * so a class on the app element can't reach them.
 */
const ROOT_CLASS = 'narrow-viewport';

function evaluate(): void {
  const next = mql?.matches ?? false;
  narrow.value = next;
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle(ROOT_CLASS, next);
  }
}

function ensureWatching(): void {
  if (mql || typeof window === 'undefined' || !window.matchMedia) return;
  mql = window.matchMedia(MEDIA_QUERY);
  evaluate();
  mql.addEventListener('change', evaluate);
}

ensureWatching();

export function useViewport() {
  ensureWatching();
  // Re-evaluate on mount: the media query may not have been available at
  // module-eval time (import order in tests).
  evaluate();
  onScopeDispose(() => {
    // The listener is shared and lives for the app's lifetime; nothing to tear
    // down per component.
  });
  return { isNarrow: readonly(narrow) };
}

/** Non-reactive read, for call sites outside a component scope. */
export function isNarrowViewport(): boolean {
  ensureWatching();
  evaluate();
  return narrow.value;
}

/**
 * 5.0 §7 — a tablet held in portrait (or a narrow touch window above the phone
 * breakpoint): wide enough for the desktop shell, too narrow for a 260 px
 * sidebar beside the text. There the sidebar floats over the editor instead,
 * like iPad Notes. Touch only, so a desktop window dragged to the same width
 * keeps its sidebar in the layout.
 */
const TABLET_OVERLAY_QUERY =
  `(min-width: ${NARROW_BREAKPOINT_PX + 1}px) and (max-width: 1023px) and (pointer: coarse)`;
const tabletOverlay = ref(false);
let tabletMql: MediaQueryList | null = null;
function evaluateTablet(): void {
  // DEV-only QA hook, like ?forcePlain: preview the iPad-portrait overlay in a
  // mouse-driven browser, where `pointer: coarse` never matches.
  const forced =
    import.meta.env?.DEV && typeof location !== 'undefined' && location.search.includes('forceTabletOverlay');
  tabletOverlay.value = forced || (tabletMql?.matches ?? false);
}
export function useTabletOverlay() {
  if (!tabletMql && typeof window !== 'undefined' && window.matchMedia) {
    tabletMql = window.matchMedia(TABLET_OVERLAY_QUERY);
    tabletMql.addEventListener('change', evaluateTablet);
  }
  evaluateTablet();
  return { isTabletOverlay: readonly(tabletOverlay) };
}
