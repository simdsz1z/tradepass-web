"""
Live preview server for TradePass.

Stack: Python stdlib only (+ google-genai for live LLM calls).

Pages:
  /        — landing page (project intro)
  /login   — signup + login (single page, mode toggle)
  /chat    — the chat UI (requires auth)

API:
  POST /api/signup           { email, password }                       → { token, user }
  POST /api/login            { email, password }                       → { token, user }
  GET  /api/me                                                    (auth) → { user }
  POST /api/chat             { question }                        (auth) → { message } | { error }
  GET  /api/conversation                                       (auth) → { messages }
  DELETE /api/conversation                                       (auth) → { ok: true }
  GET  /api/sources                                                    → { sources }

Env:
  GEMINI_API_KEY — required for live model calls; without it, /api/chat
                   returns a friendly "auth" error (UI still works).
  PORT          — defaults to 3000

Run:
  python3.12 live-server.py
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", "3000"))
API_KEY = os.environ.get("GEMINI_API_KEY", "")

# ---------- Source snippets (the "RAG corpus") ----------
SOURCES = [
    {
        "id": "AfCFTA-ROO-1",
        "title": "AfCFTA Rules of Origin Guide (AfCFTA Secretariat)",
        "text": (
            "To qualify for AfCFTA preferential tariffs, a product must meet the applicable Rule of Origin: "
            "either wholly obtained in Africa, or sufficiently processed/transformed there (e.g. a minimum "
            "percentage of value added, or a change in tariff heading). Processed food products generally "
            "need proof that key inputs were sourced or transformed within an AfCFTA member state, plus a "
            "valid Certificate of Origin issued by an approved exporter or customs authority in the exporting country."
        ),
    },
    {
        "id": "AfCFTA-QA-1",
        "title": "AfCFTA Q&A for MSMEs (AfCFTA Secretariat)",
        "text": (
            "A trader must apply for a Certificate of Origin BEFORE export, submitting an invoice, packing list, "
            "and evidence of origin (e.g. supplier declarations) to the customs/trade authority. Without this "
            "certificate, the shipment will be charged the standard (non-preferential) tariff rate at the border."
        ),
    },
    {
        "id": "KRA-EAC-1",
        "title": "Kenya Revenue Authority - EAC/COMESA Export Basics",
        "text": (
            "For exports from Kenya to Uganda (both EAC and AfCFTA members), a trader typically needs: a KRA PIN, "
            "an export entry declaration via the Customs system, a Certificate of Origin (EAC or AfCFTA), "
            "a commercial invoice, a packing list, and for processed foods, a health/phytosanitary certificate "
            "from the Kenya Bureau of Standards (KEBS) or the relevant food safety authority."
        ),
    },
    {
        "id": "UBOS-1",
        "title": "Uganda Revenue Authority - Import Requirements (general)",
        "text": (
            "Goods entering Uganda require a customs import declaration, and processed food imports typically "
            "require a certificate of conformity or import permit from the Uganda National Bureau of Standards (UNBS), "
            "in addition to standard commercial documents (invoice, packing list, certificate of origin)."
        ),
    },
    {
        "id": "NTB-1",
        "title": "tralac Trade Law Centre - AfCFTA Non-Tariff Barriers",
        "text": (
            "Common barriers traders face at African borders include inconsistent application of rules of origin, "
            "unclear or changing documentation requirements, and delays at customs posts. Traders are advised to "
            "confirm current requirements directly with customs authorities before shipping, since rules can change "
            "and may be applied inconsistently at different border posts."
        ),
    },
]

SYSTEM_PROMPT = """You are TradePass, an AI assistant that helps small traders in Africa understand what \
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
"""


# ---------- Auth + user/conversation store (in-memory) ----------
USERS: dict = {}                  # email -> { email, password_hash, salt, created_at }
USER_CONVERSATIONS: dict = {}     # user_email -> [ {role, content, ts} ]
TOKENS: dict = {}                 # token -> user_email
AUTH_LOCK = threading.Lock()
CONV_LOCK = threading.Lock()

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def hash_password(password: str, salt: str) -> str:
    return hashlib.sha256((salt + password).encode("utf-8")).hexdigest()


def create_user(email: str, password: str) -> dict:
    email = email.strip().lower()
    if not EMAIL_RE.match(email):
        raise ValueError("Please enter a valid email address.")
    if len(password) < 6:
        raise ValueError("Password must be at least 6 characters.")
    with AUTH_LOCK:
        if email in USERS:
            raise ValueError("An account with that email already exists. Try signing in.")
        salt = secrets.token_hex(16)
        USERS[email] = {
            "email": email,
            "salt": salt,
            "password_hash": hash_password(password, salt),
            "created_at": int(time.time()),
        }
        token = secrets.token_urlsafe(32)
        TOKENS[token] = email
        with CONV_LOCK:
            USER_CONVERSATIONS.setdefault(email, [])
        return {"token": token, "user": {"email": email}}


def login_user(email: str, password: str) -> dict:
    email = email.strip().lower()
    with AUTH_LOCK:
        rec = USERS.get(email)
        if not rec or hash_password(password, rec["salt"]) != rec["password_hash"]:
            raise ValueError("Email or password is incorrect.")
        token = secrets.token_urlsafe(32)
        TOKENS[token] = email
        return {"token": token, "user": {"email": email}}


def user_from_token(token: str):
    if not token:
        return None
    token = token.strip()
    return USERS.get(TOKENS.get(token))


def get_conversation(email: str) -> list:
    with CONV_LOCK:
        return [dict(m) for m in USER_CONVERSATIONS.get(email, [])]


def append_message(email: str, role: str, content: str):
    with CONV_LOCK:
        USER_CONVERSATIONS.setdefault(email, []).append({
            "role": role, "content": content, "ts": int(time.time() * 1000),
        })


def clear_conversation(email: str):
    with CONV_LOCK:
        USER_CONVERSATIONS[email] = []


# ---------- Gemini + error handling ----------
_gemini = None
_gemini_lock = threading.Lock()


def classify_error(e):
    raw = str(e).lower() if e else ""
    detail = str(e) if e else ""
    if any(k in raw for k in ["api key", "unauthenticated", "401", "403", "api_key_invalid", "permission_denied"]):
        return {"bucket": "auth",
                "message": "Your Gemini API key is missing, invalid, or lacks permission. Update `GEMINI_API_KEY` and try again.",
                "detail": detail}
    if any(k in raw for k in ["rate limit", "429", "quota", "resource_exhausted"]):
        return {"bucket": "rate_limit",
                "message": "You've hit the Gemini API quota or rate limit. Please wait a minute and try again.",
                "detail": detail}
    if any(k in raw for k in ["connection", "timeout", "network", "unreachable", "dns", "econn"]):
        return {"bucket": "network",
                "message": "Couldn't reach the AI service. Check your internet connection and try again.",
                "detail": detail}
    if any(k in raw for k in ["safety", "blocked", "recitation", "content_filter"]):
        return {"bucket": "safety",
                "message": "The AI couldn't safely answer that request. Try rephrasing your question.",
                "detail": detail}
    return {"bucket": "unknown",
            "message": "TradePass couldn't generate a response. Please try again.",
            "detail": detail}


def build_prompt(history, user_question):
    context = "\n\n".join(f"[{s['id']}] {s['title']}:\n{s['text']}" for s in SOURCES)
    sys_prompt = SYSTEM_PROMPT.replace("{context}", context)
    history_block = ""
    if history:
        history_block = "\n\nCONVERSATION SO FAR:\n" + "\n".join(
            f"TRADER (previous): {t['content']}" if t["role"] == "user"
            else f"TRADEPASS (previous): {t['content']}"
            for t in history
        ) + "\n"
    return f"{sys_prompt}{history_block}\n\nTRADER QUESTION:\n{user_question}"


def get_gemini():
    global _gemini
    if _gemini is not None:
        return _gemini
    with _gemini_lock:
        if _gemini is None:
            if not API_KEY or API_KEY == "PASTE_YOUR_KEY_HERE":
                return None
            from google import genai
            _gemini = genai.Client(api_key=API_KEY)
        return _gemini


# ---------- Shared CSS ----------
SHARED_CSS = """
:root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --card: #ffffff; --border: #e7e5e4; --brand: #059669; --brand-dark: #047857; --accent: #f59e0b; --danger: #b91c1c; --shadow: 0 1px 2px rgba(0,0,0,0.06); }
*,*::before,*::after { box-sizing: border-box; }
body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.5; }
a { color: var(--brand-dark); text-decoration: none; font-weight: 500; }
a:hover { text-decoration: underline; }
.container { max-width: 64rem; margin: 0 auto; padding: 0 16px; }
@media (min-width: 640px) { .container { padding: 0 24px; } }
.logo { width:36px; height:36px; border-radius:50%; background: linear-gradient(135deg, var(--accent), var(--brand)); display:flex; align-items:center; justify-content:center; color:white; font-size:18px; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
.btn { display:inline-flex; align-items:center; gap:6px; padding: 10px 18px; border-radius: 12px; border: none; font-weight: 500; font-size: 14px; cursor: pointer; font-family: inherit; }
.btn-primary { background: var(--brand); color: white; box-shadow: var(--shadow); }
.btn-primary:hover { background: var(--brand-dark); text-decoration: none; }
.btn-secondary { background: white; color: var(--fg); border: 1px solid var(--border); }
.btn-secondary:hover { background: var(--bg); text-decoration: none; }
header.site { display:flex; align-items:center; justify-content:space-between; padding: 16px 0; }
header.site .brand { display:flex; align-items:center; gap:12px; }
header.site h1 { font-size: 18px; font-weight: 600; margin:0; }
header.site p.tagline { font-size: 12px; color: var(--muted); margin:0; }
header.site .nav { display:flex; gap: 8px; align-items: center; }
.user-pill { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; background: #f5f5f4; font-size: 13px; color: #57534e; }
.disclaimer-footer { padding: 16px 0; border-top: 1px solid var(--border); background: var(--bg); text-align: center; font-size: 12px; color: var(--muted); margin-top: 60px; }
"""

# ---------- Landing page ----------
LANDING_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>TradePass — AfCFTA export guidance, grounded in official sources</title>
<style>
""" + SHARED_CSS + """
.hero { padding: 56px 0 24px; text-align: center; }
.hero h1 { font-size: 40px; font-weight: 700; margin: 16px 0 12px; letter-spacing: -0.02em; }
.hero p.lead { font-size: 18px; color: var(--muted); max-width: 36rem; margin: 0 auto 24px; }
.hero .ctas { display:flex; gap:12px; justify-content:center; flex-wrap:wrap; }
.section { padding: 48px 0; }
.section h2 { font-size: 24px; font-weight: 600; text-align: center; margin: 0 0 32px; }
.cards { display:grid; gap:16px; grid-template-columns: 1fr; }
@media (min-width: 720px) { .cards { grid-template-columns: 1fr 1fr 1fr; } }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 24px; box-shadow: var(--shadow); }
.card .icon { width:40px; height:40px; border-radius:10px; background: #ecfdf5; color: var(--brand-dark); display:flex; align-items:center; justify-content:center; font-size:20px; margin-bottom:12px; }
.card h3 { font-size: 16px; font-weight: 600; margin: 0 0 6px; }
.card p { font-size: 14px; color: var(--muted); margin: 0; }
.how { background: white; border:1px solid var(--border); border-radius: 16px; padding: 32px; }
.how ol { counter-reset: step; padding: 0; list-style: none; display:grid; gap:16px; }
.how li { counter-increment: step; padding-left: 40px; position: relative; }
.how li::before { content: counter(step); position: absolute; left: 0; top: 0; width: 28px; height: 28px; border-radius: 50%; background: var(--brand); color: white; display:flex; align-items:center; justify-content:center; font-weight: 600; font-size: 14px; }
.how li strong { display: block; margin-bottom: 4px; }
.how li span { color: var(--muted); font-size: 14px; }
.sources-grid { display:grid; gap: 12px; grid-template-columns: 1fr; }
@media (min-width: 720px) { .sources-grid { grid-template-columns: 1fr 1fr; } }
.source-card { background: var(--card); border:1px solid var(--border); border-radius: 12px; padding: 16px; box-shadow: var(--shadow); }
.source-card .id { display: inline-block; font-family: ui-monospace, monospace; font-size: 11px; background: #f5f5f4; color: #44403c; padding: 2px 8px; border-radius: 999px; margin-bottom: 8px; }
.source-card .title { font-size: 14px; font-weight: 600; margin: 0 0 4px; }
.source-card .text { font-size: 13px; color: var(--muted); margin: 0; }
.cta-band { background: linear-gradient(135deg, #f0fdf4, #fffbeb); border:1px solid var(--border); border-radius: 16px; padding: 32px; text-align: center; margin: 32px 0; }
.cta-band h2 { margin: 0 0 8px; font-size: 22px; font-weight: 600; }
.cta-band p { margin: 0 0 20px; color: var(--muted); }
</style>
</head>
<body>
<div class="container">
  <header class="site">
    <div class="brand">
      <div class="logo">🌍</div>
      <div>
        <h1>TradePass</h1>
        <p class="tagline">AfCFTA export guidance, grounded in official sources</p>
      </div>
    </div>
    <nav class="nav">
      <a href="/login" class="btn btn-secondary">Sign in</a>
      <a href="/chat" class="btn btn-primary">Try TradePass →</a>
    </nav>
  </header>

  <section class="hero">
    <div class="logo" style="margin: 0 auto; width:64px; height:64px; font-size:32px;">🌍</div>
    <h1>What do you need to export?<br/>Ask TradePass.</h1>
    <p class="lead">An AI assistant that tells small African traders what documents they need, whether their product qualifies for AfCFTA preferential tariffs, and what to do next — grounded in official sources, not guesses.</p>
    <div class="ctas">
      <a href="/chat" class="btn btn-primary">Start chatting →</a>
      <a href="/login" class="btn btn-secondary">Sign in to save conversations</a>
    </div>
  </section>

  <section class="section">
    <h2>What TradePass does</h2>
    <div class="cards">
      <div class="card">
        <div class="icon">📋</div>
        <h3>Document checklist</h3>
        <p>Get the exact papers you need for your route — invoices, certificates, permits — pulled from official trade authorities.</p>
      </div>
      <div class="card">
        <div class="icon">✅</div>
        <h3>AfCFTA qualification check</h3>
        <p>Will your product get the preferential tariff rate, or get charged the standard one? We'll tell you why, citing the source.</p>
      </div>
      <div class="card">
        <div class="icon">➡️</div>
        <h3>Next-step action</h3>
        <p>One practical thing to do next — which office to contact, which form to fill, which authority to confirm with.</p>
      </div>
    </div>
  </section>

  <section class="section">
    <h2>How it works</h2>
    <div class="how">
      <ol>
        <li><strong>Describe your export</strong><span>Product, quantity, from-country, to-country. The more detail you give, the better the answer.</span></li>
        <li><strong>Get a grounded answer</strong><span>TradePass checks its sources, gives you a structured answer with the documents, the qualification verdict, and the next step.</span></li>
        <li><strong>Save your conversation</strong><span>Sign in to keep your conversation history. Come back tomorrow with a follow-up question — TradePass remembers.</span></li>
      </ol>
    </div>
  </section>

  <section class="section">
    <h2>Grounded in __SRC_COUNT__ official sources</h2>
    <div class="sources-grid">__SOURCES_HTML__</div>
    <p style="text-align: center; color: var(--muted); font-size: 13px; margin-top: 24px;">
      TradePass only answers from these sources. If the answer isn't there, it tells you so — no guessing, no fabricated tariff rates.
    </p>
  </section>

  <section class="cta-band">
    <h2>Ready to try it?</h2>
    <p>Ask one question, no signup needed. Sign in if you want to save your chat history.</p>
    <a href="/chat" class="btn btn-primary">Open TradePass →</a>
  </section>
</div>

<footer class="disclaimer-footer">
  <div class="container">
    Prototype scope: Kenya ↔ Uganda corridor, processed food products · <strong>Not legal or customs advice</strong> · Always confirm with local authorities
  </div>
</footer>
</body>
</html>"""

# Build sources HTML once
SOURCES_HTML = "\n".join(
    f'<div class="source-card"><span class="id">{s["id"]}</span><h3 class="title">{s["title"]}</h3><p class="text">{s["text"][:120]}{"..." if len(s["text"]) > 120 else ""}</p></div>'
    for s in SOURCES
)
LANDING_HTML = LANDING_HTML.replace("__SRC_COUNT__", str(len(SOURCES))).replace("__SOURCES_HTML__", SOURCES_HTML)


# ---------- Login / Signup page ----------
LOGIN_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Sign in — TradePass</title>
<style>
""" + SHARED_CSS + """
main { max-width: 26rem; margin: 60px auto; padding: 0 16px; }
.card { background: white; border:1px solid var(--border); border-radius: 16px; padding: 32px; box-shadow: var(--shadow); }
.tabs { display:flex; gap: 4px; background: #f5f5f4; padding: 4px; border-radius: 10px; margin-bottom: 24px; }
.tabs button { flex:1; padding: 8px 12px; border: none; background: transparent; border-radius: 8px; cursor: pointer; font-weight: 500; font-size: 14px; color: var(--muted); font-family: inherit; }
.tabs button.active { background: white; color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; color: #44403c; }
input { width: 100%; padding: 10px 12px; border: 1px solid #d6d3d1; border-radius: 10px; font-size: 14px; font-family: inherit; box-shadow: 0 1px 2px rgba(0,0,0,0.04); margin-bottom: 16px; }
input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(5,150,105,0.2); }
.form-submit { width: 100%; padding: 12px; margin-top: 8px; }
.error { margin-top: 12px; padding: 10px 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: var(--danger); font-size: 13px; }
.help { text-align: center; margin-top: 16px; font-size: 13px; color: var(--muted); }
.brand-row { display:flex; align-items:center; gap: 12px; margin-bottom: 24px; }
h2 { font-size: 20px; font-weight: 600; margin: 0; }
</style>
</head>
<body>
<div class="container">
  <header class="site">
    <div class="brand">
      <a href="/" style="display:flex; align-items:center; gap:12px; color: inherit;">
        <div class="logo">🌍</div>
        <div>
          <h1>TradePass</h1>
          <p class="tagline">AfCFTA export guidance</p>
        </div>
      </a>
    </div>
    <nav class="nav">
      <a href="/" class="btn btn-secondary">← Back home</a>
    </nav>
  </header>
</div>

<main>
  <div class="card">
    <div class="brand-row">
      <div class="logo">🌍</div>
      <h2 id="title">Sign in to TradePass</h2>
    </div>
    <div class="tabs">
      <button id="tab-signin" class="active" type="button">Sign in</button>
      <button id="tab-signup" type="button">Create account</button>
    </div>

    <form id="form">
      <label for="email">Email</label>
      <input id="email" type="email" required autocomplete="email" placeholder="you@example.com" />

      <label for="password">Password</label>
      <input id="password" type="password" required minlength="6" autocomplete="current-password" placeholder="At least 6 characters" />

      <button type="submit" class="btn btn-primary form-submit" id="submit">Sign in</button>
      <div class="error" id="error" style="display:none"></div>
    </form>

    <p class="help">Signing in saves your chat history so you can come back to your conversations later.</p>
  </div>
</main>

<footer class="disclaimer-footer">
  <div class="container">Not legal or customs advice · Always confirm with local authorities</div>
</footer>

<script>
let mode = "signin"; // or "signup"
const $ = (id) => document.getElementById(id);
const tabSignin = $("tab-signin"), tabSignup = $("tab-signup");
const title = $("title"), submit = $("submit");
const passwordInput = $("password");
const errorEl = $("error");

function setMode(m) {
  mode = m;
  if (m === "signin") {
    tabSignin.classList.add("active"); tabSignup.classList.remove("active");
    title.textContent = "Sign in to TradePass";
    submit.textContent = "Sign in";
    passwordInput.setAttribute("autocomplete", "current-password");
  } else {
    tabSignup.classList.add("active"); tabSignin.classList.remove("active");
    title.textContent = "Create your TradePass account";
    submit.textContent = "Create account";
    passwordInput.setAttribute("autocomplete", "new-password");
  }
  errorEl.style.display = "none";
}
tabSignin.onclick = () => setMode("signin");
tabSignup.onclick = () => setMode("signup");

$("form").onsubmit = async (e) => {
  e.preventDefault();
  errorEl.style.display = "none";
  submit.disabled = true;
  try {
    const email = $("email").value.trim();
    const password = $("password").value;
    const url = mode === "signin" ? "/api/login" : "/api/signup";
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json();
    if (!r.ok || !j.token) {
      errorEl.textContent = j.error || j.message || "Something went wrong.";
      errorEl.style.display = "block";
      return;
    }
    localStorage.setItem("tradepass.token", j.token);
    localStorage.setItem("tradepass.user", JSON.stringify(j.user));
    window.location.href = "/chat";
  } catch (err) {
    errorEl.textContent = "Couldn't reach the server. Please try again.";
    errorEl.style.display = "block";
  } finally {
    submit.disabled = false;
  }
};

// If already signed in, jump straight to chat
if (localStorage.getItem("tradepass.token")) {
  window.location.href = "/chat";
}
</script>
</body>
</html>"""


# ---------- Chat page ----------
CHAT_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>TradePass — Chat</title>
<style>
""" + SHARED_CSS + """
.app { max-width: 64rem; margin: 0 auto; height: 100vh; display: flex; flex-direction: column; background: white; box-shadow: 0 0 0 1px var(--border); }
@media (min-width: 640px) { .app { border-left: 1px solid var(--border); border-right: 1px solid var(--border); } }
.chat-header { display:flex; align-items:center; justify-content:space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); background: rgba(255,255,255,0.7); backdrop-filter: blur(8px); }
@media (min-width: 640px) { .chat-header { padding: 12px 24px; } }
.chat-header .brand { display:flex; align-items:center; gap:12px; }
.chat-header h1 { font-size: 16px; font-weight: 600; margin:0; }
.chat-header .tagline { font-size: 12px; color: var(--muted); margin:0; }
.chat-header .actions { display:flex; align-items:center; gap:8px; }
.chat-header .badge { display: none; padding: 4px 10px; border-radius: 999px; background: #f5f5f4; font-size: 12px; color: #57534e; }
@media (min-width: 640px) { .chat-header .badge { display:inline-block; } }
.chat-header .icon-btn { border: 1px solid var(--border); background: white; padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 500; color: #44403c; cursor: pointer; font-family: inherit; }
.chat-header .icon-btn:hover { background: #fafaf9; }
.scroll { flex:1; overflow-y: auto; padding: 24px 16px; }
@media (min-width: 640px) { .scroll { padding: 24px 24px; } }
.container-msg { max-width: 48rem; margin: 0 auto; display:flex; flex-direction: column; gap: 16px; }
.empty { display:flex; flex-direction: column; align-items: center; padding-top: 40px; text-align: center; }
.empty-emoji { font-size: 48px; margin-bottom: 12px; }
.empty h2 { font-size: 18px; font-weight: 600; color: #292524; margin: 0; }
.empty p { margin-top: 4px; max-width: 28rem; font-size: 14px; color: var(--muted); }
.chips { display: grid; gap: 8px; margin-top: 24px; }
@media (min-width: 640px) { .chips { grid-template-columns: 1fr 1fr; } }
.chip { border: 1px solid var(--border); background: white; padding: 10px 12px; border-radius: 12px; font-size: 14px; color: #44403c; text-align: left; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,0.04); font-family: inherit; }
.chip:hover { border-color: #6ee7b7; background: #ecfdf5; }
.row { display:flex; align-items:flex-start; gap: 12px; }
.row.user { flex-direction: row-reverse; }
.avatar { width: 32px; height: 32px; flex-shrink: 0; border-radius: 50%; display:flex; align-items: center; justify-content: center; color: white; font-size: 14px; }
.avatar.user { background: #44403c; }
.avatar.bot { background: var(--brand); }
.bubble { max-width: 85%; padding: 12px 16px; border-radius: 16px; font-size: 14px; line-height: 1.5; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
@media (min-width: 640px) { .bubble { max-width: 75%; } }
.bubble.user { background: #292524; color: #fafaf9; border: 1px solid #292524; }
.bubble.bot { background: white; color: #292524; border: 1px solid var(--border); }
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
form.composer { display:flex; gap: 8px; align-items:flex-end; padding: 12px 16px; border-top: 1px solid var(--border); background: white; }
@media (min-width: 640px) { form.composer { padding: 12px 24px; } }
form.composer > div { max-width: 48rem; margin: 0 auto; display:flex; gap: 8px; width: 100%; align-items: flex-end; }
textarea { flex:1; min-height: 44px; max-height: 200px; resize: none; padding: 10px 12px; border: 1px solid #d6d3d1; border-radius: 12px; font-family: inherit; font-size: 14px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px rgba(5,150,105,0.2); }
button.send { height: 44px; padding: 0 16px; background: var(--brand); color: white; border: none; border-radius: 12px; font-weight: 500; font-size: 14px; cursor: pointer; display:flex; align-items:center; gap: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); font-family: inherit; }
button.send:disabled { background: #d6d3d1; cursor: not-allowed; }
button.send:hover:not(:disabled) { background: var(--brand-dark); }
footer.disclaimer { padding: 10px 16px; border-top: 1px solid var(--border); background: var(--bg); text-align: center; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<div class="app">
  <header class="chat-header">
    <div class="brand">
      <div class="logo">🌍</div>
      <div>
        <h1>TradePass</h1>
        <p class="tagline">AfCFTA export guidance · grounded in official sources</p>
      </div>
    </div>
    <div class="actions">
      <span class="badge" id="badge">__SRC_COUNT__ sources</span>
      <span class="user-pill" id="user-pill">…</span>
      <button class="icon-btn" id="clear" type="button">🗑️ Clear</button>
      <a href="/" class="icon-btn" style="text-decoration:none;">Home</a>
    </div>
  </header>

  <div class="scroll" id="scroll">
    <div class="container-msg" id="container">
      <div class="empty" id="empty">
        <div class="empty-emoji">🌍</div>
        <h2>What do you want to export?</h2>
        <p>Tell me the product, quantity, and your route — I'll give you a document checklist, an AfCFTA qualification check, and a next step.</p>
        <div class="chips" id="chips"></div>
      </div>
    </div>
  </div>

  <div id="error-host"></div>

  <form class="composer" id="form">
    <div>
      <textarea id="input" rows="1" placeholder="e.g. I want to export 200kg of processed avocado oil from Kenya to Uganda"></textarea>
      <button type="submit" class="send" id="send" disabled>Send <span>→</span></button>
    </div>
  </form>

  <footer class="disclaimer">Prototype scope: Kenya ↔ Uganda corridor, processed food products · <strong>Not legal or customs advice</strong> · Always confirm with local authorities</footer>
</div>

<script>
const TOKEN_KEY = "tradepass.token";
const USER_KEY = "tradepass.user";

const token = localStorage.getItem(TOKEN_KEY);
const userStr = localStorage.getItem(USER_KEY);
if (!token || !userStr) {
  window.location.href = "/login";
}
const user = JSON.parse(userStr || '{"email":""}');
document.getElementById("user-pill").textContent = "👤 " + (user.email || "you");

const EXAMPLES = [
  "I want to export 200kg of processed avocado oil from Kenya to Uganda",
  "What documents do I need to ship dried mangoes from Kenya to Rwanda?",
  "Does Tanzanian coffee qualify for AfCFTA preferential tariffs when exported to South Africa?",
  "I'm an MSME in Nairobi — how do I apply for a Certificate of Origin?",
];

const container = document.getElementById("container");
const empty = document.getElementById("empty");
const scroll = document.getElementById("scroll");
const chips = document.getElementById("chips");
const form = document.getElementById("form");
const input = document.getElementById("input");
const send = document.getElementById("send");
const clear = document.getElementById("clear");
const errorHost = document.getElementById("error-host");

let messages = [];
let pending = false;

for (const ex of EXAMPLES) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip";
  b.textContent = ex;
  b.onclick = () => { if (!pending) sendMessage(ex); };
  chips.appendChild(b);
}

async function authedFetch(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}), "Authorization": "Bearer " + token, "Content-Type": "application/json" };
  const r = await fetch(path, opts);
  if (r.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    window.location.href = "/login";
    throw new Error("not authed");
  }
  return r;
}

async function restore() {
  try {
    const r = await authedFetch("/api/conversation");
    if (r.ok) {
      const j = await r.json();
      messages = (j.messages || []).map(m => ({ id: String(m.ts ?? Math.random()), role: m.role, content: m.content }));
      render();
    }
  } catch (e) { console.error(e); }
}

function inlineMd(s) {
  return s.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
          .replace(/\\*([^*]+)\\*/g, "<em>$1</em>");
}
function renderMarkdown(md) {
  const blocks = md.split(/\\n\\n+/);
  return blocks.map(b => {
    const lines = b.split("\\n");
    if (lines.every(l => /^[-*]\\s/.test(l.trim()))) {
      return "<ul>" + lines.map(l => "<li>" + inlineMd(l.replace(/^[-*]\\s/, "")) + "</li>").join("") + "</ul>";
    }
    return "<p>" + lines.map(l => l ? inlineMd(l) + "<br>" : "").join("") + "</p>";
  }).join("");
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
    row.innerHTML = `
      <div class="avatar ${m.role === "user" ? "user" : "bot"}">${m.role === "user" ? "👤" : "🌍"}</div>
      <div class="bubble ${m.role === "user" ? "user" : "bot"}">${renderMarkdown(m.content)}</div>
    `;
    container.appendChild(row);
  }
  if (pending) {
    const pend = document.createElement("div");
    pend.className = "row";
    pend.innerHTML = `
      <div class="avatar bot">🌍</div>
      <div class="bubble bot"><div class="pending"><span></span><span></span><span></span></div></div>
    `;
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
    const r = await authedFetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({ question: q }),
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
  await authedFetch("/api/conversation", { method: "DELETE" });
  render();
};
restore();
</script>
</body>
</html>""".replace("__SRC_COUNT__", str(len(SOURCES)))


# ---------- HTTP handler ----------
def auth_user(req):
    h = req.headers.get("Authorization", "")
    if not h.startswith("Bearer "):
        return None
    return user_from_token(h[len("Bearer "):])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[{self.log_date_time_string()}] {fmt % args}\n")

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html):
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/" or path == "/home":
            return self._send_html(LANDING_HTML)
        if path == "/login" or path == "/signup":
            return self._send_html(LOGIN_HTML)
        if path == "/chat":
            return self._send_html(CHAT_HTML)

        if path == "/api/sources":
            return self._send_json(200, {"sources": SOURCES})

        if path == "/api/me":
            u = auth_user(self)
            if not u:
                return self._send_json(401, {"error": "unauthorized"})
            return self._send_json(200, {"user": {"email": u["email"]}})

        if path == "/api/conversation":
            u = auth_user(self)
            if not u:
                return self._send_json(401, {"error": "unauthorized"})
            return self._send_json(200, {"messages": get_conversation(u["email"])})

        return self._send_json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path

        if path == "/api/signup":
            return self._handle_auth(create_user)

        if path == "/api/login":
            return self._handle_auth(login_user)

        if path == "/api/chat":
            u = auth_user(self)
            if not u:
                return self._send_json(401, {"error": "unauthorized"})
            return self._handle_chat(u["email"])

        return self._send_json(404, {"error": "not found"})

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path == "/api/conversation":
            u = auth_user(self)
            if not u:
                return self._send_json(401, {"error": "unauthorized"})
            clear_conversation(u["email"])
            return self._send_json(200, {"ok": True})
        return self._send_json(404, {"error": "not found"})

    # ----- helpers -----
    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        body_raw = self.rfile.read(length).decode("utf-8") if length else ""
        try:
            return json.loads(body_raw) if body_raw else {}
        except json.JSONDecodeError:
            return None

    def _handle_auth(self, fn):
        data = self._read_json()
        if data is None:
            return self._send_json(400, {"error": "Invalid JSON"})
        try:
            return self._send_json(200, fn(data.get("email", ""), data.get("password", "")))
        except ValueError as e:
            return self._send_json(400, {"error": str(e)})

    def _handle_chat(self, email):
        data = self._read_json()
        if data is None:
            return self._send_json(400, {"ok": False, "error": {"bucket": "unknown", "message": "Invalid JSON", "detail": ""}})
        question = (data.get("question") or "").strip()
        if not question:
            return self._send_json(200, {"ok": False, "error": {
                "bucket": "unknown",
                "message": "Please describe what you want to export (product, quantity, from-country, to-country).",
                "detail": "empty question",
            }})

        client = get_gemini()
        if client is None:
            return self._send_json(200, {"ok": False, "error": {
                "bucket": "auth",
                "message": "Your Gemini API key is not configured on the server. Set GEMINI_API_KEY and restart.",
                "detail": "GEMINI_API_KEY missing",
            }})

        history = get_conversation(email)
        append_message(email, "user", question)

        try:
            prompt = build_prompt(history, question)
            resp = client.models.generate_content(
                model="gemini-2.0-flash",
                contents=prompt,
            )
            text = (resp.text or "").strip()
            if not text:
                raise RuntimeError("empty model response")
            append_message(email, "assistant", text)
            return self._send_json(200, {
                "ok": True,
                "message": {"id": "a_" + str(int(time.time() * 1000)), "role": "assistant", "content": text},
            })
        except Exception as e:
            # Roll back the user turn since the call failed
            conv = get_conversation(email)
            if conv and conv[-1]["role"] == "user" and conv[-1]["content"] == question:
                conv.pop()
                with CONV_LOCK:
                    USER_CONVERSATIONS[email] = conv
            err = classify_error(e)
            sys.stderr.write(f"[TradePass] Gemini error: {e}\n")
            return self._send_json(200, {"ok": False, "error": err})


def main():
    has_key = bool(API_KEY) and API_KEY != "PASTE_YOUR_KEY_HERE"
    print(f"TradePass live server (Python)")
    print(f"   URL:    http://localhost:{PORT}")
    print(f"   Gemini: {'OK loaded' if has_key else 'NOT SET (chat will return auth error, UI still works)'}")
    print(f"   Sources: {len(SOURCES)}")
    print(f"   Press Ctrl+C to stop.")
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
