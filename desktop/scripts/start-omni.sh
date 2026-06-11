#!/usr/bin/env bash
# start-omni.sh — Start llama-server + omni-adapter for Companion video call
# Usage: bash scripts/start-omni.sh
set -e

LLAMA_DIR="$HOME/Code/Llm/llama.cpp-omni"
MODEL_DIR="$HOME/Code/Llm/MiniCPM-o-4_5-gguf"
LLAMA_PORT=8025
ADAPTER_PORT=9301

echo "=== Starting llama-server (MiniCPM-o-4_5) ==="
"$LLAMA_DIR/build/bin/llama-server" \
  --host 0.0.0.0 --port "$LLAMA_PORT" \
  -m "$MODEL_DIR/MiniCPM-o-4_5-Q4_K_M.gguf" \
  --mmproj "$MODEL_DIR/vision/MiniCPM-o-4_5-vision-F16.gguf" \
  --model-vocoder "$MODEL_DIR/tts/MiniCPM-o-4_5-tts-F16.gguf" \
  -ngl 99 \
  --temp 0.7 \
  --repeat-penalty 1.15 \
  --ctx-size 2048 \
  --no-kv-offload \
  --no-mmproj-offload &
LLAMA_PID=$!
echo "llama-server PID: $LLAMA_PID"

# Wait for server to be ready
echo "Waiting for llama-server..."
for i in $(seq 1 30); do
  if curl -s "http://localhost:$LLAMA_PORT/health" > /dev/null 2>&1; then
    echo "llama-server ready!"
    break
  fi
  sleep 2
done

echo ""
echo "=== Starting omni-adapter ==="
OMNI_PORT="$ADAPTER_PORT" LLAMA_SERVER="http://localhost:$LLAMA_PORT" \
  OMNI_MODEL_DIR="$MODEL_DIR" \
  OMNI_TMP="/tmp/omni-adapter" \
  bun run "$(dirname "$0")/../sidecars/omni-adapter.ts" &
ADAPTER_PID=$!
echo "omni-adapter PID: $ADAPTER_PID"

echo ""
echo "=== Ready ==="
echo "llama-server: http://localhost:$LLAMA_PORT"
echo "omni-adapter: http://localhost:$ADAPTER_PORT"
echo ""
echo "Then start the desktop app and set backendHost to http://localhost:$ADAPTER_PORT"
echo ""
echo "Press Ctrl+C to stop all services"

trap "kill $LLAMA_PID $ADAPTER_PID 2>/dev/null; echo 'stopped'" EXIT
wait
