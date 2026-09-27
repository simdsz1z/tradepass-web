/**
 * LLM integration — MiniMax (OpenAI-compatible).
 *
 * MiniMax exposes an OpenAI-compatible Chat Completions API at
 *   https://api.minimaxi.com/v1   (international)
 *   https://api.minimax.cn/v1     (mainland China)
 *
 * Default model: MiniMax-M3 (1M context, multimodal, agent-friendly).
 * Swap to MiniMax-M2.7 / M2.5 / M2 via MINIMAX_MODEL env var.
 *
 * This replaces the earlier `@google/genai` Gemini integration.
 */

import OpenAI from "openai";

const MODEL_DEFAULT = "MiniMax-M3";

function getClient(): OpenAI | null {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey || apiKey === "PASTE_YOUR_KEY_HERE") return null;
  const baseURL =
    process.env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com/v1";
  return new OpenAI({ apiKey, baseURL });
}

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

/** Run the model. Returns the text or a categorised error. */
export async function generateAnswer(
  sources: Array<{ id: string; title: string; text: string }>,
  history: HistoryTurn[],
  userQuestion: string,
): Promise<{ ok: true; text: string } | { ok: false; error: LLMError }> {
  const client = getClient();
  if (!client) {
    return {
      ok: false,
      error: {
        bucket: "auth",
        message:
          "Your MiniMax API key is not configured. Set the `MINIMAX_API_KEY` environment variable and redeploy.",
        detail: "MINIMAX_API_KEY missing or placeholder.",
      },
    };
  }

  const prompt = buildPrompt(sources, history, userQuestion);

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 1024,
    });
    const text = response.choices?.[0]?.message?.content ?? "";
    if (!text) {
      return {
        ok: false,
        error: {
          bucket: "unknown",
          message:
            "The model returned an empty response. Please try again or rephrase your question.",
          detail: "empty response.choices[0].message.content",
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
    raw.includes("authentication")
  ) {
    return {
      bucket: "auth",
      message:
        "Your MiniMax API key is missing, invalid, or lacks permission. Update `MINIMAX_API_KEY` and try again.",
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
