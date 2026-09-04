/**
 * Self-test runner for DOCX template resolution.
 *
 * Usage (from app/): node src/lib/docx-template.selftest.mjs
 */
import { register } from 'node:module';

register(new URL('./relationships.selftest-loader.mjs', import.meta.url));

await import('./docx-template.test.ts');
