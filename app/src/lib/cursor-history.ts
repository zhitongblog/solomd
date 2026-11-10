/**
 * Cursor position history queue (#491).
 *
 * Tracks recent cursor positions (up to `maxSize`, default 10) across edits
 * and jumps so the user can step backward (`Alt+ArrowLeft`) and forward
 * (`Alt+ArrowRight`) through recent cursor locations.
 */

export interface CursorStop {
  /** File path (or empty string for untitled buffer). */
  path: string;
  /** Zero-based character offset in the document. */
  pos: number;
  /** One-based line number in the document. */
  line: number;
}

export class CursorHistoryQueue {
  private entries: CursorStop[] = [];
  private currentIndex = -1;
  private isNavigating = false;
  private readonly maxSize: number;

  constructor(maxSize = 10) {
    this.maxSize = Math.max(2, maxSize);
  }

  /** Number of recorded stops in the queue. */
  get length(): number {
    return this.entries.length;
  }

  /** Current pointer index (`-1` when empty). */
  get index(): number {
    return this.currentIndex;
  }

  /** Snapshot of entries (for testing/inspection). */
  get items(): readonly CursorStop[] {
    return this.entries;
  }

  /** Whether `back()` can move to an earlier stop. */
  canGoBack(): boolean {
    return this.currentIndex > 0;
  }

  /** Whether `forward()` can move to a later stop. */
  canGoForward(): boolean {
    return this.currentIndex >= 0 && this.currentIndex < this.entries.length - 1;
  }

  /**
   * Record a cursor stop.
   *
   * - Ignored while a programmatic `back()` / `forward()` jump is being applied.
   * - If the new stop is on the same file and same line (and within 24 chars)
   *   as the current stop, updates the current stop in-place so normal typing
   *   keeps the latest offset on that line without flooding the history queue.
   * - Otherwise truncates any forward branch after `currentIndex` and appends
   *   the new stop, evicting the oldest entry if the queue exceeds `maxSize`.
   */
  record(stop: CursorStop): void {
    if (this.isNavigating) return;

    const normalized: CursorStop = {
      path: stop.path,
      pos: Math.max(0, Math.floor(stop.pos)),
      line: Math.max(1, Math.floor(stop.line)),
    };

    if (this.currentIndex >= 0 && this.currentIndex < this.entries.length) {
      const cur = this.entries[this.currentIndex];
      if (
        cur.path === normalized.path &&
        cur.line === normalized.line &&
        Math.abs(cur.pos - normalized.pos) < 24
      ) {
        this.entries[this.currentIndex] = normalized;
        return;
      }
    }

    if (this.currentIndex < this.entries.length - 1) {
      this.entries.splice(this.currentIndex + 1);
    }

    this.entries.push(normalized);
    if (this.entries.length > this.maxSize) {
      this.entries.shift();
    }
    this.currentIndex = this.entries.length - 1;
  }

  /** Step backward (`Alt+ArrowLeft`) and return the target stop, or `null`. */
  back(): CursorStop | null {
    if (!this.canGoBack()) return null;
    this.currentIndex -= 1;
    return { ...this.entries[this.currentIndex] };
  }

  /** Step forward (`Alt+ArrowRight`) and return the target stop, or `null`. */
  forward(): CursorStop | null {
    if (!this.canGoForward()) return null;
    this.currentIndex += 1;
    return { ...this.entries[this.currentIndex] };
  }

  /** Run `fn` with the navigation guard active so programmatic cursor moves do not record. */
  withNavigation<T>(fn: () => T): T {
    this.isNavigating = true;
    try {
      return fn();
    } finally {
      this.isNavigating = false;
    }
  }

  /** Clear all stops. */
  clear(): void {
    this.entries = [];
    this.currentIndex = -1;
  }
}
