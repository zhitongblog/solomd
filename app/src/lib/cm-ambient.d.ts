// Ambient declarations used by the cm-* extension suite.
// (Lives alongside the cm-*.ts files this task owns.)

// `opencc-js` ships without types; an unrelated file in this project
// (`src/lib/chinese.ts`, pre-existing WIP) imports it and would break
// the project-wide `vue-tsc --noEmit` pass. Declaring it here keeps the
// type checker happy without touching that file.
declare module 'opencc-js';
