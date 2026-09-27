/** Shared types between server and client. */

export type Role = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: Role;
  content: string;
};

export type ChatRequest = {
  sessionId: string;
  question: string;
};

export type ChatResponse =
  | { ok: true; message: ChatMessage }
  | {
      ok: false;
      error: {
        bucket: "auth" | "rate_limit" | "network" | "safety" | "unknown";
        message: string;
        detail: string;
      };
    };

export type SourcesResponse = {
  sources: Array<{ id: string; title: string; text: string }>;
};
