/**
 * Self-test runner for import target naming.
 *
 * Usage (from app/): node src/lib/import-plan.selftest.mjs
 */
import { register } from 'node:module';

register(new URL('./relationships.selftest-loader.mjs', import.meta.url));

await import('./import-plan.test.ts');
