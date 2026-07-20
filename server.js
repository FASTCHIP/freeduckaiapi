import http from "http";
import fs from "fs";
import puppeteer from "puppeteer";

const PORT = parseInt(process.env.PORT || "3000", 10);
const CHROME = process.env.CHROME_PATH || "/opt/chrome/chrome-linux64/chrome";
const VL_URL = process.env.VL_URL || "http://localhost:8084/v1/chat/completions";
const VL_MODEL = process.env.VL_MODEL || "qwen25-vl-7b";
// Hard ceiling for a single request (ms). Guarantees the mutex is released.
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || "175000", 10);
const EVAL_TIMEOUT = parseInt(process.env.EVAL_TIMEOUT || "30000", 10);

// Models exposed through the OpenAI-compatible API, mapped to their Duck.ai UI labels.
const MODELS = [
  "gpt-5.4-nano", "gpt-5-mini", "claude-3-5-haiku-latest",
  "mistralai/Mistral-Small-24B-Instruct-2501", "openai/gpt-oss-120b"
];

const MODEL_UI = {
  "gpt-5.4-nano": "GPT-5.4 nano",
  "gpt-5-mini": "GPT-5.4 mini",
  "claude-3-5-haiku-latest": "Claude Haiku 4.5",
  "mistralai/Mistral-Small-24B-Instruct-2501": "Mistral Small 4",
  "openai/gpt-oss-120b": "gpt-oss 120B"
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Race a promise against a timeout so a hung browser cannot wedge the proxy forever.
function withTimeout(promise, ms, label) {
  let timer;
  const guarded = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout:" + label)), ms);
  });
  return Promise.race([promise, guarded]).finally(() => clearTimeout(timer));
}

let browser = null, page = null, busy = false;

async function ensureBrowser() {
  if (browser) return;
  console.log("[init] launching chrome");
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
  console.log("[init] chrome launched");
}

async function newPage() {
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 900 });
  await p.setUserAgent(UA);
  await p.goto("https://duck.ai/", { waitUntil: "networkidle2", timeout: 60000 });
  await p.waitForSelector("textarea", { timeout: 30000 });
  await sleep(1500);
  return p;
}

// Timeout-wrapped page helpers.
const peval = (fn, ...args) => withTimeout(page.evaluate(fn, ...args), EVAL_TIMEOUT, "evaluate");
const pevalHandle = (fn, ...args) => withTimeout(page.evaluateHandle(fn, ...args), EVAL_TIMEOUT, "evaluateHandle");
const pclick = (x, y) => withTimeout(page.mouse.click(x, y), EVAL_TIMEOUT, "click");

async function selectModel(model) {
  const ui = MODEL_UI[model];
  if (!ui) { console.log("[model] unknown model, using current selection"); return; }
  const clicked = await peval(() => {
    const ta = document.querySelector("textarea");
    const tar = ta.getBoundingClientRect();
    let sel = Array.from(document.querySelectorAll("button")).find((b) => {
      const r = b.getBoundingClientRect();
      const t = (b.textContent || "").trim();
      return Math.abs(r.y - tar.y) < 200 && /nano|mini|haiku|scout|mistral|gpt-oss|claude|llama|4o/i.test(t) && t !== "Tools" && t !== "Fast";
    });
    if (!sel) {
      sel = Array.from(document.querySelectorAll("button")).find((b) => {
        const r = b.getBoundingClientRect();
        const t = (b.textContent || "").trim();
        return r.x > 250 && /nano|mini|haiku|scout|mistral|gpt-oss|claude|llama|4o/i.test(t) && t !== "Tools" && t !== "Fast";
      });
    }
    if (sel) { sel.click(); return sel.textContent.trim(); }
    return null;
  });
  await sleep(1000);
  const picked = await peval((target) => {
    const opts = Array.from(document.querySelectorAll("button"));
    const matches = opts.filter((b) => {
      const t = (b.textContent || "").trim().toLowerCase();
      return t.includes(target.toLowerCase()) && b.offsetParent !== null;
    });
    if (!matches.length) return null;
    matches.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
    const o = matches[0];
    o.click();
    return o.textContent.trim();
  }, ui);
  console.log("[model] selector:", clicked, "picked:", picked);
  await sleep(800);
}

async function getTiles() {
  return await peval(() => {
    const all = Array.from(document.querySelectorAll("div, button, span"));
    for (const el of all) {
      const kids = Array.from(el.children).filter((k) => {
        const r = k.getBoundingClientRect();
        return r.width > 30 && r.height > 30 && Math.abs(r.width - r.height) < 30;
      });
      if (kids.length >= 6 && kids.length <= 12) {
        return kids.map((k, i) => {
          let url = null;
          const styled = k.querySelector("[style*='background-image']");
          if (styled) {
            const st = styled.getAttribute("style") || "";
            const m = st.match(/url\(["']?([^"')]+)["']?\)/);
            if (m) url = m[1].startsWith("http") ? m[1] : "https://duck.ai" + m[1];
          }
          return { index: i, url };
        });
      }
    }
    return [];
  });
}

