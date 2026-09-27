/**
 * Live preview server for TradePass.
 *
 * Standalone Node HTTP server that serves the same UI as the Next.js app,
 * with a working /api/chat endpoint that calls the real Gemini API.
 *
 * Use this when the Next.js install is broken (Windows npm issues) but you
 * still want to see and interact with the UI in a browser.
 *
 * Run with:
 *   GEMINI_API_KEY=... node live-server.mjs
 *
 * Then open http://localhost:3000
 */

import http from "node:http";
import { URL } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const SOURCES = [
  {
    id: "AfCFTA-ROO-1",
    title: "AfCFTA Rules of Origin Guide (AfCFTA Secretariat)",
    text: "To qualify for AfCFTA preferential tariffs, a product must meet the applicable Rule of Origin: either wholly obtained in Africa, or sufficiently processed/transformed there (e.g. a minimum percentage of value added, or a change in tariff heading). Processed food products generally need proof that key inputs were sourced or transformed within an AfCFTA member state, plus a valid Certificate of Origin issued by an approved exporter or customs authority in the exporting country.",
  },
  {
    id: "AfCFTA-QA-1",
    title: "AfCFTA Q&A for MSMEs (AfCFTA Secretariat)",
    text: "A trader must apply for a Certificate of Origin BEFORE export, submitting an invoice, packing list, and evidence of origin (e.g. supplier declarations) to the customs/trade authority. Without this certificate, the shipment will be charged the standard (non-preferential) tariff rate at the border.",
  },
  {
    id: "KRA-EAC-1",
    title: "Kenya Revenue Authority - EAC/COMESA Export Basics",
    text: "For exports from Kenya to Uganda (both EAC and AfCFTA members), a trader typically needs: a KRA PIN, an export entry declaration via the Customs system, a Certificate of Origin (EAC or AfCFTA), a commercial invoice, a packing list, and for processed foods, a health/phytosanitary certificate from the Kenya Bureau of Standards (KEBS) or the relevant food safety authority.",
  },
  {
    id: "UBOS-1",
    title: "Uganda Revenue Authority - Import Requirements (general)",
    text: "Goods entering Uganda require a customs import declaration, and processed food imports typically require a certificate of conformity or import permit from the Uganda National Bureau of Standards (UNBS), in addition to standard commercial documents (invoice, packing list, certificate of origin).",
  },
  {
    id: "NTB-1",
    title: "tralac Trade Law Centre - AfCFTA Non-Tariff Barriers",
    text: "Common barriers traders face at African borders include inconsistent application of rules of origin, unclear or changing documentation requirements, and delays at customs posts. Traders are advised to confirm current requirements directly with customs authorities before shipping, since rules can change and may be applied inconsistently at different border posts.",
  },
];

const SYSTEM_PROMPT = `You are TradePass, an AI assistant that helps small traders in Africa understand what \
documents they need and whether their product likely qualifies for AfCFTA preferential tariffs.
You must ONLY use the SOURCE SNIPPETS given below. Do not invent tariff rates, laws, or requirements that are \
not in the sources.
Rules:
1. Always answer in this structure:
   - **Documents likely needed:** (bullet list)
   - **AfCFTA origin qualification:** (short paragraph: likely yes / likely no / unclear, and why)
   - **Next step:** (one practical action, e.g. which office/authority to confirm with)
   - **Sources used:** (list the [source-id] tags you relied on)
2. If the sources do not clearly cover the question, say so honestly: "I don't have enough information on this \
in my current sources — please confirm with your local customs authority or trade office." Do not guess.
3. Keep the tone practical and simple, for someone who may not be a trade expert.
4. This is general guidance, not legal or customs advice — always end with that one-line disclaimer.
SOURCE SNIPPETS:
{context}
`;

