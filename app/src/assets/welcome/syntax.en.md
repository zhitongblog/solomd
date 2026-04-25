# Markdown syntax — the parts SoloMD renders

This is a working cheat sheet. Switch to **Preview** (`Ctrl+Shift+P` until you land on Preview) to see each block render.

## Headings

```
# H1   ## H2   ### H3   #### H4
```

# Heading 1
## Heading 2
### Heading 3

## Inline

**bold**, *italic*, ~~strikethrough~~, ==marked==, `inline code`, [link](https://solomd.app), and footnotes[^1].

[^1]: Footnotes are auto-numbered.

## Lists

- Unordered
  - Nested
- More items

1. Ordered
2. Items
   1. Nested

- [ ] Task list
- [x] Completed

## Block quote

> "Markdown is plain text with rules."
> — anyone who has used a CMS

## Code

```ts
function greet(name: string): string {
  return `Hello, ${name}!`;
}
```

## Tables

| Feature | Edit | Preview |
| ------- | :--: | :-----: |
| Word wrap | ✓ | — |
| Outline | ✓ | ✓ |
| Mermaid | — | ✓ |

## Math (KaTeX)

Inline: $E = mc^2$.

Display:

$$
\int_0^\infty e^{-x^2}\, dx = \frac{\sqrt{\pi}}{2}
$$

## Diagrams (Mermaid)

```mermaid
flowchart LR
  A[Type Markdown] --> B{Preview?}
  B -- yes --> C[See it render]
  B -- no --> D[Keep typing]
  C --> E[Export]
```

## Front matter

```yaml
---
title: My document
imageRoot: ./images
---
```

`imageRoot` is a SoloMD extension — pasted/dropped images are saved to that folder relative to the file.

## Horizontal rule = slide break

In normal preview a `---` between paragraphs draws a horizontal rule. In **slideshow mode** (`Ctrl+Alt+P`) it splits the doc into slides.
