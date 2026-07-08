#!/usr/bin/env bash
# Generate "#MD" combination logo variants for SoloMD
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

# H1: Inline wordmark "# MD" — looks like literal markdown source
gen_logo "concept_h1_inline" \
"A minimalist developer-tool app icon on a pure white background. \
The icon contains exactly three characters rendered horizontally in a single row: \
the hash symbol '#', then a single space, then the uppercase letters 'M' and 'D'. \
So the full icon literally shows: # MD \
Render the characters in a clean modern geometric monospace font (like JetBrains Mono or IBM Plex Mono), all in solid pure black, equal weight, perfectly aligned baseline. \
The result should look exactly like a single line of markdown source code that would render as a level-1 heading reading 'MD'. \
Centered on the canvas with generous white margin. No other elements, no decoration, no extra characters. Square 1024x1024."

# H2: Stacked — # on top, MD on bottom
gen_logo "concept_h2_stacked" \
"A minimalist app icon on pure white background. \
The icon has two stacked elements perfectly centered: \
TOP element: a clean geometric markdown hash symbol '#' in solid pure black, equal stroke width. \
BOTTOM element: directly below the hash, the two uppercase letters 'MD' in a clean modern geometric sans-serif font, in solid pure black, same visual weight as the hash above. \
The hash and the 'MD' letters should appear as one balanced unified mark, like a vertical monogram. \
No other text, no decoration. Centered, square 1024x1024."

# H3: # symbol where MD is tucked inside the central square
gen_logo "concept_h3_inside" \
"A minimalist tech logo on pure white background. \
The main shape is a markdown hash symbol '#' drawn cleanly with four bars in solid pure black, perfectly geometric, equal stroke width. \
Inside the central square formed by the intersection of the four bars of the hash, place the two small uppercase letters 'MD' in a clean geometric sans-serif font, in solid pure black, sized to fit neatly inside that central square. \
The hash # frames the letters MD. \
Centered composition, generous white margin, no other elements. Square 1024x1024."

# H4: Square badge — # left, MD right, enclosed in a rounded square
gen_logo "concept_h4_badge" \
"A minimalist app icon on pure white background. \
A rounded square outline (thin solid black stroke, generous corner radius) contains two elements side by side, centered inside: \
on the left, a clean geometric markdown hash symbol '#' in solid black; \
on the right, the two uppercase letters 'MD' in a clean modern geometric sans-serif, also in solid black, the same height as the hash. \
Equal visual weight. The whole composition reads like a small badge labeling 'hash MD'. \
Generous outer white margin. No other text. Square 1024x1024."

echo "Done. Files:"
ls -la concept_h*.png 2>/dev/null
