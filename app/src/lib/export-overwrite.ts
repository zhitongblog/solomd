/**
 * #581 — Export target conflict helpers (overwrite / auto-numbered `(1)` rename)
 * #584 — HTML export content width range validation
 */

export function splitExportPath(fullPath: string): {
  dir: string;
  sep: string;
  fileName: string;
  stem: string;
  ext: string;
} {
  const sep = fullPath.includes('\\') ? '\\' : '/';
  const lastSlash = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
  const dir = lastSlash >= 0 ? fullPath.slice(0, lastSlash) : '';
  const fileName = lastSlash >= 0 ? fullPath.slice(lastSlash + 1) : fullPath;
  const dotIdx = fileName.lastIndexOf('.');
  const stem = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
  const ext = dotIdx > 0 ? fileName.slice(dotIdx) : '';
  return { dir, sep, fileName, stem, ext };
}

export function joinDirAndFileName(dir: string, sep: string, fileName: string): string {
  if (!dir) return fileName;
  const cleanDir = dir.replace(/[/\\]+$/, '');
  const cleanName = fileName.replace(/^[/\\]+/, '');
  return `${cleanDir}${sep}${cleanName}`;
}

/**
 * #581 — Compute the first unused `<stem>(1)<ext>`, `<stem>(2)<ext>`, … sibling
 * path when `targetPath` already exists.
 */
export async function suggestNumberedExportPath(
  targetPath: string,
  exists: (candidatePath: string) => Promise<boolean> | boolean,
): Promise<{ path: string; fileName: string }> {
  const { dir, sep, stem, ext } = splitExportPath(targetPath);
  for (let n = 1; n <= 9999; n++) {
    const candidateName = `${stem}(${n})${ext}`;
    const candidatePath = joinDirAndFileName(dir, sep, candidateName);
    if (!(await exists(candidatePath))) {
      return { path: candidatePath, fileName: candidateName };
    }
  }
  const fallbackName = `${stem}(${Date.now()})${ext}`;
  return {
    path: joinDirAndFileName(dir, sep, fallbackName),
    fileName: fallbackName,
  };
}

/**
 * #581 — Normalize the user-entered filename in the "New File Name" dialog.
 * Returns `null` if the name is empty/blank; appends the original extension if
 * the user omitted an extension.
 */
export function resolveRenamedExportPath(
  originalTargetPath: string,
  enteredName: string,
): string | null {
  const trimmed = (enteredName || '').trim().replace(/^[/\\]+|[/\\]+$/g, '');
  if (!trimmed) return null;
  const { dir, sep, ext } = splitExportPath(originalTargetPath);
  const hasExt = ext
    ? trimmed.toLowerCase().endsWith(ext.toLowerCase()) || /\.[a-z0-9]{1,10}$/i.test(trimmed)
    : true;
  const finalFileName = hasExt ? trimmed : `${trimmed}${ext}`;
  return joinDirAndFileName(dir, sep, finalFileName);
}

/**
 * #584 — Validate desktop HTML export content width (`0` = full width,
 * `1–699` = too small warning, `> screenWidth` = too large warning).
 */
export function validateHtmlContentWidth(
  widthPx: number,
  screenWidth: number,
  isZh = true,
): string {
  if (!Number.isFinite(widthPx) || widthPx < 0) {
    return isZh ? '取值过小，会影响显示效果' : 'Value is too small and may affect display quality';
  }
  const rounded = Math.round(widthPx);
  if (rounded === 0) return '';
  if (rounded >= 1 && rounded <= 699) {
    return isZh ? '取值过小，会影响显示效果' : 'Value is too small and may affect display quality';
  }
  if (screenWidth > 0 && rounded > screenWidth) {
    return isZh ? '取值范围过大' : 'Value exceeds current display width';
  }
  return '';
}