async function solveCaptcha() {
  console.log("[captcha] solving...");
  const tiles = await getTiles();
  if (!tiles.length) { console.log("[captcha] no tiles"); return; }
  const shots = [];
  for (const t of tiles) {
    if (t.url) {
      try {
        const r = await fetch(t.url);
        const buf = Buffer.from(await r.arrayBuffer());
        shots.push({ index: t.index, b64: buf.toString("base64") });
        continue;
      } catch (e) { console.log("[captcha] dl fail", t.url, e.message); }
    }
    const b = await peval((i) => {
      const el = document.querySelector(`[data-index="${i}"]`);
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, t.index);
    const p = `/tmp/cap_${t.index}.png`;
    await page.screenshot({ path: p, clip: { x: Math.max(0, b.x), y: Math.max(0, b.y), width: Math.min(300, b.width), height: Math.min(300, b.height) } });
    shots.push({ index: t.index, b64: fs.readFileSync(p).toString("base64") });
  }
  const content = shots.map((s) => ({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + s.b64 } }));
  content.push({ type: "text", text: "This is a 3x3 grid of images, positions 1-9 (row-major, top-left is position 1, bottom-right is 9). For EACH position, decide whether it shows a duck (a yellow waterbird). List ONLY the positions that contain a duck, as comma-separated numbers like 2,5,8. If none contain a duck, reply exactly NONE." });
  const body = { model: VL_MODEL, messages: [{ role: "user", content }], max_tokens: 30, temperature: 0 };
  const resp = await fetch(VL_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await resp.json();
  const answer = (j.choices?.[0]?.message?.content || "").trim().toUpperCase();
  console.log("[captcha] vision:", answer);
  const idxs = answer === "NONE" ? [] : answer.split(/[,\s]+/).map((s) => parseInt(s, 10) - 1).filter((n) => n >= 0 && n < tiles.length);
  for (const idx of idxs) {
    await peval((i) => { const t = document.querySelector(`[data-index="${i}"]`); if (t) t.click(); }, idx);
    await sleep(250);
  }
  await peval(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => (x.textContent || "").trim().toLowerCase() === "submit");
    if (b) b.click();
  });
  console.log("[captcha] submitted squares:", idxs.map((i) => i + 1).join(",") || "NONE");
  await sleep(3500);
}

async function hasCaptcha() {
  return await peval(() => document.body.innerText.includes("Select all squares"));
}

async function dismissConsent() {
  return await peval(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => /agree and continue/i.test(x.textContent || "") && x.offsetParent !== null);
    if (b) { b.click(); return "agree"; }
    const c = Array.from(document.querySelectorAll("button")).find((x) => /^\s*continue\s*$/i.test(x.textContent || "") && x.offsetParent !== null);
    if (c) { c.click(); return "continue"; }
    return false;
  });
}

async function extractAnswer(userPrompt) {
  return await peval((prompt) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const p = norm(prompt);
    const els = Array.from(document.querySelectorAll("*")).filter((e) => {
      const t = norm(e.textContent || "");
      return t.includes(p) && e.getBoundingClientRect().x > 250 && e.offsetParent !== null;
    });
    if (!els.length) return null;
    let best = "", bestLen = -1;
    for (const e of els) {
      const full = norm(e.innerText);
      const pos = full.lastIndexOf(p);
      const after = pos >= 0 ? full.slice(pos + p.length) : "";
      if (after.length > bestLen) { bestLen = after.length; best = after; }
    }
    return best;
  }, userPrompt);
}

async function waitForResponse(userPrompt, maxMs = 90000) {
  let last = "", stable = 0;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await hasCaptcha()) return { text: "", captcha: true };
    let answer = await extractAnswer(userPrompt);
    if (answer === null) answer = "";
    answer = answer
      .replace(/Duck\.ai works best[\s\S]*$/s, "")
      .replace(/All chats are private[\s\S]*$/i, "")
      .replace(/Stop generating.*$/s, "")
      .replace(/You have \d+ attempts left.*$/s, "")
      .replace(/Please try again.*$/s, "")
      .replace(/^\s*(GPT-5\.4 nano|GPT-5\.4 mini|Claude Haiku 4\.5|Mistral Small 4|gpt-oss 120B)\s*/i, "")
      .replace(/^[\s·]*Private\s*/i, "")
      .trim();
    let prev;
    do {
      prev = answer;
      answer = answer.replace(/(^|\s)\s*(Tools|Fast|Private)\s*$/g, "$1").trim();
    } while (answer !== prev);
    if (answer === last && answer.length > 0) stable++; else stable = 0;
    last = answer;
    if (stable >= 2 && answer.length > 0) break;
    await sleep(1000);
  }
  return { text: last, captcha: false };
}

