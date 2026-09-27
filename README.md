# TradePass — Web

Next.js 16 + React 19 + Tailwind 4 + libSQL/SQLite + Google Gemini.

## Quick start

```bash
npm install
cp .env.example .env.local          # then add your GEMINI_API_KEY
npm run dev                          # http://localhost:3000
```

On first run, a local SQLite file `./tradepass.db` is created and seeded
with the 5 canonical source snippets.

## Deploy to Vercel

```bash
npm i -g vercel
vercel                                # follow prompts
```

Set these in **Vercel Project → Settings → Environment Variables**:

| Variable | Required | Notes |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | from <https://aistudio.google.com/apikey> |
| `TURSO_URL` | optional | `libsql://…turso.io` — only if you want a hosted DB |
| `TURSO_TOKEN` | optional | Turso auth token (paired with `TURSO_URL`) |

Without `TURSO_*` env vars, the app uses a local SQLite file. Note: on
Vercel serverless, the local file is ephemeral per instance — for
production, set `TURSO_URL` + `TURSO_TOKEN` (free tier is fine).

## Architecture

```
app/
  layout.tsx                 # root layout + metadata
  page.tsx                   # mounts <Chat>
  globals.css                # Tailwind v4 entrypoint
  api/
    chat/route.ts            # POST: chat with Gemini (DB-backed memory)
    sources/route.ts         # GET: list source snippets
    sessions/[id]/route.ts   # GET (history) / DELETE (clear)
components/
  Chat.tsx                   # client-side chat experience
  MessageBubble.tsx          # single message (mini markdown)
  ExampleChips.tsx           # quick-start prompts
  Disclaimer.tsx             # footer
lib/
  db.ts                      # libSQL client + schema + seed
  gemini.ts                  # Gemini call + error categorisation
  types.ts                   # shared TS types
```

## API

### `POST /api/chat`
```json
// request
{ "sessionId": "uuid", "question": "..." }

// 200 OK — success
{ "ok": true, "message": { "id": "...", "role": "assistant", "content": "..." } }

// 200 OK — friendly error
{
  "ok": false,
  "error": {
    "bucket": "auth" | "rate_limit" | "network" | "safety" | "unknown",
    "message": "...",
    "detail": "..."
  }
}
```

### `GET /api/sources` → `{ sources: [{id, title, text}] }`

### `GET /api/sessions/:id` → `{ messages: [...] }`

### `DELETE /api/sessions/:id` → `{ ok: true }`

## End-to-end tests

`tests/e2e.mjs` (Node script using fetch) — see report in commit history.
