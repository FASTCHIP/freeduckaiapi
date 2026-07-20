# freeduckaiapi — Design Spec

**Date:** 2026-07-20
**Status:** Approved
**License:** MIT
**Visibility:** Public (GitHub: `FASTCHIP/freeduckaiapi`)

## 1. Purpose

Provide a local, OpenAI-compatible API that proxies requests to Duck.ai's
web chat. Duck.ai shows a "select all squares with a duck" CAPTCHA and does not
expose a public API; this project drives a real headless Chrome browser
(Puppeteer) to use the web UI, and solves the CAPTCHA automatically with a
local vision-language model.

> **ToS notice.** The tool programmatically bypasses Duck.ai's CAPTCHA. This may
> violate Duck.ai's Terms of Service. It is provided for educational / personal
> use. The author is not responsible for misuse.

## 2. Components

### 2.1 Proxy (`server.js`)
- Node.js + Puppeteer + headless Chrome.
- Exposes an OpenAI-compatible surface:
  - `GET /health` → `{ "status": "ok" }`
  - `GET /v1/models` → list of 5 Duck.ai models
  - `POST /v1/chat/completions` → streams-free JSON chat completion
- Per request it: opens a fresh page, dismisses consent modals, solves a CAPTCHA
  if present, selects the requested model, types the prompt, clicks Submit
  (matched by `aria-label="Send"` / text "Ask"), waits for the answer, and
  extracts + cleans it.
- Single in-flight request (mutex `busy`); returns 429 when busy.

### 2.2 Reference vision service (`vision-service/`)
- `qwen25-vl-7b` served by `llama.cpp` (`llama-server`), OpenAI-compatible on
  `:8084`. Used by the proxy to read the CAPTCHA grid and decide which squares
  contain a duck.
- Ships example systemd unit + env file + manual start script.

## 3. Configuration (env vars, with defaults)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `3000` | Proxy listen port |
| `CHROME_PATH` | `/opt/chrome/chrome-linux64/chrome` | Chrome binary |
| `VL_URL` | `http://localhost:8084/v1/chat/completions` | Vision model endpoint |
| `VL_MODEL` | `qwen25-vl-7b` | Vision model id |

## 4. Models exposed

`gpt-5.4-nano`, `gpt-5-mini`, `claude-3-5-haiku-latest`,
`mistralai/Mistral-Small-24B-Instruct-2501`, `openai/gpt-oss-120b`.
Each maps to its Duck.ai UI label (see `MODEL_UI` in `server.js`).

## 5. File layout

```
freeduckaiapi/
├── README.md
├── LICENSE
├── .gitignore
├── package.json
├── server.js
├── deploy/
│   ├── duckai.service
│   └── install.sh
└── vision-service/
    ├── README.md
    ├── qwen25-vl-7b.env
    ├── qwen25-vl-7b.service
    └── start-vl.sh
```

## 6. Error handling

- CAPTCHA re-solved on every detection during the wait loop.
- Consent modal dismissed on load, before submit, and mid-chat.
- Answer extraction normalizes whitespace and strips UI chrome
  (model label, "Tools"/"Fast"/"Private" badges, footers).
- On submit-button-not-found, logs a diagnostic and returns empty string
  (caller sees empty `content`).
- `SIGTERM` closes the browser gracefully.

## 7. Testing / acceptance

- `curl /health` → ok.
- `curl /v1/models` → 5 models.
- Each of the 5 models returns a clean answer for a single-turn prompt.
- A 3-turn `messages` array is answered with context awareness.

## 8. Out of scope (YAGNI)

- Streaming responses (SSE).
- Persistent Duck.ai sessions across requests (each request = fresh page, by
  design, for stability).
- Authentication / multi-user accounting.
- Solving non-duck CAPTCHAs or other challenge types.
