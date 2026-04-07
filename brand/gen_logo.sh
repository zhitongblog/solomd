#!/usr/bin/env bash
# Generate SoloMD logo concepts using Gemini 2.5 Flash Image
# Usage: GEMINI_API_KEY=xxx ./gen_logo.sh

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

  # Extract base64 image
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

# Concept D: Minimal dot + underline
gen_logo "concept_d_dot" \
"A minimalist tech product logo for an app called 'SoloMD', a lightweight markdown text editor. \
The logo is a single small filled circle (representing a text cursor blink) sitting just above a short horizontal underline. \
Pure geometric, ultra minimal, like Linear or Vercel branding. \
Solid pure black on a clean pure white background. Centered. No text, no letters, no words. \
Vector style, sharp edges, perfectly balanced composition. Square 1024x1024."

# Concept A: Letter S with cursor
gen_logo "concept_a_s_cursor" \
"A minimalist monogram logo for a lightweight markdown editor app called 'SoloMD'. \
The logo is a single bold geometric letter S, with a tiny vertical cursor bar '|' integrated inside the negative space of the S. \
Modern sans-serif, very clean, no decoration. \
Solid pure black on pure white background. Centered. No other text, no words. \
Tech startup branding style like Stripe or Notion. Square 1024x1024."

# Concept B: Hash mark variation
gen_logo "concept_b_hash" \
"A minimalist geometric logo for a markdown editor app called 'SoloMD'. \
The logo is the markdown heading symbol '#' (hash sign) but stylized: one of its strokes morphs subtly into the digit '1' or letter 'S' to convey 'solo / single'. \
Strict geometric, monoline, equal stroke width. \
Solid pure black on pure white background. Centered. No surrounding text or words. \
Developer-tool aesthetic like GitHub or Vercel. Square 1024x1024."

echo "Done. Files:"
ls -la *.png 2>/dev/null || echo "No PNGs generated"