async function duckChat(model, userText) {
  await ensureBrowser();
  page = await newPage();
  console.log("[page] new page created");
  try {
  await sleep(2000);
  if (await dismissConsent()) console.log("[consent] dismissed on load");
  if (await hasCaptcha()) { console.log("[captcha] detected on load, solving"); await solveCaptcha(); }
  await selectModel(model);
  const taHandle = await pevalHandle(() => {
    const tas = Array.from(document.querySelectorAll("textarea")).filter((t) => t.offsetParent !== null);
    return tas[0] || document.querySelector("textarea");
  });
  // Set the prompt instantly via the native value setter + input event.
  // Char-by-char page.type() is O(n^2) in React textareas and hangs on huge prompts.
  const setOk = await peval((text) => {
    const ta = Array.from(document.querySelectorAll("textarea")).filter((t) => t.offsetParent !== null)[0] || document.querySelector("textarea");
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return ta.value.length > 0;
  }, userText).catch(() => false);
  if (!setOk) {
    // Fallback: focus and type (slow path) only if the instant set failed.
    const taEl = taHandle.asElement();
    if (taEl) {
      const bb = await taEl.boundingBox();
      if (bb) await pclick(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await taEl.click({ clickCount: 3 }).catch(() => {});
      await page.keyboard.press("Backspace");
      await withTimeout(taEl.type(userText, { delay: 1 }), 120000, "type");
    }
  }
  if (await dismissConsent()) console.log("[consent] dismissed before submit");
  let box = null;
  for (let i = 0; i < 30; i++) {
    box = await peval(() => {
      const els = Array.from(document.querySelectorAll("button, [role='button']"));
      const isSubmit = (b) => {
        const t = (b.textContent || "").trim().toLowerCase();
        const aria = (b.getAttribute("aria-label") || "").toLowerCase();
        return (t === "ask" || t === "send" || aria.includes("send")) && !aria.includes("stop");
      };
      const ask = els.find(isSubmit);
      if (ask) { const r = ask.getBoundingClientRect(); if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
      return null;
    });
    if (box) break;
    await sleep(500);
  }
  if (!box) {
    const diag = await peval(() => {
      const ta = Array.from(document.querySelectorAll("textarea")).filter((t) => t.offsetParent !== null)[0] || document.querySelector("textarea");
      const tar = ta ? ta.getBoundingClientRect() : null;
      const els = Array.from(document.querySelectorAll("button, [role='button']"));
      const near = els.filter((b) => { const r = b.getBoundingClientRect(); return tar && Math.abs(r.y - tar.y) < 120; }).map((b) => ({ text: (b.textContent || "").trim().slice(0, 30), aria: b.getAttribute("aria-label") }));
      return { near, taCount: document.querySelectorAll("textarea").length, taVal: ta ? ta.value.slice(0, 30) : "NONE" };
    }).catch(() => null);
    console.log("[chat] submit button not found. DIAG:", JSON.stringify(diag));
    return "";
  }
  await pclick(box.x, box.y);
  console.log("[chat] submitted:", userText.slice(0, 60));

  const deadline = Date.now() + 160000;
  let result = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    if (Date.now() > deadline) break;
    await sleep(4000);
    if (Date.now() > deadline) break;
    if (await hasCaptcha()) { await solveCaptcha(); continue; }
    if (await dismissConsent()) console.log("[consent] dismissed mid-chat");
    const { text, captcha } = await waitForResponse(userText, Math.max(5000, deadline - Date.now()));
    if (captcha) { await solveCaptcha(); continue; }
    if (text) { result = text; break; }
  }
  return result;
  } finally {
    try { if (page) await page.close(); } catch (e) {}
    page = null;
  }
}

const server = http.createServer(async (req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    return res.end(JSON.stringify({ status: "ok" }));
  }
  if (req.url === "/v1/models" && req.method === "GET") {
    const data = MODELS.map((id) => ({ id, object: "model", created: 1784532458, owned_by: "duckai" }));
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    return res.end(JSON.stringify({ object: "list", data }));
  }
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const reqBody = JSON.parse(body);
        const model = reqBody.model || MODELS[0];
        const msgs = reqBody.messages || [];
        // Flatten the conversation into a single prompt (Duck.ai has one input box).
        // Newlines are collapsed to spaces so they don't trigger form submission.
        const userText = msgs.map((m) => {
          const role = m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "User";
          return role + ": " + (m.content || "").replace(/\s+/g, " ");
        }).join("  ");
        if (busy) {
          res.writeHead(429, { "Content-Type": "application/json", ...cors });
          return res.end(JSON.stringify({ error: { message: "busy", type: "rate_limit" } }));
        }
        busy = true;
        let answer;
        try {
          answer = await withTimeout(duckChat(model, userText), REQUEST_TIMEOUT, "request");
        } catch (e) {
          console.error("[request-timeout]", e.message);
          answer = "";
        } finally {
          busy = false;
        }
        const out = {
          id: "chatcmpl-" + Math.random().toString(36).slice(2, 15),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        };
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify(out));
      } catch (e) {
        busy = false;
        console.error("[error]", e);
        res.writeHead(500, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ error: { message: e.message, type: "internal_server_error" } }));
      }
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json", ...cors });
  res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }));
});

server.listen(PORT, () => console.log(`freeduckaiapi proxy on :${PORT}`));

process.on("SIGTERM", async () => {
  console.log("[sigterm] shutting down");
  try { if (browser) await browser.close(); } catch (e) {}
  process.exit(0);
});
