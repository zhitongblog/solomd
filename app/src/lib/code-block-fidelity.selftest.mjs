/**
 * Self-test runner for code-block fidelity. Mirrors markdown-tables.selftest.mjs.
 *
 * Usage (from app/): node src/lib/code-block-fidelity.selftest.mjs
 */
import { register } from 'node:module';

register(new URL('./relationships.selftest-loader.mjs', import.meta.url));

await import('./code-block-fidelity.test.ts');
