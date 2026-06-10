/**
 * Self-test runner for F3 typed-relationships pure logic.
 *
 * The repo uses extension-less relative imports (Vite/TS convention), which
 * Node's native ESM resolver rejects. This wrapper registers a tiny resolve
 * hook that appends `.ts` to extension-less relative specifiers, then runs the
 * `node:test` suite in relationships.test.ts under native type-stripping.
 *
 * Usage (from the worktree root):
 *   node app/src/lib/relationships.selftest.mjs
 */
import { register } from 'node:module';

register(new URL('./relationships.selftest-loader.mjs', import.meta.url));

await import('./relationships.test.ts');
