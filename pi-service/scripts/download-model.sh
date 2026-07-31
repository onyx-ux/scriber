#!/bin/sh
set -e

MODEL_NAME="${WHISPER_MODEL_NAME:-base.en}"
MODEL_PATH="${WHISPER_MODEL_PATH:-/models/ggml-${MODEL_NAME}.bin}"

if [ -f "$MODEL_PATH" ]; then
  echo "Model already present at $MODEL_PATH"
  exit 0
fi

echo "Downloading whisper model: $MODEL_NAME ..."
mkdir -p "$(dirname "$MODEL_PATH")"

# Official ggml model mirror used by whisper.cpp's own download script.
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin"
node -e "
const https = require('node:https');
const fs = require('node:fs');
const file = fs.createWriteStream(process.argv[2]);
https.get(process.argv[1], (res) => {
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    https.get(res.headers.location, (res2) => res2.pipe(file));
  } else {
    res.pipe(file);
  }
}).on('error', (e) => { console.error(e); process.exit(1); });
" "$URL" "$MODEL_PATH"

echo "Model downloaded to $MODEL_PATH"
