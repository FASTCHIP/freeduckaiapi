# Reference vision service: `qwen25-vl-7b`

This directory contains everything needed to run the **vision-language model**
that `freeduckaiapi` uses to solve Duck.ai's "select all squares with a duck"
CAPTCHA. The proxy sends the CAPTCHA grid to this model and asks which squares
contain a duck.

The model is served with [`llama.cpp`](https://github.com/ggml-org/llama.cpp)
(`llama-server`), which exposes an **OpenAI-compatible** API on `:8084`.

---

## What is `qwen25-vl-7b`?

| Property | Value |
|----------|-------|
| Base model | Qwen2.5-VL-7B-Instruct |
| Quantization | Q4_K_M (GGUF), ~4.7 GB |
| Multimodal projector | `mmproj-F16.gguf` |
| Context window | **32768 tokens** |
| Modality | image + text → text (vision-language / VQA) |
| Server | `llama-server` (llama.cpp), OpenAI-compatible |
| Endpoint used by proxy | `http://localhost:8084/v1/chat/completions` |

### When to use it / what it is good for
- **Primary use here:** reading a 3×3 image grid and deciding which cells show a
  duck. This is a small, well-bounded vision task and the 7B model does it
  reliably.
- **General VQA:** describing images, OCR, counting objects, answering
  questions about a picture. The 32768-token context lets it handle several
  images or long image-grounded conversations in one session.
- **Not ideal for:** heavy reasoning or very long video; for that, prefer a
  larger model or a text-only model for the chat itself (the Duck.ai chat uses
  Duck.ai's own models — this VL model is only the "eyes" for the CAPTCHA).

### Hardware / context guidance
- **GPU (recommended):** a card with **≥ 8 GB VRAM** comfortably runs the Q4_K_M
  weights + mmproj with KV cache at `ctx-size 32768`. Reduce `--ctx-size` if you
  hit OOM.
- **CPU only:** works but is slow (several seconds per CAPTCHA grid). Fine for
  low-traffic use; raise `--threads` to use more cores.
- **Lower VRAM?** Use `Qwen2.5-VL-3B-Instruct-Q4_K_M` instead (see "Swapping
  models" below) — smaller, faster, less accurate on ambiguous ducks.

---

## Files in this directory

| File | Purpose |
|------|---------|
| `qwen25-vl-7b.env` | `LLAMA_ARGS` for the `llama@.service` template (drop-in style) |
| `qwen25-vl-7b.service` | Self-contained systemd unit (no template needed) |
| `start-vl.sh` | Manual one-shot launch script |

---

## Option A — systemd (recommended for servers)

1. Install `llama.cpp` so that `llama-server` is on your `PATH`
   (e.g. at `/usr/local/bin/llama-server`).
2. Place the model + mmproj:
   ```
   /srv/llama/models/vision/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf
   /srv/llama/models/vision/mmproj-F16.gguf
   ```
   (download from HuggingFace: `Qwen/Qwen2.5-VL-7B-Instruct-GGUF` and the
   matching `mmproj` for your quant).
3. Install the unit and start it:
   ```bash
   sudo cp qwen25-vl-7b.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now qwen25-vl-7b.service
   curl -s http://localhost:8084/v1/models
   ```

## Option B — manual launch

```bash
bash start-vl.sh
# or directly:
/usr/local/bin/llama-server \
  --host 0.0.0.0 --port 8084 \
  --model /srv/llama/models/vision/Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf \
  --mmproj /srv/llama/models/vision/mmproj-F16.gguf \
  --alias qwen25-vl-7b --ctx-size 32768 \
  --threads 16 --flash-attn on --cache-prompt
```

---

## Swapping models

Point `CHROME_PATH`/`VL_MODEL` from the proxy at any OpenAI-compatible vision
endpoint. To use a different local VL model, change `--model`/`--mmproj` (and
`--alias`) in the unit or `start-vl.sh`, then set the proxy's `VL_MODEL` /
`VL_URL` env vars accordingly. Smaller alternative: `Qwen2.5-VL-3B-Instruct`
(less VRAM, faster, slightly less accurate on tricky CAPTCHAs).
