/**
 * #579 & #583 — Dedicated EPUB stylesheet passed to Pandoc (`--css=...`) so
 * exported EPUB eBooks render crisp tables, shaded inline code (`code`), and
 * bordered/shaded code blocks (`pre` / `div.sourceCode`) across Calibre, Apple
 * Books, Kobo, Kindle, and PocketBook readers.
 */
export const SOLOMD_EPUB_CSS = `
html, body {
  margin: 0;
  padding: 0;
  color: #1f2328;
  line-height: 1.7;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", serif;
  overflow-wrap: break-word;
}

h1, h2, h3, h4, h5, h6 {
  color: #0f172a;
  line-height: 1.3;
  font-weight: 700;
  margin: 1.5em 0 0.6em;
  page-break-after: avoid;
}

h1 {
  font-size: 1.75em;
  border-bottom: 2px solid #cbd5e1;
  padding-bottom: 0.28em;
}

h2 {
  font-size: 1.4em;
  border-bottom: 1px solid #e2e8f0;
  padding-bottom: 0.22em;
}

h3 { font-size: 1.18em; }
h4 { font-size: 1.04em; }
h5, h6 { font-size: 0.96em; color: #475569; }

p {
  margin: 0.8em 0;
}

a {
  color: #0b5cad;
  text-decoration: none;
}

/* #596 — Suppress automatic <ol> decimal list markers inside EPUB Table of Contents
   so headings that already carry hierarchical numbers (1, 1.1, 1.2…) never double-number */
nav#toc ol,
nav[epub\\:type~="toc"] ol,
ol.toc {
  list-style-type: none !important;
  padding-left: 1.2em;
}

nav#toc > ol,
nav[epub\\:type~="toc"] > ol,
ol.toc:first-of-type {
  padding-left: 0;
}

nav#toc li,
nav[epub\\:type~="toc"] li,
ol.toc li {
  list-style-type: none !important;
  margin: 0.32em 0;
}

/* #714 / #727 — Suppress bullet dots on Pandoc EPUB task-list items (including
   inside blockquotes) and align task-list indentation with regular ul / ol lists */
ul,
ol {
  padding-left: 1.8em;
}
blockquote ul,
blockquote ol {
  padding-left: 1.5em;
}
ul.task-list,
ul.contains-task-list {
  list-style: none !important;
  list-style-type: none !important;
  padding-left: 1.8em;
}
blockquote ul.task-list,
blockquote ul.contains-task-list {
  list-style: none !important;
  list-style-type: none !important;
  padding-left: 1.5em;
}
ul.task-list > li,
blockquote ul.task-list > li,
li.task-list-item,
ul.contains-task-list > li.task-list-item,
blockquote ul.contains-task-list > li.task-list-item,
li:has(> input[type="checkbox"]),
li:has(> label > input[type="checkbox"]),
li:has(> p > input[type="checkbox"]),
li:has(> p > label > input[type="checkbox"]) {
  list-style: none !important;
  list-style-type: none !important;
}
ul.task-list > li input[type="checkbox"],
li.task-list-item input[type="checkbox"],
blockquote ul.task-list > li input[type="checkbox"] {
  margin-left: -1.35em;
  margin-right: 0.45em;
}
ul.contains-task-list > li:not(.task-list-item),
blockquote ul.contains-task-list > li:not(.task-list-item) {
  list-style-type: disc !important;
}

/* #583 — Inline code background shading */
code {
  font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.88em;
  background-color: #f1f5f9;
  color: #0f172a;
  padding: 0.14em 0.38em;
  border-radius: 4px;
  border: 1px solid #e2e8f0;
}

/* #583 — Fenced & indented code block background shading */
pre,
div.sourceCode {
  background-color: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 0.85em 1em;
  margin: 1em 0;
  overflow-x: auto;
  line-height: 1.55;
  white-space: pre-wrap;
  word-wrap: break-word;
}

div.sourceCode > pre,
div.sourceCode > pre.sourceCode {
  background-color: transparent !important;
  border: none !important;
  border-radius: 0 !important;
  padding: 0 !important;
  margin: 0 !important;
}

pre code,
div.sourceCode code,
pre.sourceCode code.sourceCode {
  background-color: transparent !important;
  border: none !important;
  border-radius: 0 !important;
  padding: 0 !important;
  font-size: 0.9em;
  color: #1f2328;
}

/* #579 — Professional table borders, spacing, header shading, and zebra rows */
table {
  width: 100%;
  border-collapse: collapse;
  border-spacing: 0;
  margin: 1.2em 0;
  font-size: 0.94em;
  border: 1px solid #cbd5e1;
}

th,
td {
  border: 1px solid #cbd5e1;
  padding: 0.52em 0.78em;
  text-align: left;
  vertical-align: top;
  line-height: 1.5;
  word-break: break-word;
}

thead th,
tr.header th,
th {
  background-color: #f1f5f9;
  color: #0f172a;
  font-weight: 700;
  border-bottom: 2px solid #94a3b8;
}

tbody tr:nth-child(even) td,
tr.even td {
  background-color: #f8fafc;
}

blockquote {
  margin: 1.1em 0;
  padding: 0.45em 1em;
  border-left: 4px solid #64748b;
  background-color: #f8fafc;
  color: #475569;
}

blockquote p {
  margin: 0.35em 0;
}

hr {
  border: none;
  border-top: 1px solid #cbd5e1;
  margin: 1.8em 0;
}

img,
svg {
  max-width: 100%;
  height: auto;
}

figure {
  margin: 1.2em 0;
  text-align: center;
}

figcaption {
  font-size: 0.86em;
  color: #64748b;
  margin-top: 0.35em;
}
`;