function classifyError(e) {
  const raw = String(e ?? "").toLowerCase();
  const detail = String(e ?? "");
  if (
    raw.includes("api key") ||
    raw.includes("unauthenticated") ||
    raw.includes("401") ||
    raw.includes("403") ||
    raw.includes("api_key_invalid") ||
    raw.includes("permission_denied")
  )
    return { bucket: "auth", message: "Your Gemini API key is missing, invalid, or lacks permission. Update `GEMINI_API_KEY` and try again.", detail };
  if (
    raw.includes("rate limit") ||
    raw.includes("429") ||
    raw.includes("quota") ||
    raw.includes("resource_exhausted")
  )
    return { bucket: "rate_limit", message: "You've hit the Gemini API quota or rate limit. Please wait a minute and try again.", detail };
  if (
    raw.includes("connection") ||
    raw.includes("timeout") ||
    raw.includes("network") ||
    raw.includes("unreachable") ||
    raw.includes("dns") ||
    raw.includes("econn")
  )
    return { bucket: "network", message: "Couldn't reach the AI service. Check your internet connection and try again.", detail };
  if (
    raw.includes("safety") ||
    raw.includes("blocked") ||
    raw.includes("recitation") ||
    raw.includes("content_filter")
  )
    return { bucket: "safety", message: "The AI couldn't safely answer that request. Try rephrasing your question.", detail };
  return { bucket: "unknown", message: "TradePass couldn't generate a response. Please try again. If the problem persists, contact the app administrator.", detail };
}

function buildPrompt(history, userQuestion) {
  const context = SOURCES.map((s) => `[${s.id}] ${s.title}:\n${s.text}`).join("\n\n");
  const sys = SYSTEM_PROMPT.replace("{context}", context);
  const historyBlock =
    history.length === 0
      ? ""
      : "\n\nCONVERSATION SO FAR:\n" +
        history
          .map((t) =>
            t.role === "user"
              ? `TRADER (previous): ${t.content}`
              : `TRADEPASS (previous): ${t.content}`,
          )
          .join("\n") +
        "\n";
  return `${sys}${historyBlock}\n\nTRADER QUESTION:\n${userQuestion}`;
}

const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey && apiKey !== "PASTE_YOUR_KEY_HERE" ? new GoogleGenAI({ apiKey }) : null;

