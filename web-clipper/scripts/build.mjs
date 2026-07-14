#!/usr/bin/env node
/**
 * Build pipeline for the SoloMD web clipper.
 *
 * Produces two parallel `dist/<target>/` directories — one for Chrome
 * (Manifest V3) and one for Firefox (Manifest V2) — plus zipped artefacts
 * `dist/chrome.zip` and `dist/firefox.zip` ready for the respective stores.
 *
 * Single source of truth, two store-loadable outputs.
 *
 * Steps per target:
 *   1. esbuild bundles src/{background,content,popup,options}.ts
 *      with all third-party deps inlined (turndown, readability, polyfill)
 *      and emits browser-friendly IIFEs.
 *   2. Copies popup.html, options.html, popup.css, icons/.
 *   3. Drops in the right manifest variant.
 *   4. Zips the directory.
 *
 * Usage:
 *   node scripts/build.mjs              # both targets
 *   TARGET=chrome  node scripts/build.mjs
 *   TARGET=firefox node scripts/build.mjs
 */
import { build as esbuild } from 'esbuild';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

const ENTRIES = ['background', 'content', 'popup', 'options'];

async function buildOne(target /* 'chrome' | 'firefox' */) {
  const outDir = join(DIST, target);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 1. esbuild bundle every entry point individually so the manifest can
  //    reference each file by its predictable name (background.js, etc.).
  await Promise.all(
    ENTRIES.map((entry) =>
      esbuild({
        entryPoints: [join(SRC, `${entry}.ts`)],
        outfile: join(outDir, `${entry}.js`),
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: ['chrome111', 'firefox115'],
        minify: false,
        sourcemap: false,
        treeShaking: true,
        define: {
          'process.env.NODE_ENV': '"production"',
          // webextension-polyfill checks `typeof browser` to decide whether
          // it needs to wrap chrome.* — both checks work in either target,
          // but defining this makes esbuild dead-code-eliminate the wrong path.
          __BUILD_TARGET__: JSON.stringify(target),
        },
        loader: { '.css': 'text' },
        legalComments: 'none',
      }),
    ),
  );

  // 2. Static assets.
  copyFileSync(join(SRC, 'popup.html'), join(outDir, 'popup.html'));
  copyFileSync(join(SRC, 'options.html'), join(outDir, 'options.html'));
  copyFileSync(join(SRC, 'popup.css'), join(outDir, 'popup.css'));
  cpSync(join(SRC, 'icons'), join(outDir, 'icons'), { recursive: true });

  // 3. Manifest variant.
  const manifestPath = join(ROOT, `manifest.${target}.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Keep the manifest version in sync with package.json so a single pnpm
  // version bump propagates everywhere.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  manifest.version = pkg.version;
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // 4. Zip up. Use the system `zip` CLI to keep dependencies tiny.
  const zipPath = join(DIST, `${target}.zip`);
  rmSync(zipPath, { force: true });
  execSync(`zip -r -q ../${target}.zip .`, { cwd: outDir, stdio: 'inherit' });

  console.log(`[${target}] ok → ${zipPath}`);
}

async function buildSourceZip() {
  // Mozilla Add-on Reviewer needs reproducible source. Pack the whole
  // web-clipper/ except node_modules + dist so reviewers can rebuild.
  const zipPath = join(DIST, 'source.zip');
  rmSync(zipPath, { force: true });
  // Use `find … -print | zip -@` so excludes are unambiguous — `zip -x` with
  // a leading-`./` walk has well-known quoting traps. `find -prune` cleanly
  // skips the heavy directories before zip ever sees them.
  execSync(
    [
      'find . \\(',
      '-path ./node_modules -o',
      '-path ./dist -o',
      '-path ./dist-tsc -o',
      '-path ./test/.tmp',
      '\\) -prune -o -type f -print',
      `| zip -q -@ ${JSON.stringify(zipPath)}`,
    ].join(' '),
    { cwd: ROOT, stdio: 'inherit', shell: '/bin/bash' },
  );
  console.log(`[source] ok → ${zipPath}`);
}

async function main() {
  if (!existsSync(join(SRC, 'icons', 'icon-16.png'))) {
    console.error('icons missing — run `node scripts/make-icons.mjs` first');
    process.exit(1);
  }
  mkdirSync(DIST, { recursive: true });
  const which = process.env.TARGET ?? 'all';
  if (which === 'chrome' || which === 'all') await buildOne('chrome');
  if (which === 'firefox' || which === 'all') await buildOne('firefox');
  if (which === 'all') await buildSourceZip();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
