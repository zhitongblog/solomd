/**
 * Path identity for comparisons.
 *
 * Windows paths name the same file however they are spelled: `C:\Notes\a.md`,
 * `c:\notes\A.md` and `C:/Notes/a.md` are one file. The shell hands SoloMD
 * whichever spelling the launcher used (a lower-case drive letter from one
 * tool, the typed case from a "Run" box, forward slashes from another app), so
 * comparing them as strings made the file tree stop following the open
 * document and let one file open in two tabs (a tester's report, bug/
 * 2026-10-07: "文件树跟随当前文件 … 完全失效").
 *
 * Only Windows-style paths (a drive letter or a UNC `\\server`) are folded:
 * macOS and Linux paths are compared exactly, since case is significant on
 * Linux and macOS volumes can be case-sensitive too.
 */

const WIN_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/\/)/;

export function isWindowsStylePath(p: string): boolean {
  return WIN_PATH.test(p);
}

/** Comparison key: unified separators, no trailing separator, and on Windows
 *  case-folded. Never shown to the user or used to open a file. */
export function pathKey(p: string): string {
  if (!p) return p;
  if (!isWindowsStylePath(p)) return p.length > 1 ? p.replace(/\/+$/, '') : p;
  let s = p.replace(/\//g, '\\');
  // "C:\" keeps its separator; anything longer drops a trailing one.
  if (s.length > 3) s = s.replace(/\\+$/, '');
  return s.toLowerCase();
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a === b || pathKey(a) === pathKey(b);
}

/** Segment-name comparison inside a folder, with the same case rule as the
 *  paths around it. */
export function sameName(a: string, b: string, windows: boolean): boolean {
  return a === b || (windows && a.toLowerCase() === b.toLowerCase());
}

/**
 * The segments of `path` below `root`, or null when `path` is not inside it.
 * `[]` means `path` is `root` itself. Segments keep the spelling `path` had.
 */
export function segmentsBelow(root: string, path: string): string[] | null {
  if (!root || !path) return null;
  const rk = pathKey(root);
  const pk = pathKey(path);
  if (rk === pk) return [];
  const sep = isWindowsStylePath(root) ? '\\' : '/';
  const prefix = rk.endsWith(sep) ? rk : rk + sep;
  if (!pk.startsWith(prefix)) return null;
  // Lower-casing never changes the length of a path the shell produces, but
  // guard anyway: on a mismatch fall back to splitting the key itself.
  const unified = isWindowsStylePath(path) ? path.replace(/\//g, '\\').replace(/\\+$/, '') : path.replace(/\/+$/, '');
  const rest = unified.length === pk.length ? unified.slice(prefix.length) : pk.slice(prefix.length);
  return rest.split(/[\\/]+/).filter(Boolean);
}
