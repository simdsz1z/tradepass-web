"use client";

/**
 * Chat — main client-side chat experience.
 *
 * State:
 *   - messages: full transcript (user + assistant)
 *   - pending:  whether we're waiting for a reply (for spinner + disabled input)
 *   - error:    last error to display
 *   - sessionId: persistent UUID stored in localStorage
 *
 * The user can also paste their own MiniMax API key via the settings panel
 * (gear icon in the header). When set, that key is sent with each request
 * and used server-side instead of the env var.
 *
 * On mount:
 *   - Generate sessionId (or restore from localStorage)
 *   - Fetch prior messages from /api/sessions/:id
 *
 * On submit:
 *   - Append the user's message optimistically
 *   - POST /api/chat (with apiKey + baseUrl if set)
 *   - Append assistant reply (or show error)
 *
 * On clear:
 *   - DELETE /api/sessions/:id
 *   - Reset local state
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ChatResponse } from "@/lib/types";
import MessageBubble from "./MessageBubble";
import ExampleChips from "./ExampleChips";
import Disclaimer from "./Disclaimer";
import SettingsPanel from "./SettingsPanel";

const EXAMPLES: string[] = [
  "I want to export 200kg of processed avocado oil from Kenya to Uganda",
  "What documents do I need to ship dried mangoes from Kenya to Rwanda?",
  "Does Tanzanian coffee qualify for AfCFTA preferential tariffs when exported to South Africa?",
  "I'm an MSME in Nairobi — how do I apply for a Certificate of Origin?",
];

function newSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `s_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function getStoredSessionId(): string {
  if (typeof window === "undefined") return "";
  const key = "tradepass.sessionId";
  let id = window.localStorage.getItem(key);
  if (!id) {
    id = newSessionId();
    window.localStorage.setItem(key, id);
  }
  return id;
}

export default function Chat() {
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceCount, setSourceCount] = useState<number | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // ---- initial load ----
  useEffect(() => {
    const id = getStoredSessionId();
    setSessionId(id);

    (async () => {
      try {
        const r = await fetch(`/api/sessions/${id}`);
        if (r.ok) {
          const j = await r.json();
          const restored: ChatMessage[] = (j.messages ?? []).map(
            (m: { id: number; role: "user" | "assistant"; content: string }) => ({
              id: String(m.id),
              role: m.role,
              content: m.content,
            }),
          );
          setMessages(restored);
        }
        const sr = await fetch("/api/sources");
        if (sr.ok) {
          const sj = await sr.json();
          setSourceCount((sj.sources ?? []).length);
        }
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  // ---- auto-scroll ----
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const send = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || pending || !sessionId) return;
      setError(null);

      const tempId = `u_${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: tempId, role: "user", content: q },
      ]);
      setInput("");
      setPending(true);

      try {
        const userKey = typeof window !== "undefined" ? localStorage.getItem("tradepass.minimaxKey") ?? undefined : undefined;
        const userBase = typeof window !== "undefined" ? localStorage.getItem("tradepass.minimaxBaseUrl") ?? undefined : undefined;
        const r = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            question: q,
            ...(userKey ? { apiKey: userKey } : {}),
            ...(userBase ? { baseUrl: userBase } : {}),
          }),
        });
        const j: ChatResponse = await r.json();
        if (j.ok) {
          setMessages((prev) => [...prev, j.message]);
        } else {
          setError(j.error.message);
        }
      } catch (e) {
        setError(
          "Couldn't reach TradePass. Check your internet connection and try again.",
        );
        console.error(e);
      } finally {
        setPending(false);
      }
    },
    [pending, sessionId],
  );

  const clear = useCallback(async () => {
    if (!sessionId) return;
    setError(null);
    setMessages([]);
    try {
      await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
    } catch (e) {
      console.error(e);
    }
  }, [sessionId]);

  const empty = useMemo(() => messages.length === 0, [messages]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="relative flex items-center justify-between border-b border-stone-200 bg-white/70 px-4 py-3 backdrop-blur sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-amber-500 to-emerald-600 text-lg text-white shadow-sm">
            🌍
          </div>
          <div>
            <h1 className="text-base font-semibold text-stone-900 sm:text-lg">
              TradePass
            </h1>
            <p className="text-xs text-stone-500">
              AfCFTA export guidance · grounded in official sources
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {sourceCount !== null && (
            <span
              className="hidden rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-600 sm:inline"
              data-testid="source-count"
            >
              {sourceCount} sources
            </span>
          )}
          <SettingsPanel onSaved={() => setMessages((m) => [...m])} />
          <button
            type="button"
            onClick={clear}
            disabled={pending}
            className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="clear-btn"
            aria-label="Clear conversation"
          >
            🗑️ Clear
          </button>
        </div>
      </header>

      {/* Messages */}
      <div
        ref={scrollerRef}
        className="flex-1 overflow-y-auto px-4 py-6 sm:px-6"
        data-testid="chat-scroll"
      >
        <div className="mx-auto max-w-3xl space-y-4">
          {empty ? (
            <div className="flex flex-col items-center pt-10 text-center">
              <div className="mb-3 text-5xl">🌍</div>
              <h2 className="text-lg font-semibold text-stone-800">
                What do you want to export?
              </h2>
              <p className="mt-1 max-w-md text-sm text-stone-500">
                Tell me the product, quantity, and your route — I&apos;ll give
                you a document checklist, an AfCFTA qualification check, and a
                next step.
              </p>
              <div className="mt-6 w-full">
                <ExampleChips
                  examples={EXAMPLES}
                  onPick={(t) => send(t)}
                  disabled={pending}
                />
              </div>
            </div>
          ) : (
            <>
              {messages.map((m) => (
                <MessageBubble key={m.id} role={m.role} content={m.content} />
              ))}
              {pending && (
                <div className="flex items-start gap-3" data-testid="pending">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
                    🌍
                  </div>
                  <div className="rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-stone-200">
                    <div className="flex items-center gap-1.5">
                      <span className="h-2 w-2 animate-bounce rounded-full bg-stone-400 [animation-delay:-0.3s]" />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-stone-400 [animation-delay:-0.15s]" />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-stone-400" />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div
          className="mx-4 mb-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:mx-6"
          role="alert"
          data-testid="error-banner"
        >
          <span className="font-medium">⚠️ {error}</span>
        </div>
      )}

      {/* Composer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="border-t border-stone-200 bg-white px-4 py-3 sm:px-6"
        data-testid="composer"
      >
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="e.g. I want to export 200kg of processed avocado oil from Kenya to Uganda"
            rows={1}
            disabled={pending}
            className="min-h-[44px] flex-1 resize-none rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200 disabled:bg-stone-50"
            data-testid="composer-input"
          />
          <button
            type="submit"
            disabled={pending || !input.trim()}
            className="flex h-[44px] items-center gap-1 rounded-xl bg-emerald-600 px-4 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-stone-300"
            data-testid="composer-send"
          >
            {pending ? "…" : "Send"}
            <span aria-hidden>→</span>
          </button>
        </div>
      </form>

      <Disclaimer />
    </div>
  );
}
