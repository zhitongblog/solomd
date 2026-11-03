/**
 * Where an export should land by default (#260).
 *
 * The save dialog used to get a bare filename, which makes the OS reuse
 * whatever directory was last saved to — so an export from a note in
 * ~/notes/work could silently default to last week's Downloads folder and
 * the user had to hunt for the file. Defaulting to the document's own
 * folder is both what people expect and where they'll look for it.
 */

/**
 * Directory separator this path uses. Windows paths can mix both, so pick
 * whichever appears last — that's the one adjacent to the file name.
 */
function separatorOf(path: string): string {
  return path.lastIndexOf('\\') > path.lastIndexOf('/') ? '\\' : '/';
}

/**
 * A path we can hand to the native save dialog as a starting point.
 * Returns `null` when the source has no usable directory — an unsaved
 * buffer, or a virtual path (Android SAF `saf:` / `content:` URIs, which
 * name a document in a provider, not a folder on disk).
 */
export function exportDefaultPath(
  sourcePath: string | null | undefined,
  filename: string,
  customExportDir?: string | null,
): string | null {
  const custom = customExportDir?.trim();
  if (custom) {
    const sep = separatorOf(custom);
    const trimmed = custom.replace(/[\\/]+$/, '') || sep;
    return trimmed === sep ? `${sep}${filename}` : `${trimmed}${sep}${filename}`;
  }
  if (!sourcePath) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(sourcePath) && !/^[a-z]:[\\/]/i.test(sourcePath)) {
    // A scheme (saf:, content:, file:) — but not a Windows drive letter,
    // which matches the same shape.
    return null;
  }
  const sep = separatorOf(sourcePath);
  const cut = sourcePath.lastIndexOf(sep);
  if (cut <= 0) return null;
  const dir = sourcePath.slice(0, cut);
  if (!dir) return null;
  return `${dir}${sep}${filename}`;
}
