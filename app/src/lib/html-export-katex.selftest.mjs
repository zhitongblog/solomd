/**
 * Self-test runner for standalone HTML export KaTeX inlining.
 *
 * Usage (from app/): node src/lib/html-export-katex.selftest.mjs
 */
import { register } from 'node:module';

register(new URL('./relationships.selftest-loader.mjs', import.meta.url));

await import('./html-export-katex.test.ts');
