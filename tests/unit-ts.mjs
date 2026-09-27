/**
 * Pure-logic tests using Node 24's experimental TypeScript stripping.
 * No Next.js runtime, no libsql (those are tested separately in Python).
 *
 * Run with: node --experimental-strip-types tests/unit-ts.mjs
 */

import { buildPrompt, classifyError } from "../lib/gemini.ts";

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, status: cond ? "PASS" : "FAIL", detail });
}

// ===== classifyError =====
check("U1 auth (API key) -> auth",
  classifyError(new Error("API key not valid")).bucket === "auth");

check("U2 auth (401) -> auth",
  classifyError(new Error("401 unauthorized")).bucket === "auth");

check("U3 auth (api_key_invalid) -> auth",
  classifyError(new Error("reason=api_key_INVALID")).bucket === "auth");

check("U4 rate-limit (429 + resource_exhausted) -> rate_limit",
  classifyError(new Error("429 resource_exhausted quota exceeded")).bucket === "rate_limit");

check("U5 network (ECONNREFUSED) -> network",
  classifyError(new Error("connect ECONNREFUSED 127.0.0.1:443")).bucket === "network");

check("U6 network (timeout) -> network",
  classifyError(new Error("Request timeout after 30s")).bucket === "network");

check("U7 safety (blocked) -> safety",
  classifyError(new Error("Response blocked due to safety filters")).bucket === "safety");

check("U8 unknown -> unknown",
  classifyError(new Error("totally novel failure")).bucket === "unknown");

check("U9 null -> unknown (no crash)",
  classifyError(null).bucket === "unknown");

check("U10 detail preserved",
  classifyError(new Error("API_KEY_INVALID boom")).detail.includes("API_KEY_INVALID"));

check("U11 message is non-empty for auth",
  classifyError(new Error("API key invalid")).message.length > 0);

check("U12 message is non-empty for unknown",
  classifyError(new Error("xyz")).message.length > 0);

// ===== buildPrompt =====
const sampleSources = [
  { id: "AfCFTA-ROO-1", title: "Rules of Origin", text: "first source body" },
  { id: "UBOS-1", title: "Uganda Bureau", text: "second source body" },
];

const pEmpty = buildPrompt(sampleSources, [], "What docs for avocado oil?");
check("U20 prompt with no history: includes all source ids",
  pEmpty.includes("[AfCFTA-ROO-1]") && pEmpty.includes("[UBOS-1]"));
check("U21 prompt with no history: no CONVERSATION block",
  !pEmpty.includes("CONVERSATION SO FAR"));
check("U22 prompt with no history: includes user question",
  pEmpty.includes("What docs for avocado oil?"));
check("U23 prompt with no history: leaves no {context} placeholder",
  !pEmpty.includes("{context}"));

const pOne = buildPrompt(sampleSources, [{ role: "user", content: "first Q" }], "second Q");
check("U30 prompt with 1 history turn: contains TRADER (previous)",
  pOne.includes("TRADER (previous): first Q"));
check("U31 prompt with 1 history turn: contains new question",
  pOne.includes("second Q"));
check("U32 prompt with 1 history turn: contains CONVERSATION SO FAR",
  pOne.includes("CONVERSATION SO FAR"));

const pMulti = buildPrompt(
  sampleSources,
  [
    { role: "user", content: "turn-a" },
    { role: "assistant", content: "turn-b" },
    { role: "user", content: "turn-c" },
  ],
  "turn-d",
);
check("U40 multi-turn order: a < b < c",
  pMulti.indexOf("TRADER (previous): turn-a") <
    pMulti.indexOf("TRADEPASS (previous): turn-b") &&
    pMulti.indexOf("TRADEPASS (previous): turn-b") <
      pMulti.indexOf("TRADER (previous): turn-c"));
check("U41 multi-turn: new question appears after history",
  pMulti.indexOf("turn-c") < pMulti.indexOf("TRADER QUESTION:\nturn-d"));

// ===== print =====
const tag = (s) => s === "PASS" ? "[PASS]" : "[FAIL]";
console.log("\n======================================================================");
console.log("  TRADEPASS WEB - TYPESCRIPT UNIT TEST REPORT");
console.log("======================================================================");
for (const r of results) {
  console.log(`  ${tag(r.status)} ${r.name}`);
  if (r.status === "FAIL" && r.detail) console.log(`      -> ${r.detail}`);
}
const passed = results.filter((r) => r.status === "PASS").length;
const failed = results.filter((r) => r.status === "FAIL").length;
console.log("======================================================================");
console.log(`  RESULT: ${passed} passed / ${failed} failed / ${results.length} total`);
console.log("======================================================================");
process.exit(failed === 0 ? 0 : 1);
