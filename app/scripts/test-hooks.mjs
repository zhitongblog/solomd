// Node resolve hook for `pnpm test`: the unit tests run under node:test with
// type stripping, which needs explicit extensions; many sources import
// `./foo` meaning `./foo.ts`. This adds the extension when the file exists.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(spec, ctx, next) {
  if ((spec.startsWith('.') || spec.startsWith('/')) && !/\.[cm]?[jt]s$|\.json$|\.vue$/.test(spec)) {
    for (const ext of ['.ts', '/index.ts']) {
      const u = new URL(spec + ext, ctx.parentURL);
      if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
    }
  }
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (url.includes('.css')) {
    const cleanUrl = url.split('?')[0];
    let raw = '';
    try {
      raw = readFileSync(fileURLToPath(cleanUrl), 'utf8');
    } catch {}
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(raw)};`,
    };
  }
  return next(url, ctx);
}
