/**
 * Is a "file changed on disk" notification something the user must hear
 * about? (Linux regression run, Failure 9.)
 *
 * The watcher reports *that* a watched path had an event, not *what* changed.
 * The handler used to act on the event alone, so a dirty tab got the "File
 * Changed on Disk" dialog for events that changed nothing: Linux reports
 * every open/read of the file (our own reload, revalidation, indexing), and a
 * save of ours can race the event. The dialog then opened mid-sentence and
 * ate the keystrokes typed into it. Seen after a restored session, on the
 * first keystroke after "Reload from Disk", and while typing into a note the
 * app had just created.
 *
 * The rule now compares content: the disk bytes against the last state we
 * loaded or saved (`savedContent`), against our own most recent write to that
 * path, and against the buffer. Only bytes that are none of those are news.
 */

export type DiskChangeDecision =
  /** Nothing new: the disk holds what we last loaded/saved or wrote ourselves. */
  | 'ignore'
  /** Disk already equals the buffer: adopt it as the saved baseline, no prompt. */
  | 'adopt'
  /** Clean tab, outside change: reload silently. */
  | 'reload'
  /** Unsaved edits and a real outside change: the user decides. */
  | 'prompt';

export interface DiskChangeInput {
  /** The file's current bytes, CRLF already normalized to LF. */
  disk: string;
  /** The tab's baseline — what it last loaded from or saved to disk. */
  savedContent: string;
  /** The tab's buffer. */
  content: string;
  /** The last bytes this app wrote to the path, if known (normalized). */
  lastOwnWrite?: string | null;
  /** Settings → auto-reload externally modified files. */
  autoReload: boolean;
  /** Preview mode reloads clean tabs regardless of the preference. */
  preview: boolean;
}

export function decideDiskChange(input: DiskChangeInput): DiskChangeDecision {
  const { disk, savedContent, content, lastOwnWrite, autoReload, preview } = input;
  if (disk === savedContent) return 'ignore';
  // Our own write whose markSaved has not landed yet (or a newer one of ours
  // than the baseline): the save path will update the baseline itself.
  if (lastOwnWrite != null && disk === lastOwnWrite) return 'ignore';
  if (disk === content) return 'adopt';
  const dirty = content !== savedContent;
  if (!dirty && (preview || autoReload)) return 'reload';
  return 'prompt';
}

/** Normalize to the form tabs store: LF line endings. */
export function normalizeDiskText(text: string): string {
  return text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text;
}

/**
 * The bytes this window last wrote to each path. Recorded *before* the write
 * is issued, so an event that overtakes the write's completion still
 * recognises it.
 */
const ownWrites = new Map<string, string>();

export function noteOwnWrite(path: string, content: string): void {
  ownWrites.set(path, normalizeDiskText(content));
}

export function lastOwnWrite(path: string): string | null {
  return ownWrites.get(path) ?? null;
}

/**
 * Typing-aware deferral. A prompt that opens between two keystrokes takes the
 * second one. `msSinceLastKey` is how long ago the last key went down; the
 * caller waits `typingIdleWait` ms before prompting (0 = go ahead).
 */
export const TYPING_IDLE_MS = 1500;

export function typingIdleWait(msSinceLastKey: number, idleMs = TYPING_IDLE_MS): number {
  return msSinceLastKey >= idleMs ? 0 : idleMs - msSinceLastKey;
}
