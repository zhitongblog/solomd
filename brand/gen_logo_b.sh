#!/usr/bin/env bash
# Regenerate concept B (hash mark) variants for SoloMD
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

# B1: Pure hash # with one of four strokes replaced by a blinking text cursor
gen_logo "concept_b1_hash_cursor" \
"A minimalist tech logo on a pure white background. \
The shape is the markdown heading symbol '#' (hash sign / pound sign), drawn as four straight bars: two horizontal and two vertical, forming the standard hash grid. \
IMPORTANT: the hash sign must remain perfectly recognizable as a # symbol. \
The only modification: the right vertical bar of the # is replaced by a slightly thicker, slightly taller vertical bar that looks like a text cursor (text input caret '|'). \
Solid pure black color. Sharp clean geometric vector style. \
Centered, balanced composition, generous white margin. \
No text, no letters, no words, no decoration. Square 1024x1024."

# B2: Hash # with a single dot above to signal "solo" / single point
gen_logo "concept_b2_hash_dot" \
"A minimalist developer-tool logo on a pure white background. \
Main element: the markdown heading symbol '#' (hash sign), drawn cleanly with four straight bars in solid pure black, perfectly geometric, equal stroke width. \
Above the # symbol, centered horizontally, sits a single small filled solid black circle (a dot), about 1/4 the size of the hash. \
The dot represents 'solo' / a single point / a single file. \
Sharp vector style, clean edges, ultra minimal. \
No text, no letters, no words. Centered composition with white margin. Square 1024x1024."

# B3: Stylized hash where the bars compress into a unique signature shape
gen_logo "concept_b3_hash_compact" \
"A minimalist monogram logo on a pure white background for a markdown editor app. \
The mark is a stylized markdown hash symbol '#' but designed as a tight compact square block: \
two short horizontal black bars stacked, crossed by two short vertical black bars, all with equal stroke width, forming a perfectly square # glyph that fits inside an invisible square frame. \
The hash must be clearly readable as a # symbol. \
Solid pure black on pure white background. Sharp geometric vector style, like an SF Symbol or a modern app icon glyph. \
No text, no letters, no words. Centered, generous margin. Square 1024x1024."

echo "Done. Files:"
ls -la concept_b*.png 2>/dev/null
