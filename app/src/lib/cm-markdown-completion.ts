export type CompletionStatus = null | 'active' | 'pending';

/**
 * IME-safe auto-popup gate for markdown completions.
 *
 * CodeMirror's activateOnTyping path dispatches completion transactions around
 * compositionend. On Windows WebView2 that can cancel the next Sogou/MS IME
 * composition, so implicit completion is limited to ASCII query characters.
 */
export function shouldAutoStartMarkdownCompletion(
  lineBeforeCursor: string,
  status: CompletionStatus,
): boolean {
  if (status !== null) return false;
  return markdownAsciiCompletionTrigger(lineBeforeCursor);
}

function markdownAsciiCompletionTrigger(before: string): boolean {
  return /(?:\[\[[^[\]\n]*[A-Za-z0-9_. /-]|(?:^|[^\p{L}\p{N}_/\-])#[A-Za-z0-9_/-]+|(?:^|[^\w])@[\w:.-]+)$/u.test(before);
}
