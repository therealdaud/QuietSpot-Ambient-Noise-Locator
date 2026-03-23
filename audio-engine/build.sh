#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build.sh — Compile the QuietSpot C audio engine to WebAssembly
#
# Requirements:
#   Emscripten SDK  https://emscripten.org/docs/getting_started/downloads.html
#
# Quick install (first time only):
#   git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
#   cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest
#   source ~/emsdk/emsdk_env.sh
#
# Then from the audio-engine/ directory:
#   ./build.sh
#
# Output:
#   ../web/public/audio-engine/audio_engine.js   (Emscripten JS glue)
#   ../web/public/audio-engine/audio_engine.wasm (binary WASM module)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Check emcc is available ───────────────────────────────────────────────────
if ! command -v emcc &> /dev/null; then
    echo ""
    echo "  emcc not found. Activate the Emscripten SDK first:"
    echo "    source ~/emsdk/emsdk_env.sh"
    echo ""
    exit 1
fi

echo "Using: $(emcc --version | head -1)"

# ── Output directory ──────────────────────────────────────────────────────────
OUTPUT_DIR="../web/public/audio-engine"
mkdir -p "$OUTPUT_DIR"

# ── Compile ───────────────────────────────────────────────────────────────────
emcc src/audio_engine.c src/fft.c \
    -O3 \
    -s WASM=1 \
    -s EXPORTED_FUNCTIONS='["_process_audio","_get_octave_bands","_calculate_leq","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["HEAPF32"]' \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="AudioEngine" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s ENVIRONMENT="web" \
    -s SINGLE_FILE=0 \
    -lm \
    -o "$OUTPUT_DIR/audio_engine.js"

echo ""
echo "Build complete:"
echo "  $OUTPUT_DIR/audio_engine.js"
echo "  $OUTPUT_DIR/audio_engine.wasm"
echo ""
echo "Commit both files to the repo — Vercel serves them as static assets."
