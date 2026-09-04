/**
 * Self-test runner for equation numbering.
 *
 * Usage (from app/): node src/lib/equations.selftest.mjs
 */
import { register } from 'node:module';

register(new URL('./relationships.selftest-loader.mjs', import.meta.url));

await import('./equations.test.ts');
