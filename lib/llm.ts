/**
 * LLM integration — MiniMax (native endpoint).
 *
 * IMPORTANT: This uses MiniMax's NATIVE API at /v1/text/chatcompletion_v2,
 * not the OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Why native? The OpenAI-compatible endpoint has a known bug where
 * subscription / Token Plan keys fail with 1004 "not authorized" (see
 * litellm/litellm#24483). The native endpoint accepts all key types.
 *
 * Native request:
 *   POST {baseUrl}/v1/text/chatcompletion_v2
 *   Authorization: Bearer {apiKey}
 *   { "model": "MiniMax-M3", "messages": [...], "temperature": ..., ... }
 *
 * Native response also wraps everything in a "base_resp" envelope, so we
 * extract `.choices[0].message.content` (the OpenAI-style body) and
 * fall back to checking `.reply` or `.text` depending on what's there.
 */

export type GenerateOpts = {
  apiKey?: string;
  baseUrl?: string;
  // Allow forcing OpenAI-compat mode for testing (not recommended)
  useOpenAICompat?: boolean;
};

function pickApiKey(opts: GenerateOpts): string | null {
  const k =
    opts.apiKey?.trim() ||
    process.env.MINIMAX_API_KEY ||
    process.env.OPENAI_API_KEY;
  if (!k || k === "PASTE_YOUR_KEY_HERE") return null;
  return k;
}

function pickBaseUrl(opts: GenerateOpts): string {
  return (
    opts.baseUrl?.trim() ||
    process.env.MINIMAX_BASE_URL ||
    "https://api.minimaxi.com"
  );
}

const MODEL_DEFAULT = "MiniMax-M3";

export const MODEL =
  process.env.MINIMAX_MODEL ?? MODEL_DEFAULT;

export type HistoryTurn = { role: "user" | "assistant"; content: string };

export type LLMErrorBucket =
  | "auth"
  | "rate_limit"
  | "network"
  | "safety"
  | "unknown";

export type LLMError = {
  bucket: LLMErrorBucket;
  message: string;
  detail: string;
};

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

/** Build the full prompt (system + history + new question). */
export function buildPrompt(
  sources: Array<{ id: string; title: string; text: string }>,
  history: HistoryTurn[],
  userQuestion: string,
): string {
  const context = sources
    .map((s) => `[${s.id}] ${s.title}:\n${s.text}`)
    .join("\n\n");
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

async function callNative(opts: {
  apiKey: string;
  baseUrl: string;
  prompt: string;
}): Promise<string> {
  // MiniMax native endpoint: POST {baseUrl}/v1/text/chatcompletion_v2
  const url = `${opts.baseUrl.replace(/\/$/, "")}/v1/text/chatcompletion_v2`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          name: "TradePass",
          content:
            "You are TradePass, an AI assistant that helps small traders in Africa understand what documents they need and whether their product likely qualifies for AfCFTA preferential tariffs. Answer in English.",
        },
        { role: "user", name: "Trader", content: opts.prompt },
      ],
      temperature: 0.3,
      top_p: 0.9,
      max_completion_tokens: 1024,
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${raw}`);
  }
  const j = raw ? JSON.parse(raw) : {};
  // MiniMax native response: { choices: [{ message: { content } }], base_resp: { status_code, status_msg } }
  if (j.base_resp && j.base_resp.status_code && j.base_resp.status_code !== 0) {
    throw new Error(
      `MiniMax error ${j.base_resp.status_code}: ${j.base_resp.status_msg || "unknown"}`,
    );
  }
  const text =
    j?.choices?.[0]?.message?.content ??
    j?.reply ??
    j?.text ??
    "";
  return String(text).trim();
}

async function callOpenAICompat(opts: {
  apiKey: string;
  baseUrl: string;
  prompt: string;
}): Promise<string> {
  // Fallback: OpenAI SDK against the OpenAI-compatible endpoint.
  // Doesn't work for subscription keys on MiniMax, but kept for users
  // with PAYG keys or other OpenAI-compatible providers.
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: `${opts.baseUrl.replace(/\/$/, "")}/v1`,
  });
  const res = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: opts.prompt }],
    temperature: 0.3,
    max_tokens: 1024,
  });
  return (res.choices?.[0]?.message?.content ?? "").trim();
}

/** Run the model. Returns the text or a categorised error. */
export async function generateAnswer(
  sources: Array<{ id: string; title: string; text: string }>,
  history: HistoryTurn[],
  userQuestion: string,
  opts: GenerateOpts = {},
): Promise<{ ok: true; text: string } | { ok: false; error: LLMError }> {
  const apiKey = pickApiKey(opts);
  if (!apiKey) {
    return {
      ok: false,
      error: {
        bucket: "auth",
        message:
          "Your MiniMax API key is not configured. Set the `MINIMAX_API_KEY` environment variable OR paste a key via the ⚙️ Settings panel in the chat.",
        detail: "no API key resolved",
      },
    };
  }

  const baseUrl = pickBaseUrl(opts);
  const prompt = buildPrompt(sources, history, userQuestion);

  try {
    const text = opts.useOpenAICompat
      ? await callOpenAICompat({ apiKey, baseUrl, prompt })
      : await callNative({ apiKey, baseUrl, prompt });
    if (!text) {
      return {
        ok: false,
        error: {
          bucket: "unknown",
          message:
            "The model returned an empty response. Please try again or rephrase your question.",
          detail: "empty response.content",
        },
      };
    }
    return { ok: true, text };
  } catch (e) {
    console.error("[TradePass] MiniMax call failed:", e);
    return {
      ok: false,
      error: classifyError(e),
    };
  }
}

export function classifyError(e: unknown): LLMError {
  const raw = String(e ?? "").toLowerCase();
  const detail = String(e ?? "");

  if (
    raw.includes("api key") ||
    raw.includes("unauthorized") ||
    raw.includes("401") ||
    raw.includes("403") ||
    raw.includes("invalid_api_key") ||
    raw.includes("permission_denied") ||
    raw.includes("authentication") ||
    raw.includes("1004") ||
    raw.includes("not authorized")
  ) {
    return {
      bucket: "auth",
      message:
        "Your MiniMax API key is missing, invalid, or not authorized for this endpoint. Open the ⚙️ Settings panel to paste a fresh key, then click 🧪 Test to see MiniMax's exact error.",
      detail,
    };
  }
  if (
    raw.includes("rate limit") ||
    raw.includes("429") ||
    raw.includes("quota") ||
    raw.includes("resource_exhausted") ||
    raw.includes("too many requests")
  ) {
    return {
      bucket: "rate_limit",
      message:
        "You've hit the MiniMax API quota or rate limit. Please wait a minute and try again.",
      detail,
    };
  }
  if (
    raw.includes("connection") ||
    raw.includes("timeout") ||
    raw.includes("network") ||
    raw.includes("unreachable") ||
    raw.includes("dns") ||
    raw.includes("econn") ||
    raw.includes("enotfound") ||
    raw.includes("fetch failed")
  ) {
    return {
      bucket: "network",
      message:
        "Couldn't reach the AI service. Check your internet connection and try again.",
      detail,
    };
  }
  if (
    raw.includes("safety") ||
    raw.includes("blocked") ||
    raw.includes("content_filter") ||
    raw.includes("policy")
  ) {
    return {
      bucket: "safety",
      message:
        "The AI couldn't safely answer that request. Try rephrasing your question.",
      detail,
    };
  }
  return {
    bucket: "unknown",
    message:
      "TradePass couldn't generate a response. Please try again. If the problem persists, contact the app administrator.",
    detail,
  };
}
