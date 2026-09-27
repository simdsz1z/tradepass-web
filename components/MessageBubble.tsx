"use client";

/** A single message bubble. User right-aligned, assistant left-aligned. */
import { useMemo } from "react";
import type { Role } from "@/lib/types";

type Props = { role: Role; content: string };

/** Very small markdown renderer — handles paragraphs, bold, bullets, and italics. */
function renderInline(text: string): React.ReactNode[] {
  // Split on **...** and *...*
  const tokens: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      tokens.push(
        <strong key={i++} className="font-semibold">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else {
      tokens.push(
        <em key={i++} className="italic text-stone-600">
          {tok.slice(1, -1)}
        </em>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) tokens.push(text.slice(last));
  return tokens;
}

function renderMarkdown(md: string): React.ReactNode {
  const blocks = md.split(/\n\n+/);
  return blocks.map((block, bi) => {
    const lines = block.split("\n");
    if (lines.every((l) => /^[-*]\s/.test(l.trim()))) {
      return (
        <ul key={bi} className="my-2 list-disc space-y-1 pl-5">
          {lines.map((l, li) => (
            <li key={li}>{renderInline(l.replace(/^[-*]\s/, ""))}</li>
          ))}
        </ul>
      );
    }
    return (
      <p key={bi} className="my-2 leading-relaxed">
        {lines.map((l, li) => (
          <span key={li}>
            {li > 0 && <br />}
            {renderInline(l)}
          </span>
        ))}
      </p>
    );
  });
}

export default function MessageBubble({ role, content }: Props) {
  const isUser = role === "user";
  const rendered = useMemo(() => renderMarkdown(content), [content]);

  return (
    <div
      className={`flex items-start gap-3 ${isUser ? "flex-row-reverse" : ""}`}
      data-testid={`message-${role}`}
    >
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white ${
          isUser ? "bg-stone-700" : "bg-emerald-600"
        }`}
        aria-hidden
      >
        {isUser ? "👤" : "🌍"}
      </div>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm ring-1 sm:max-w-[75%] ${
          isUser
            ? "bg-stone-800 text-stone-50 ring-stone-800"
            : "bg-white text-stone-800 ring-stone-200"
        }`}
      >
        {rendered}
      </div>
    </div>
  );
}
