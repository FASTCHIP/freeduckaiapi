# freeduckaiapi

> [!IMPORTANT]
> **Terms of Service notice.** This tool programmatically drives a real browser
> to bypass Duck.ai's "select all squares with a duck" CAPTCHA and use its web
> chat. Doing so **may violate Duck.ai's Terms of Service**. This project is
> provided for **educational and personal use only**. The author is not
> responsible for any misuse or for any account/access consequences.

An **OpenAI-compatible API** in front of [Duck.ai](https://duck.ai) chat. It
drives a headless Chrome browser (Puppeteer), automatically solves the duck
CAPTCHA with a **local vision-language model**, picks the model you ask for, and
returns the answer — so any OpenAI-compatible client can talk to Duck.ai.

```
 OpenAI client                 freeduckaiapi (this repo)                Duck.ai web
─────────────────             ─────────────────────────────            ─────────────
 POST /v1/chat/completions ─▶  Node + Puppeteer + Chrome               ─▶  duck.ai
                                │  • solve CAPTCHA (duck grid)
                                │  • select model
                                │  • type prompt, click Send
                                │  • read answer
                                └─▶ qwen25-vl-7b (llama.cpp :8084)
                                      "which squares have a duck?"
```

## Features

- OpenAI-compatible: `/v1/chat/completions`, `/v1/models`, `/health`.
- Automatic CAPTCHA solving via a local vision model (no external service).
- All 5 Duck.ai models exposed (GPT, Claude, Mistral, gpt-oss).
- Multi-turn `messages` are flattened into the prompt so context is preserved.
- Single in-flight request (mutex); returns `429` when busy.

## Requirements

- Linux, Node.js ≥ 18.
- Google Chrome for Testing (or any Chrome) — path via `CHROME_PATH`.
- `puppeteer` (installed via `npm install`).
- A running **vision service** (see [`vision-service/`](vision-service/README.md))
  — by default `qwen25-vl-7b` on `http://localhost:8084`.

## Quick start

### 1. Start the vision service (CAPTCHA "eyes")

```bash
cd vision-service
sudo cp qwen25-vl-7b.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qwen25-vl-7b.service
curl -s http://localhost:8084/v1/models      # should list qwen25-vl-7b
```
See [`vision-service/README.md`](vision-service/README.md) for model download
links, hardware guidance, and a manual-launch script.

### 2. Start the proxy

```bash
npm install
node server.js
# or as a systemd service:
sudo bash deploy/install.sh
curl -s http://localhost:3000/health         # {"status":"ok"}
```

### 3. Use it like OpenAI

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-mini",
    "messages": [{"role":"user","content":"What is 2+2? Answer in one sentence."}]
  }'
```

## Configuration

All optional; sensible defaults are shown.

| Env var | Default | Meaning |
|---------|---------|---------|
| `PORT` | `3000` | Proxy listen port |
| `CHROME_PATH` | `/opt/chrome/chrome-linux64/chrome` | Chrome binary |
| `VL_URL` | `http://localhost:8084/v1/chat/completions` | Vision endpoint |
| `VL_MODEL` | `qwen25-vl-7b` | Vision model id |

## Models

`freeduckaiapi` exposes the models Duck.ai currently offers. Pick by `model`
id in the request:

| `model` id | Duck.ai UI label | Good for / context |
|------------|------------------|--------------------|
| `gpt-5.4-nano` | GPT-5.4 nano | Fast, cheap, everyday tasks: short Q&A, drafting, summarising. Lowest latency, best for high-volume/throwaway calls. |
| `gpt-5-mini` | GPT-5.4 mini | A step up in quality over nano; still quick. Good default for general chat when you want better reasoning without burning limits. |
| `claude-3-5-haiku-latest` | Claude Haiku 4.5 | Precise, careful, concise answers. Great for instruction-following, classification, and when you want a "straight" answer (it will not role-play or misidentify itself). |
| `mistralai/Mistral-Small-24B-Instruct-2501` | Mistral Small 4 | Strong open-weight instruct model; good for structured/instructional tasks and privacy-minded use. |
| `openai/gpt-oss-120b` | gpt-oss 120B | Largest/open model here; best for heavier reasoning and open-weight workflows. Slower and uses more of your rate budget. |

> Model availability depends on your Duck.ai account — if a model is missing
> from the UI, remove it from the `MODELS` array in `server.js`.

## How CAPTCHA solving works

1. After loading duck.ai, the proxy checks for the "Select all squares" challenge.
2. It reads the 3×3 grid images (or downloads them directly from the page).
3. It sends the grid to the vision model with the prompt: *"which positions
   contain a duck?"*
4. It clicks the duck squares and presses **Submit**, then waits for the chat.
5. If a CAPTCHA re-appears mid-conversation, it is solved again automatically.

## Limitations

- **One request at a time.** Concurrent calls get `429`; the browser is shared.
- **Fresh page per request** (by design, for stability) — Duck.ai conversation
  history is not persisted between separate API calls. Pass history in
  `messages` and the proxy flattens it into the prompt.
- **No streaming** (SSE) yet — responses are returned once complete.
- Duck.ai UI changes can break selectors; the proxy logs a diagnostic if the
  submit button can't be found.

## License

[MIT](LICENSE).
