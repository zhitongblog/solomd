/**
 * Self-test runner for the heading-fold document model. Mirrors
 * markdown-tables.selftest.mjs: a resolve hook appends `.ts` to extension-less
 * relative imports so the `node:test` suite runs under Node native
 * type-stripping.
 *
 * Usage (from app/): node src/lib/heading-fold.selftest.mjs
 */
import { register } from 'node:module';

register(new URL('./relationships.selftest-loader.mjs', import.meta.url));

await import('./heading-fold.test.ts');
