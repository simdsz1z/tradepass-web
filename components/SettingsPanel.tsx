"use client";

import { useEffect, useState } from "react";

const KEY_STORAGE = "tradepass.minimaxKey";
const BASE_URL_STORAGE = "tradepass.minimaxBaseUrl";

type Props = {
  onSaved?: () => void;
};

export default function SettingsPanel({ onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.minimaxi.com/v1");
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setApiKey(localStorage.getItem(KEY_STORAGE) ?? "");
    setBaseUrl(localStorage.getItem(BASE_URL_STORAGE) ?? "https://api.minimaxi.com/v1");
  }, [open]);

  function save() {
    if (typeof window === "undefined") return;
    localStorage.setItem(KEY_STORAGE, apiKey.trim());
    localStorage.setItem(BASE_URL_STORAGE, baseUrl.trim() || "https://api.minimaxi.com/v1");
    setSavedAt(Date.now());
    onSaved?.();
  }

  function clear() {
    if (typeof window === "undefined") return;
    localStorage.removeItem(KEY_STORAGE);
    localStorage.removeItem(BASE_URL_STORAGE);
    setApiKey("");
    setBaseUrl("https://api.minimaxi.com/v1");
    setSavedAt(Date.now());
    onSaved?.();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="icon-btn"
        style={{ background: "white", border: "1px solid var(--border)", padding: "6px 10px", borderRadius: 999, fontSize: 12, fontWeight: 500, color: "#44403c", cursor: "pointer" }}
        aria-label="Open settings"
        title="Settings"
        data-testid="settings-btn"
      >
        ⚙️
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Settings"
      style={{
        position: "absolute",
        top: 56,
        right: 16,
        width: 360,
        background: "white",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 16,
        boxShadow: "0 10px 25px rgba(0,0,0,0.08)",
        zIndex: 50,
      }}
      data-testid="settings-panel"
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <strong style={{ fontSize: 14 }}>⚙️ Settings</strong>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 18, lineHeight: 1, color: "#78716c" }}
          aria-label="Close settings"
        >
          ✕
        </button>
      </div>

      <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, color: "#44403c" }}>
        MiniMax API key
        <span style={{ fontWeight: 400, color: "#78716c", marginLeft: 6 }}>(stored in this browser only)</span>
      </label>
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="eyJ... or sk-..."
        autoComplete="off"
        spellCheck={false}
        style={{
          width: "100%",
          padding: "8px 10px",
          border: "1px solid #d6d3d1",
          borderRadius: 8,
          fontSize: 13,
          fontFamily: "ui-monospace, monospace",
          marginBottom: 12,
        }}
        data-testid="settings-key"
      />

      <label style={{ display: "block", fontSize: 12, fontWeight: 500, marginBottom: 4, color: "#44403c" }}>
        API base URL
      </label>
      <select
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        style={{
          width: "100%",
          padding: "8px 10px",
          border: "1px solid #d6d3d1",
          borderRadius: 8,
          fontSize: 13,
          fontFamily: "ui-monospace, monospace",
          marginBottom: 12,
        }}
        data-testid="settings-base-url"
      >
        <option value="https://api.minimaxi.com/v1">api.minimaxi.com (international)</option>
        <option value="https://api.minimax.cn/v1">api.minimax.cn (mainland China)</option>
        <option value="custom">custom…</option>
      </select>
      {baseUrl === "custom" && (
        <input
          type="text"
          placeholder="https://your-custom-endpoint/v1"
          onChange={(e) => setBaseUrl(e.target.value)}
          style={{
            width: "100%",
            padding: "8px 10px",
            border: "1px solid #d6d3d1",
            borderRadius: 8,
            fontSize: 13,
            fontFamily: "ui-monospace, monospace",
            marginBottom: 12,
            marginTop: -8,
          }}
        />
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={save}
          style={{ flex: 1, padding: "8px 12px", background: "#059669", color: "white", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer" }}
          data-testid="settings-save"
        >
          Save
        </button>
        <button
          type="button"
          onClick={clear}
          style={{ padding: "8px 12px", background: "white", color: "#44403c", border: "1px solid var(--border)", borderRadius: 8, fontSize: 13, cursor: "pointer" }}
          data-testid="settings-clear"
        >
          Clear
        </button>
      </div>

      {savedAt && (
        <p style={{ marginTop: 10, marginBottom: 0, fontSize: 11, color: "#78716c" }}>
          Saved {new Date(savedAt).toLocaleTimeString()}
        </p>
      )}
      <p style={{ marginTop: 8, marginBottom: 0, fontSize: 11, color: "#a8a29e", lineHeight: 1.4 }}>
        Your key is only stored in this browser&apos;s localStorage and sent with each chat request. TradePass server uses it directly to call MiniMax — it&apos;s never logged.
      </p>
    </div>
  );
}
