#!/usr/bin/env bash
#
# Manual launch for the qwen25-vl-7b vision server (llama.cpp).
# Adjust paths / thread counts to your machine.
#
set -euo pipefail

LLAMA_SERVER="${LLAMA_SERVER:-/usr/local/bin/llama-server}"
MODEL="${MODEL:-/srv/llama/models/vision/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf}"
MMPROJ="${MMPROJ:-/srv/llama/models/vision/mmproj-F16.gguf}"
PORT="${PORT:-8084}"
CTX="${CTX:-32768}"
THREADS="${THREADS:-16}"

exec "$LLAMA_SERVER" \
  --host 0.0.0.0 --port "$PORT" \
  --model "$MODEL" --mmproj "$MMPROJ" \
  --alias qwen25-vl-7b --ctx-size "$CTX" \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --threads "$THREADS" --threads-batch "$THREADS" \
  --batch-size 2048 --ubatch-size 512 \
  --parallel 1 --cont-batching --jinja --flash-attn on --cache-prompt