// ===== HTML page (matches the React UI 1:1) =====
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>TradePass — AfCFTA export guidance</title>
<style>
  *,*::before,*::after { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:#fafaf9; color:#1c1917; }
  .app { max-width: 64rem; margin: 0 auto; height: 100vh; display: flex; flex-direction: column; background: white; box-shadow: 0 0 0 1px #e7e5e4; }
  @media (min-width: 640px) { .app { border-left: 1px solid #e7e5e4; border-right: 1px solid #e7e5e4; } }
  header { display:flex; align-items:center; justify-content:space-between; padding: 12px 16px; border-bottom: 1px solid #e7e5e4; background: rgba(255,255,255,0.7); backdrop-filter: blur(8px); }
  @media (min-width: 640px) { header { padding: 12px 24px; } }
  .brand { display:flex; align-items:center; gap:12px; }
  .logo { width:36px; height:36px; border-radius:50%; background: linear-gradient(135deg, #f59e0b, #059669); display:flex; align-items:center; justify-content:center; color:white; font-size:18px; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
  h1 { font-size: 16px; font-weight: 600; margin:0; }
  .tagline { font-size: 12px; color: #78716c; margin:0; }
  .actions { display:flex; align-items:center; gap:8px; }
  .badge { display: none; padding: 4px 10px; border-radius: 999px; background: #f5f5f4; font-size: 12px; color: #57534e; }
  @media (min-width: 640px) { .badge { display:inline-block; } }
  .clear { border: 1px solid #e7e5e4; background: white; padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 500; color: #44403c; cursor: pointer; }
  .clear:hover { background: #fafaf9; }
  .scroll { flex:1; overflow-y: auto; padding: 24px 16px; }
  @media (min-width: 640px) { .scroll { padding: 24px 24px; } }
  .container { max-width: 48rem; margin: 0 auto; display:flex; flex-direction: column; gap: 16px; }
  .empty { display:flex; flex-direction: column; align-items: center; padding-top: 40px; text-align: center; }
  .empty-emoji { font-size: 48px; margin-bottom: 12px; }
  .empty h2 { font-size: 18px; font-weight: 600; color: #292524; margin: 0; }
  .empty p { margin-top: 4px; max-width: 28rem; font-size: 14px; color: #78716c; }
  .chips { display: grid; gap: 8px; margin-top: 24px; }
  @media (min-width: 640px) { .chips { grid-template-columns: 1fr 1fr; } }
  .chip { border: 1px solid #e7e5e4; background: white; padding: 10px 12px; border-radius: 12px; font-size: 14px; color: #44403c; text-align: left; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .chip:hover { border-color: #6ee7b7; background: #ecfdf5; }
  .row { display:flex; align-items:flex-start; gap: 12px; }
  .row.user { flex-direction: row-reverse; }
  .avatar { width: 32px; height: 32px; flex-shrink: 0; border-radius: 50%; display:flex; align-items: center; justify-content: center; color: white; font-size: 14px; }
  .avatar.user { background: #44403c; }
  .avatar.bot { background: #059669; }
  .bubble { max-width: 85%; padding: 12px 16px; border-radius: 16px; font-size: 14px; line-height: 1.5; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
  @media (min-width: 640px) { .bubble { max-width: 75%; } }
  .bubble.user { background: #292524; color: #fafaf9; border: 1px solid #292524; }
  .bubble.bot { background: white; color: #292524; border: 1px solid #e7e5e4; }
  .bubble p { margin: 8px 0; }
  .bubble ul { margin: 8px 0; padding-left: 20px; }
  .bubble li { margin: 4px 0; }
  .bubble strong { font-weight: 600; }
  .pending { display:flex; gap: 6px; padding: 16px; }
  .pending span { width: 8px; height: 8px; border-radius: 50%; background: #a8a29e; animation: bounce 1s infinite; }
  .pending span:nth-child(2) { animation-delay: -0.15s; }
  .pending span:nth-child(3) { animation-delay: -0.3s; }
  @keyframes bounce { 0%, 80%, 100% { transform: translateY(0); } 40% { transform: translateY(-6px); } }
  .error { margin: 0 16px 8px; padding: 12px 16px; border-radius: 8px; background: #fffbeb; border: 1px solid #fcd34d; color: #78350f; font-size: 14px; }
  @media (min-width: 640px) { .error { margin: 0 24px 8px; } }
  form { display:flex; gap: 8px; align-items:flex-end; padding: 12px 16px; border-top: 1px solid #e7e5e4; background: white; }
  @media (min-width: 640px) { form { padding: 12px 24px; } }
  form > div { max-width: 48rem; margin: 0 auto; display:flex; gap: 8px; width: 100%; align-items: flex-end; }
  textarea { flex:1; min-height: 44px; max-height: 200px; resize: none; padding: 10px 12px; border: 1px solid #d6d3d1; border-radius: 12px; font-family: inherit; font-size: 14px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  textarea:focus { outline: none; border-color: #059669; box-shadow: 0 0 0 3px rgba(5,150,105,0.2); }
  button.send { height: 44px; padding: 0 16px; background: #059669; color: white; border: none; border-radius: 12px; font-weight: 500; font-size: 14px; cursor: pointer; display:flex; align-items:center; gap: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
  button.send:disabled { background: #d6d3d1; cursor: not-allowed; }
  button.send:hover:not(:disabled) { background: #047857; }
  footer { padding: 10px 16px; border-top: 1px solid #e7e5e4; background: #fafaf9; text-align: center; font-size: 12px; color: #78716c; }
</style>
</head>
<body>
<div class="app">
  <header>
    <div class="brand">
      <div class="logo">🌍</div>
      <div>
        <h1>TradePass</h1>
        <p class="tagline">AfCFTA export guidance · grounded in official sources</p>
      </div>
    </div>
    <div class="actions">
      <span class="badge" id="badge">5 sources</span>
      <button class="clear" id="clear">🗑️ Clear</button>
    </div>
  </header>

  <div class="scroll" id="scroll">
    <div class="container" id="container">
      <div class="empty" id="empty">
        <div class="empty-emoji">🌍</div>
        <h2>What do you want to export?</h2>
        <p>Tell me the product, quantity, and your route — I'll give you a document checklist, an AfCFTA qualification check, and a next step.</p>
        <div class="chips" id="chips"></div>
      </div>
    </div>
  </div>

  <div id="error-host"></div>

  <form id="form">
    <div>
      <textarea id="input" rows="1" placeholder="e.g. I want to export 200kg of processed avocado oil from Kenya to Uganda"></textarea>
      <button type="submit" class="send" id="send">Send <span>→</span></button>
    </div>
  </form>

  <footer>Prototype scope: Kenya ↔ Uganda corridor, processed food products · <strong>Not legal or customs advice</strong> · Always confirm with local authorities</footer>
</div>

<script>
const EXAMPLES = [
  "I want to export 200kg of processed avocado oil from Kenya to Uganda",
  "What documents do I need to ship dried mangoes from Kenya to Rwanda?",
  "Does Tanzanian coffee qualify for AfCFTA preferential tariffs when exported to South Africa?",
  "I'm an MSME in Nairobi — how do I apply for a Certificate of Origin?",
];

const SID = (function() {
  let id = localStorage.getItem("tradepass.sessionId");
  if (!id) {
    id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ("s_" + Math.random().toString(36).slice(2));
    localStorage.setItem("tradepass.sessionId", id);
  }
  return id;
})();

const container = document.getElementById("container");
const empty = document.getElementById("empty");
const scroll = document.getElementById("scroll");
const chips = document.getElementById("chips");
const form = document.getElementById("form");
const input = document.getElementById("input");
const send = document.getElementById("send");
const clear = document.getElementById("clear");
const errorHost = document.getElementById("error-host");
const badge = document.getElementById("badge");

let messages = [];
let pending = false;

// Render example chips
for (const ex of EXAMPLES) {
  const b = document.createElement("button");
  b.className = "chip";
  b.textContent = ex;
  b.onclick = () => { if (!pending) sendMessage(ex); };
  chips.appendChild(b);
}

// Restore history
async function restore() {
  try {
    const r = await fetch("/api/sessions/" + SID);
    if (r.ok) {
      const j = await r.json();
      messages = (j.messages || []).map(m => ({ id: String(m.id), role: m.role, content: m.content }));
      render();
    }
  } catch (e) { console.error(e); }
}

function renderMarkdown(md) {
  // very small markdown: **bold**, *italic*, paragraphs, bullet lists
  const blocks = md.split(/\\n\\n+/);
  return blocks.map(b => {
    const lines = b.split("\\n");
    if (lines.every(l => /^[-*]\\s/.test(l.trim()))) {
      return "<ul>" + lines.map(l => "<li>" + inline(l.replace(/^[-*]\\s/, "")) + "</li>").join("") + "</ul>";
    }
    return "<p>" + lines.map(l => l ? inline(l) + "<br>" : "").join("") + "</p>";
  }).join("");
}

function inline(s) {
  return s.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
          .replace(/\\*([^*]+)\\*/g, "<em>$1</em>");
}

function render() {
  if (messages.length === 0) {
    container.innerHTML = "";
    container.appendChild(empty);
    return;
  }
  container.innerHTML = "";
  for (const m of messages) {
    const row = document.createElement("div");
    row.className = "row " + (m.role === "user" ? "user" : "");
    row.innerHTML = \`
      <div class="avatar \${m.role === "user" ? "user" : "bot"}">\${m.role === "user" ? "👤" : "🌍"}</div>
      <div class="bubble \${m.role === "user" ? "user" : "bot"}">\${renderMarkdown(m.content)}</div>
    \`;
    container.appendChild(row);
  }
  if (pending) {
    const pend = document.createElement("div");
    pend.className = "row";
    pend.id = "pending";
    pend.innerHTML = \`
      <div class="avatar bot">🌍</div>
      <div class="bubble bot"><div class="pending"><span></span><span></span><span></span></div></div>
    \`;
    container.appendChild(pend);
  }
  scroll.scrollTop = scroll.scrollHeight;
}

function showError(msg) {
  errorHost.innerHTML = '<div class="error"><strong>⚠️ ' + msg + '</strong></div>';
}
function clearError() { errorHost.innerHTML = ""; }

async function sendMessage(text) {
  const q = (text || "").trim();
  if (!q || pending) return;
  clearError();
  messages.push({ id: "u_" + Date.now(), role: "user", content: q });
  input.value = "";
  pending = true;
  send.disabled = true;
  render();
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: SID, question: q }),
    });
    const j = await r.json();
    if (j.ok) {
      messages.push(j.message);
    } else {
      showError(j.error.message);
    }
  } catch (e) {
    showError("Couldn't reach TradePass. Check your internet connection and try again.");
  } finally {
    pending = false;
    send.disabled = !input.value.trim();
    render();
  }
}

form.onsubmit = (e) => { e.preventDefault(); sendMessage(input.value); };
input.oninput = () => { send.disabled = !input.value.trim(); };
input.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(input.value);
  }
};
clear.onclick = async () => {
  if (pending) return;
  messages = [];
  clearError();
  await fetch("/api/sessions/" + SID, { method: "DELETE" });
  render();
};
send.disabled = true;
restore();
</script>
</body>
</html>`;

// ===== HTTP server =====
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // CORS for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Static files in /public
  if (url.pathname !== "/" && !url.pathname.startsWith("/api/")) {
    const safe = url.pathname.replace(/\.\./g, "");
    const ext = extname(safe).toLowerCase();
    const types = { ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
    try {
      const content = await readFile(join(__dirname, "public", safe));
      res.writeHead(200, { "Content-Type": types[ext] ?? "application/octet-stream" });
      return res.end(content);
    } catch {
      res.writeHead(404);
      return res.end("Not found");
    }
  }

  // Home page
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(HTML);
  }

  // GET /api/sources
  if (url.pathname === "/api/sources" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ sources: SOURCES }));
  }

  // POST /api/chat
  if (url.pathname === "/api/chat" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: { bucket: "unknown", message: "Invalid JSON", detail: "" } }));
      }
      const { sessionId, question } = parsed ?? {};
      if (!question || !question.trim()) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          ok: false,
          error: {
            bucket: "unknown",
            message: "Please describe what you want to export (product, quantity, from-country, to-country).",
            detail: "empty question",
          },
        }));
      }

      // In-memory history (per sessionId)
      historyStore[sessionId ?? "_anon"] ??= [];
      const history = historyStore[sessionId ?? "_anon"];
      history.push({ role: "user", content: question });

      if (!ai) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          ok: false,
          error: {
            bucket: "auth",
            message: "Your Gemini API key is not configured. Set the `GEMINI_API_KEY` environment variable and restart.",
            detail: "GEMINI_API_KEY missing",
          },
        }));
      }

      try {
        const prompt = buildPrompt(history.slice(0, -1), question);
        const response = await ai.models.generateContent({
          model: "gemini-2.0-flash",
          contents: prompt,
        });
        const text = response.text ?? "";
        history.push({ role: "assistant", content: text });
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          ok: true,
          message: { id: "a_" + Date.now(), role: "assistant", content: text },
        }));
      } catch (e) {
        console.error("[TradePass] Gemini error:", e);
        history.pop(); // remove the user turn since the call failed
        const err = classifyError(e);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: err }));
      }
    });
    return;
  }

  // GET/DELETE /api/sessions/:id
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const sid = sessionMatch[1];
    if (req.method === "GET") {
      const hist = historyStore[sid] ?? [];
      return res.writeHead(200, { "Content-Type": "application/json" })
        && res.end(JSON.stringify({ messages: hist.map((m, i) => ({ id: i, role: m.role, content: m.content })) }));
    }
    if (req.method === "DELETE") {
      delete historyStore[sid];
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found", path: url.pathname }));
});

const historyStore = {}; // sessionId -> [{role, content}]

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌍 TradePass live server running at http://localhost:${PORT}`);
  console.log(`   Gemini API key: ${ai ? "✓ loaded" : "✗ NOT SET (will show auth error)"}`);
  console.log(`   Sources loaded: ${SOURCES.length}`);
});
