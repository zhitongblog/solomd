# Live edit mode — try every supported syntax

> Press `Ctrl+Shift+P` (or click the pen-on-paper icon in the toolbar) to cycle into **Live edit**. Markdown formatting renders inline as you type — like Typora or Obsidian Live Preview — and the source comes back when your cursor lands on a line.

## Headings

# H1 — biggest heading
## H2 — second level
### H3 — third level
#### H4 (smaller)
##### H5
###### H6

## Inline emphasis

**bold text**, *italic text*, ***bold italic***, ~~strikethrough~~, and `inline code`.

CJK works too: **粗体**, *斜体*, **粗 体 加 空 格**.

## Links

A link to [SoloMD's website](https://solomd.app) and an autolink: <https://github.com/lixd/solomd>.

Move the caret onto the link line — the raw `[label](url)` markup reappears so you can edit either side, then leaves again when you click away.

## Lists

- Unordered item
- Another item
  - Nested item
  - Nested item with **bold** in it
- Final item

1. Ordered item
2. Second item
3. Third item

- [ ] Task: write the spec
- [x] Task: ship the prototype

## Inline code & fenced code blocks

The shell command `pnpm tauri dev` starts the app.

```ts
// Fenced code block — has a grey background and keeps its syntax color.
function greet(name: string): string {
  return `Hello, ${name}!`;
}
```

```python
# Python is also recognized — the language tag drives the highlight.
def greet(name: str) -> str:
    return f"Hello, {name}!"
```

## Blockquote

> A blockquote gets a left bar and an indent.
> Even when it spans multiple lines.

## Horizontal rule

---

## Caret reveal — the magic part

Place your cursor on the heading line right above this paragraph. The `##` characters reappear so you can edit them. Click somewhere else and the markers melt back into the rendered heading.

The same pattern works for every supported marker: `**bold**`, `*italic*`, `` `code` ``, and `[label](url)`. Off the line, you see the rendered output. On the line, you see the raw markdown.

## What's NOT live-rendered yet

- Tables (rendered in Preview pane only — coming in v2.4)
- Footnotes
- Math blocks (`$$ … $$`)
- Mermaid diagrams

For these, switch to **Preview** or **Split** mode — both still work exactly as before.
