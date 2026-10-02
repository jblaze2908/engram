#!/bin/sh
# Fetches the Model2Vec files (minishlab/potion-base-8M, MIT) from a pinned revision and checks each sha256.
# Usage: scripts/fetch-model.sh [dir]  (default app/.model; the Dockerfile uses /app/model). Revision is also in src/embed.ts.
set -eu
DIR="${1:-$(dirname "$0")/../.model}"
REV=bf8b056651a2c21b8d2565580b8569da283cab23
BASE="https://huggingface.co/minishlab/potion-base-8M/resolve/$REV"
if command -v sha256sum >/dev/null; then SUM="sha256sum"; else SUM="shasum -a 256"; fi
mkdir -p "$DIR"
fetch() {
  if [ -f "$DIR/$1" ] && [ "$($SUM "$DIR/$1" | cut -d' ' -f1)" = "$2" ]; then return; fi
  curl -fsSL --retry 3 -o "$DIR/$1.part" "$BASE/$1"
  got=$($SUM "$DIR/$1.part" | cut -d' ' -f1)
  if [ "$got" != "$2" ]; then echo "sha256 mismatch for $1: $got" >&2; rm -f "$DIR/$1.part"; exit 1; fi
  mv "$DIR/$1.part" "$DIR/$1"
}
fetch model.safetensors f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2
fetch tokenizer.json e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50
echo "model files in $DIR"
