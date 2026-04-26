#!/usr/bin/env node
/**
 * Build a single self-contained in-page driver for live-Chrome testing.
 *
 * The real extension content script (src/content.ts) registers a
 * `browser.runtime.onMessage` listener — useless when we're injecting it
 * via DevTools without an extension context. This driver pulls the same
 * `markdown.ts` + readability + capture POST logic into a single IIFE
 * with a global hook (`window.__solomdClipFor(endpoint, token)`), which
 * the smoke test calls directly.
 */
import { build } from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENTRY = join(ROOT, 'test', 'live-driver-entry.ts');
const OUT = join(ROOT, 'dist', 'live-driver.js');

mkdirSync(dirname(OUT), { recursive: true });

await build({
  entryPoints: [ENTRY],
  outfile: OUT,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome111'],
  legalComments: 'none',
});

console.log(`[live-driver] -> ${OUT}`);
