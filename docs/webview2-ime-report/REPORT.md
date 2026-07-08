# WebView2 drops first CJK IME character and requires double-input for Chinese punctuation in `contentEditable`

> Submit at: https://github.com/MicrosoftEdge/WebView2Feedback/issues
> (Search existing issues for "IME" / "composition" / "contentEditable" first and add a 👍 / comment if a matching one exists.)

## Summary

In a WebView2-hosted page, typing Chinese with an IME into a `contentEditable`
element exhibits two defects:

1. **First character is dropped (“吃字”)** — the first character of a composition
   after focusing the element is silently lost.
2. **Chinese punctuation must be typed twice** — full-width punctuation
   (`，` `。` `？` `！`) does not commit on the first keypress; it takes two.

The **same input works correctly in a plain `<textarea>`** on the same page,
same IME, same session. This points at WebView2's IME / TSF integration for
`contentEditable`, not the IME itself.

The problem is **most severe with Sogou Pinyin (搜狗拼音)**, which is the most
widely used third-party IME in China. Microsoft Pinyin reproduces it more mildly.

## Environment

- WebView2 Runtime (Evergreen): **149.0.4022.69** (matches Edge Stable 149.0.4022.69; Chromium 149)
- OS: Windows 11 (10.0.26200)
- Host framework: Tauri 2 (also reproducible in a standalone WebView2 host and worth comparing against Edge)
- IME: Sogou Pinyin (severe); Microsoft Pinyin (mild)

## Minimal reproduction

A self-contained `repro.html` is attached (also inline below). It places a
`contentEditable` div and a `<textarea>` side by side and logs composition /
`beforeinput` / `input` events for the `contentEditable`.

Steps:
1. Open `repro.html` in the WebView2 host (and in Edge for comparison).
2. Switch to **Sogou Pinyin**.
3. Click the **contentEditable** box, type `nihao，shijie。` (pinyin + space to
   commit each word, then a Chinese comma and period).
4. Repeat in the **textarea** box.

## Expected

Both inputs produce `你好，世界。`, with every character and punctuation mark
committing on the first attempt.

## Actual

- **contentEditable:** the first character is missing, and the commas/periods
  required a second keypress to appear. Result is corrupted / missing characters.
- **textarea:** correct (`你好，世界。`).

## Notes for triage

- Reproduces on the latest Evergreen runtime (149), so it is not fixed by
  updating the runtime.
- JS-side mitigation attempts (suppressing DOM mutations on the composing node
  during `compositionstart` → `compositionend`, i.e. not rebuilding the editable
  subtree mid-composition) do **not** resolve it — the dropped first char and
  doubled punctuation persist, which suggests the issue is below the DOM/JS layer
  in WebView2's TSF text-input handling.
- The `<textarea>` (native text input path) being unaffected is the key
  contrast: the same keystrokes/IME succeed there.
- Please confirm whether this also reproduces in Edge Stable with the same
  Chromium base — if Edge is unaffected but WebView2 is, it is WebView2-specific;
  if both are affected, it is a Chromium/Edge text-input regression.

## Impact

Any rich-text / code editor built on `contentEditable` (CodeMirror 6, ProseMirror,
Slate, Monaco-in-contentEditable mode, etc.) is unusable for Chinese users in
WebView2 — forcing apps to fall back to a plain `<textarea>` and lose
syntax highlighting, WYSIWYG, and other editor features on Windows specifically.
