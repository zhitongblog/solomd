/**
 * Where each imported document lands.
 *
 * Split out of the import loop because this is the part that can quietly
 * destroy something: a `report.docx` imported twice, or imported into a folder
 * that already has `report.md`, must not overwrite the existing note. The rest
 * of the import (open a dialog, call the converter, write a file) is plumbing;
 * this is the decision, so it is testable on its own.
 */

/** Strip the extension from a file name — `a.b.docx` → `a.b`. */
export function baseNameOf(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

/** The file name part of a path, for both separators. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * A free `<base>.md` name in a folder that already contains `taken`.
 *
 * Comparison is case-insensitive because the folder may be on a
 * case-insensitive filesystem (every default macOS and Windows volume), where
 * writing `Report.md` next to `report.md` overwrites it.
 *
 * Mutates `taken` by adding the chosen name, so a batch import cannot pick the
 * same name twice before any of it is written to disk.
 */
export function claimImportName(taken: Set<string>, sourceFileName: string): string {
  const base = baseNameOf(fileNameOf(sourceFileName)) || 'untitled';
  let name = `${base}.md`;
  let n = 2;
  while (taken.has(name.toLowerCase())) {
    name = `${base}-${n}.md`;
    n += 1;
  }
  taken.add(name.toLowerCase());
  return name;
}

/** Join a folder and a file name with the separator the folder already uses. */
export function joinInFolder(folder: string, name: string): string {
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return folder.endsWith(sep) ? `${folder}${name}` : `${folder}${sep}${name}`;
}
