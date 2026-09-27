/**
 * POST /api/chat
 *
 * Body: { sessionId: string, question: string }
 *
 * Steps:
 *   1. Load all source snippets from DB
 *   2. Load prior messages for the session (memory)
 *   3. Persist the user's new question
 *   4. Call Gemini with system prompt + history + question
 *   5. Persist the assistant's reply
 *   6. Return the reply (or a categorised error)
 */

import { NextResponse } from "next/server";
import { appendMessage, getAllSources, getSessionMessages } from "@/lib/db";
import { generateAnswer } from "@/lib/llm";
import type { ChatRequest, ChatResponse } from "@/lib/types";

export const runtime = "nodejs"; // libsql native binding
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse<ChatResponse>> {
  let body: ChatRequest & { apiKey?: string; baseUrl?: string };
  try {
    body = (await req.json()) as ChatRequest & { apiKey?: string; baseUrl?: string };
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          bucket: "unknown",
          message: "Invalid request body.",
          detail: "JSON parse failed",
        },
      },
      { status: 400 },
    );
  }

  const sessionId = (body.sessionId ?? "").trim();
  const question = (body.question ?? "").trim();

  if (!sessionId) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          bucket: "unknown",
          message: "Missing sessionId.",
          detail: "sessionId is required",
        },
      },
      { status: 400 },
    );
  }
  if (!question) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          bucket: "unknown",
          message:
            "Please describe what you want to export (product, quantity, from-country, to-country).",
          detail: "empty question",
        },
      },
      { status: 400 },
    );
  }

  try {
    const sources = await getAllSources();
    const history = await getSessionMessages(sessionId);
    const historyTurns = history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    await appendMessage(sessionId, "user", question);

    const result = await generateAnswer(sources, historyTurns, question, {
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
    });

    if (!result.ok) {
      // Don't persist a failed assistant reply — keep the DB clean.
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 200 }, // client-friendly error format; HTTP stays 200
      );
    }

    await appendMessage(sessionId, "assistant", result.text);

    return NextResponse.json({
      ok: true,
      message: {
        id: `a_${Date.now()}`,
        role: "assistant",
        content: result.text,
      },
    });
  } catch (e) {
    console.error("[TradePass] /api/chat crashed:", e);
    return NextResponse.json(
      {
        ok: false,
        error: {
          bucket: "unknown",
          message:
            "TradePass hit an unexpected server error. Please try again.",
          detail: String(e),
        },
      },
      { status: 500 },
    );
  }
}
