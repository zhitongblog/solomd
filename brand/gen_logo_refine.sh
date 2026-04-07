#!/usr/bin/env bash
# Refine H1 (#.MD inline) and H4 (rounded badge) into multiple variants
set -e
cd "$(dirname "$0")"

if [ -z "$GEMINI_API_KEY" ]; then
  echo "ERROR: GEMINI_API_KEY not set"
  exit 1
fi

MODEL="gemini-2.5-flash-image"
ENDPOINT="https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}"
CURL_OPTS=(--tlsv1.2 --tls-max 1.2 --max-time 120)

gen_logo() {
  local name="$1"
  local prompt="$2"
  echo "Generating: $name"

  local payload
  payload=$(jq -n --arg p "$prompt" '{
    contents: [{ parts: [{ text: $p }] }],
    generationConfig: { responseModalities: ["IMAGE"] }
  }')

  local response
  response=$(curl "${CURL_OPTS[@]}" -sS -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$payload")

  local b64
  b64=$(echo "$response" | jq -r '.candidates[0].content.parts[]? | select(.inlineData) | .inlineData.data' 2>/dev/null)

  if [ -z "$b64" ] || [ "$b64" = "null" ]; then
    echo "  FAILED for $name"
    echo "$response" | jq '.' > "${name}_error.json"
    return 1
  fi

  echo "$b64" | base64 -d > "${name}.png"
  echo "  saved -> ${name}.png"
}

# ============================================================
# H4 refinement: rounded square badge containing "# MD"
# ============================================================

# H4a: Bold modern sans-serif, tight spacing, classic black-on-white
gen_logo "refine_h4a_bold" \
"A premium minimalist app icon for a markdown text editor. \
A perfect rounded square (corner radius about 22% of side, in the style of macOS Big Sur app icons) with a thin solid black stroke outline, no fill (pure white inside). \
Inside the square, perfectly centered, the characters '# MD' rendered horizontally in a single line, in a bold modern geometric sans-serif typeface (similar to Inter Bold or SF Pro Bold), in solid pure black. \
The hash '#' has equal stroke width to the letters. The space between '#' and 'MD' is small and tight. \
The whole '# MD' fills about 60% of the inner square width. \
Pure white outer background. No shadows, no decoration, no extra text. Square 1024x1024."

# H4b: Filled black square, white "# MD" inside (dark mode variant)
gen_logo "refine_h4b_inverted" \
"A premium minimalist app icon for a markdown text editor. \
A perfect rounded square (macOS Big Sur app icon corner radius) filled with solid pure black, no border. \
Inside the black square, perfectly centered, the characters '# MD' rendered horizontally in a single line, in pure white, using a bold modern geometric sans-serif typeface (Inter Bold style). \
Tight letter spacing, hash and letters equal stroke weight. \
Outer canvas is pure white. Square 1024x1024. No shadows, no decoration, no extra text."

# H4c: Monospace code-style "# MD" inside the badge (developer aesthetic)
gen_logo "refine_h4c_mono" \
"A minimalist developer-tool app icon. \
A perfect rounded square with thin solid black stroke outline, white interior, macOS-style corner radius. \
Inside the square, perfectly centered, exactly the characters '# MD' (hash, space, M, D) rendered in a clean geometric monospace font (like JetBrains Mono Regular or IBM Plex Mono), solid pure black, even letter spacing as a true monospace font would have. \
The line of text reads exactly like a single line of markdown source code. \
Generous white margin around the badge. Square 1024x1024. No shadows, no other text."

# H4d: Single warm accent — black square with one orange/amber hash mark
gen_logo "refine_h4d_accent" \
"A premium minimalist app icon for a markdown text editor. \
A perfect rounded square (macOS Big Sur corner radius) filled with solid pure black, no border. \
Inside, perfectly centered horizontally as a single line: \
- the hash symbol '#' in a warm amber-orange color (hex around #FF9F40), bold geometric sans-serif weight \
- a small space \
- the uppercase letters 'MD' in pure white, same bold geometric sans-serif weight, same height as the hash \
The hash is the only colored element; everything else is black or white. \
Outer canvas is pure white. Square 1024x1024. No shadows, no extra text."

# ============================================================
# H1 refinement: inline "# MD" wordmark (no badge frame)
# ============================================================

# H1a: Clean monospace "# MD" with proper space (force no period)
gen_logo "refine_h1a_mono" \
"A minimalist horizontal wordmark logo on a pure white background. \
The mark consists of exactly four characters in a single horizontal row: hash, space, M, D — that is, '# MD'. \
Render in a clean geometric monospace typeface (JetBrains Mono Bold or IBM Plex Mono Bold), all in solid pure black, even spacing characteristic of monospace. \
There must NOT be a period or dot between '#' and 'MD' — only a single normal space. \
Centered on the canvas with very generous white margin top, bottom, left, right. The wordmark occupies only the middle 50% of the canvas width. \
No other elements, no decoration, no extra text. Square 1024x1024."

# H1b: Bold sans-serif inline "# MD"
gen_logo "refine_h1b_sans" \
"A minimalist horizontal wordmark logo on pure white background. \
The mark is exactly: '# MD' — hash, space, M, D — rendered horizontally in a single line. \
Use a bold modern geometric sans-serif typeface (Inter Bold or Söhne Bold style), solid pure black. \
Tight elegant letter spacing. The hash '#' has the same visual weight as the letters M and D. \
Centered on the canvas with very generous white margin. No period, no dot, no decoration, no extra text. Square 1024x1024."

# H1c: "# MD" styled as a real markdown editor screenshot fragment
gen_logo "refine_h1c_editorish" \
"A minimalist code-style logo on pure white background. \
Render exactly the four characters '# MD' (hash, space, capital M, capital D) in a clean monospace coding font (JetBrains Mono Regular), solid pure black. \
To the LEFT of the hash, place a single thin vertical text-cursor caret '|' in solid black, also in the same monospace font, as if a code editor cursor is positioned right before the line. \
The caret should be slightly thinner than the letters. \
Whole composition reads like a single line in a text editor with the cursor about to type. \
Centered on canvas, very generous white margin, no other elements, no extra text. Square 1024x1024."

# H1d: Inverted — white "# MD" wordmark on black background
gen_logo "refine_h1d_inverted" \
"A minimalist horizontal wordmark on a pure solid black square background. \
The wordmark is exactly: '# MD' (hash, space, M, D) rendered in pure white, in a bold modern geometric sans-serif typeface (Inter Bold style), all characters equal weight. \
Centered horizontally and vertically on the black canvas, with generous black margin around. \
No period, no decoration, no extra text. Square 1024x1024."

echo "Done. Files:"
ls -la refine_*.png 2>/dev/null
