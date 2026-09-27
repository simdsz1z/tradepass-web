/**
 * Gemini integration + categorised error handling.
 *
 * Mirrors the behaviour of the original Gradio version:
 *   - System prompt forces structured output + grounding in source snippets
 *   - Session history is injected into the prompt (Fix #5)
 *   - Errors are classified into user-friendly buckets (Fix #6)
 */

import { GoogleGenAI } from "@google/genai";

export const MODEL = "gemini-2.0-flash";

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

export type HistoryTurn = { role: "user" | "assistant"; content: string };

export type GeminiErrorBucket =
  | "auth"
  | "rate_limit"
  | "network"
  | "safety"
  | "unknown";

export type GeminiError = {
  bucket: GeminiErrorBucket;
  message: string;
  detail: string;
};

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
): Promise<{ ok: true; text: string } | { ok: false; error: GeminiError }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "PASTE_YOUR_KEY_HERE") {
    return {
      ok: false,
      error: {
        bucket: "auth",
        message:
          "Your Gemini API key is not configured. Set the `GEMINI_API_KEY` environment variable and redeploy.",
        detail: "GEMINI_API_KEY missing or placeholder.",
      },
    };
  }

  const ai = new GoogleGenAI({ apiKey });
  const prompt = buildPrompt(sources, history, userQuestion);

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
    });
    const text = response.text ?? "";
    if (!text) {
      return {
        ok: false,
        error: {
          bucket: "unknown",
          message:
            "The model returned an empty response. Please try again or rephrase your question.",
          detail: "empty response.text",
        },
      };
    }
    return { ok: true, text };
  } catch (e) {
    console.error("[TradePass] Gemini call failed:", e);
    return {
      ok: false,
      error: classifyError(e),
    };
  }
}

export function classifyError(e: unknown): GeminiError {
  const raw = String(e ?? "").toLowerCase();
  const detail = String(e ?? "");

  if (
    raw.includes("api key") ||
    raw.includes("unauthenticated") ||
    raw.includes("401") ||
    raw.includes("403") ||
    raw.includes("api_key_invalid") ||
    raw.includes("permission_denied")
  ) {
    return {
      bucket: "auth",
      message:
        "Your Gemini API key is missing, invalid, or lacks permission. Update `GEMINI_API_KEY` and try again.",
      detail,
    };
  }
  if (
    raw.includes("rate limit") ||
    raw.includes("429") ||
    raw.includes("quota") ||
    raw.includes("resource_exhausted")
  ) {
    return {
      bucket: "rate_limit",
      message:
        "You've hit the Gemini API quota or rate limit. Please wait a minute and try again, or check your plan in Google AI Studio.",
      detail,
    };
  }
  if (
    raw.includes("connection") ||
    raw.includes("timeout") ||
    raw.includes("network") ||
    raw.includes("unreachable") ||
    raw.includes("dns") ||
    raw.includes("econn")
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
    raw.includes("recitation") ||
    raw.includes("content_filter")
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
