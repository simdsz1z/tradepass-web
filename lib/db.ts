/**
 * Database layer — libSQL (serverless-friendly SQLite).
 *
 * Local dev: uses `file:./tradepass.db` (a real SQLite file in the repo root).
 * Vercel deployment: set `TURSO_URL` and `TURSO_TOKEN` env vars; the same code
 * then talks to a hosted Turso instance. Same code path, no app changes.
 */

import { createClient, type Client } from "@libsql/client";

const url = process.env.TURSO_URL ?? "file:./tradepass.db";
const authToken = process.env.TURSO_TOKEN;

let _client: Client | null = null;
let _ready: Promise<void> | null = null;

function getClient(): Client {
  if (_client) return _client;
  _client = createClient({
    url,
    ...(authToken ? { authToken } : {}),
  });
  return _client;
}

async function ensureSchema(): Promise<void> {
  const c = getClient();
  await c.batch(
    [
      `CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        text TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, created_at)`,
    ],
    "write",
  );
}

export async function ready(): Promise<void> {
  if (!_ready) {
    _ready = (async () => {
      await ensureSchema();
      await seedSourcesIfEmpty();
    })();
  }
  return _ready;
}

async function seedSourcesIfEmpty(): Promise<void> {
  const c = getClient();
  const r = await c.execute("SELECT COUNT(*) AS n FROM sources");
  const count = Number(r.rows[0]?.n ?? 0);
  if (count > 0) return;

  // First run — seed with the canonical AfCFTA / Kenya-Uganda corpus.
  // Adding new sources: append here and re-deploy. The seed is idempotent.
  const seeds: Array<[string, string, string]> = [
    [
      "AfCFTA-ROO-1",
      "AfCFTA Rules of Origin Guide (AfCFTA Secretariat)",
      "To qualify for AfCFTA preferential tariffs, a product must meet the applicable Rule of Origin: either wholly obtained in Africa, or sufficiently processed/transformed there (e.g. a minimum percentage of value added, or a change in tariff heading). Processed food products generally need proof that key inputs were sourced or transformed within an AfCFTA member state, plus a valid Certificate of Origin issued by an approved exporter or customs authority in the exporting country.",
    ],
    [
      "AfCFTA-QA-1",
      "AfCFTA Q&A for MSMEs (AfCFTA Secretariat)",
      "A trader must apply for a Certificate of Origin BEFORE export, submitting an invoice, packing list, and evidence of origin (e.g. supplier declarations) to the customs/trade authority. Without this certificate, the shipment will be charged the standard (non-preferential) tariff rate at the border.",
    ],
    [
      "KRA-EAC-1",
      "Kenya Revenue Authority - EAC/COMESA Export Basics",
      "For exports from Kenya to Uganda (both EAC and AfCFTA members), a trader typically needs: a KRA PIN, an export entry declaration via the Customs system, a Certificate of Origin (EAC or AfCFTA), a commercial invoice, a packing list, and for processed foods, a health/phytosanitary certificate from the Kenya Bureau of Standards (KEBS) or the relevant food safety authority.",
    ],
    [
      "UBOS-1",
      "Uganda Revenue Authority - Import Requirements (general)",
      "Goods entering Uganda require a customs import declaration, and processed food imports typically require a certificate of conformity or import permit from the Uganda National Bureau of Standards (UNBS), in addition to standard commercial documents (invoice, packing list, certificate of origin).",
    ],
    [
      "NTB-1",
      "tralac Trade Law Centre - AfCFTA Non-Tariff Barriers",
      "Common barriers traders face at African borders include inconsistent application of rules of origin, unclear or changing documentation requirements, and delays at customs posts. Traders are advised to confirm current requirements directly with customs authorities before shipping, since rules can change and may be applied inconsistently at different border posts.",
    ],
  ];

  for (const [id, title, text] of seeds) {
    await c.execute({
      sql: "INSERT OR IGNORE INTO sources (id, title, text) VALUES (?, ?, ?)",
      args: [id, title, text],
    });
  }
}

// ----- Source access -----

export type Source = { id: string; title: string; text: string };

export async function getAllSources(): Promise<Source[]> {
  await ready();
  const c = getClient();
  const r = await c.execute(
    "SELECT id, title, text FROM sources ORDER BY id ASC",
  );
  return r.rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    text: String(row.text),
  }));
}

// ----- Message persistence -----

export type Role = "user" | "assistant";
export type Message = {
  id: number;
  session_id: string;
  role: Role;
  content: string;
  created_at: number;
};

export async function appendMessage(
  sessionId: string,
  role: Role,
  content: string,
): Promise<void> {
  await ready();
  const c = getClient();
  await c.execute({
    sql: "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
    args: [sessionId, role, content, Date.now()],
  });
}

export async function getSessionMessages(
  sessionId: string,
  limit = 40,
): Promise<Message[]> {
  await ready();
  const c = getClient();
  const r = await c.execute({
    sql: `SELECT id, session_id, role, content, created_at
          FROM messages
          WHERE session_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
    args: [sessionId, limit],
  });
  return r.rows.map((row) => ({
    id: Number(row.id),
    session_id: String(row.session_id),
    role: String(row.role) as Role,
    content: String(row.content),
    created_at: Number(row.created_at),
  }));
}

export async function clearSession(sessionId: string): Promise<void> {
  await ready();
  const c = getClient();
  await c.execute({
    sql: "DELETE FROM messages WHERE session_id = ?",
    args: [sessionId],
  });
}
