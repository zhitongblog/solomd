/**
 * Self-test runner for task metadata parsing.
 *
 * Usage (from app/): node src/lib/tasks.selftest.mjs
 */
import { register } from 'node:module';

register(new URL('./relationships.selftest-loader.mjs', import.meta.url));

await import('./tasks.test.ts');
