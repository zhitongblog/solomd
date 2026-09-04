/**
 * Self-test runner for the table model.
 *
 * Usage (from app/): node src/lib/markdown-table.selftest.mjs
 */
import { register } from 'node:module';

register(new URL('./relationships.selftest-loader.mjs', import.meta.url));

await import('./markdown-table.test.ts');
