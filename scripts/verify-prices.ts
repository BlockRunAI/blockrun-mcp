// scripts/verify-prices.ts — run with: npm run verify:prices
//
// Compares every local cost estimator against what the LIVE gateway quotes.
//
// WHY: the estimators feed the budget gate. If one under-quotes, the gate
// reserves less than the call settles for and an agent walks past its cap; the
// ledger then under-counts the overrun too. Nothing else catches this, because
// the gateway can reprice at any time without an MCP release — the drift is
// silent, and by construction it appears in production, not in CI.
//
// This has already gone wrong three times in the same direction:
//   1. stale Surf tiers after the gateway went flat,
//   2. the 402 body's `price` (the BASE) mistaken for what x402 charges,
//   3. round() instead of the gateway's ceil(), one micro short wherever a
//      x1.05 margin drifts in float.
//
// Probing is FREE: send a request with no payment header and the gateway
// answers 402 with the quote in the `payment-required` header. No USDC moves.
// Nothing here spends money — do not add a call that attaches a payment.
//
// The header is x402Version 2, so the field is `amount` (micro-USDC). v1's
// `maxAmountRequired` is absent; read that key and you get `null`, which reads
// as "free" rather than raising. Hence the explicit check below.
import { estimateModalCost } from "../src/tools/modal.js";
import { estimatePhoneCost } from "../src/tools/phone.js";
import { estimateSurfCost, SURF_PRICE_USD } from "../src/tools/surf.js";
import { estimateSearchCost } from "../src/tools/search.js";
import { estimateCost as estimateImageCost } from "../src/tools/image.js";
import { estimateExaCost } from "../src/tools/exa.js";
import { estimateChatCost, promptCharSize } from "../src/tools/chat.js";
import { MARKETS_PRICE_USD } from "../src/tools/markets.js";
import { withTxFee } from "../src/utils/tx-fee.js";

const BASE = "https://blockrun.ai/api/v1/";

type Probe = {
  label: string;
  path: string;
  body?: unknown; // present => POST
  expected: number; // what our estimator reserves
  // Some estimators reserve a deliberate worst-case (blockrun_chat cannot know
  // which model a tier will settle on until after the call). For those, over-
  // reserving is the design, not drift — but under-reserving is still a bug.
  allowOver?: boolean;
};

async function quote(path: string, body?: unknown): Promise<number | string> {
  const res = await fetch(BASE + path, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const header = res.headers.get("payment-required");
  if (!header) return `no 402 (HTTP ${res.status})`;
  let parsed: { accepts?: Array<{ amount?: string }> };
  try {
    parsed = JSON.parse(Buffer.from(header.trim(), "base64").toString("utf8"));
  } catch {
    return "undecodable payment-required header";
  }
  const raw = parsed.accepts?.[0]?.amount;
  if (raw === undefined) return "no `amount` in accepts[0] (x402 version changed?)";
  const micro = Number(raw);
  if (!Number.isFinite(micro)) return `unparseable amount: ${String(raw)}`;
  return micro / 1e6;
}

const PROBES: Probe[] = [
  // Flat-rate routes.
  { label: "surf/market/price", path: "surf/market/price?symbol=BTC", expected: estimateSurfCost("market/price") },
  { label: "surf/wallet/detail", path: "surf/wallet/detail?address=0x0000000000000000000000000000000000000000", expected: estimateSurfCost("wallet/detail") },
  // The former T3: on-chain SQL used to cost more. It must stay flat.
  { label: "surf/onchain/sql", path: "surf/onchain/sql", body: { sql: "SELECT 1" }, expected: SURF_PRICE_USD },
  { label: "pm/polymarket/markets", path: "pm/polymarket/markets", expected: MARKETS_PRICE_USD },
  { label: "pm/kalshi/markets", path: "pm/kalshi/markets", expected: MARKETS_PRICE_USD },
  { label: "pm/markets/search", path: "pm/markets/search?q=election", expected: MARKETS_PRICE_USD },

  // Body-priced: modal bills off gpu + timeout, NOT the path. A 24h H100 is
  // $192 upfront and non-refundable — the case that made this script exist.
  { label: "modal create {} (flat)", path: "modal/sandbox/create", body: {}, expected: estimateModalCost("sandbox/create", {}) },
  { label: "modal create T4 300s", path: "modal/sandbox/create", body: { timeout: 300, gpu: "T4" }, expected: estimateModalCost("sandbox/create", { timeout: 300, gpu: "T4" }) },
  { label: "modal create CPU 1h", path: "modal/sandbox/create", body: { timeout: 3600 }, expected: estimateModalCost("sandbox/create", { timeout: 3600 }) },
  { label: "modal create H100 1h", path: "modal/sandbox/create", body: { timeout: 3600, gpu: "H100" }, expected: estimateModalCost("sandbox/create", { timeout: 3600, gpu: "H100" }) },
  { label: "modal create H100 24h", path: "modal/sandbox/create", body: { timeout: 86400, gpu: "H100" }, expected: estimateModalCost("sandbox/create", { timeout: 86400, gpu: "H100" }) },
  { label: "modal exec", path: "modal/sandbox/exec", body: { sandbox_id: "x", command: ["echo"] }, expected: estimateModalCost("sandbox/exec", {}) },

  // Count-priced: search bills per RESULT, and the fee applies once.
  { label: "search max_results=10", path: "search", body: { query: "t", sources: ["web"], max_results: 10 }, expected: estimateSearchCost({ query: "t", sources: ["web"], max_results: 10 }) },
  { label: "search max_results=20", path: "search", body: { query: "t", sources: ["web"], max_results: 20 }, expected: estimateSearchCost({ query: "t", sources: ["web"], max_results: 20 }) },

  { label: "phone/lookup", path: "phone/lookup?phone_number=%2B15555550100", expected: estimatePhoneCost("phone/lookup", true) },
  { label: "phone/lookup/fraud", path: "phone/lookup/fraud?phone_number=%2B15555550100", expected: estimatePhoneCost("phone/lookup/fraud", true) },
  { label: "phone/numbers/list", path: "phone/numbers/list", expected: estimatePhoneCost("phone/numbers/list", false) },

  // Routes with no exported estimator: pin the documented figure instead, so a
  // gateway reprice still trips this gate rather than only the skill docs.
  { label: "exa/search", path: "exa/search?query=t", expected: withTxFee(0.01) },
  { label: "defillama/protocols", path: "defillama/protocols", expected: withTxFee(0.005) },
  { label: "rpc/ethereum (single)", path: "rpc/ethereum", body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }, expected: withTxFee(0.002) },

  // ---- PARAMETERIZED routes ----
  // The flat routes above were always covered exactly (20/20), and every one of
  // the pricing defects found in the 0.32.3 audit was on a route whose price
  // depends on an ARGUMENT. That was the structural gap behind five separate
  // bugs, so the size/count/length axes are pinned here too.

  // Image: the tier boundary is per-model. A single >1024 rule billed a 2048
  // nano-banana-pro render at the 4096 price (49% over) and wrote it to the
  // ledger verbatim.
  ...(["1024x1024", "2048x2048", "4096x4096"].map((size) => ({
    label: `image nano-pro ${size}`,
    path: "images/generations",
    body: { model: "google/nano-banana-pro", prompt: "a cube", size },
    expected: estimateImageCost("google/nano-banana-pro", size),
  }))),
  { label: "image gpt-image-2 1024", path: "images/generations", body: { model: "openai/gpt-image-2", prompt: "a cube", size: "1024x1024" }, expected: estimateImageCost("openai/gpt-image-2", "1024x1024") },
  // nano-banana-2 is 1024-only upstream (the gateway 400s any other size), so a
  // single probe covers its whole price surface.
  { label: "image nano-banana-2 1024", path: "images/generations", body: { model: "google/nano-banana-2", prompt: "a cube", size: "1024x1024" }, expected: estimateImageCost("google/nano-banana-2", "1024x1024") },

  // Exa: priced PER URL. The gateway ignores the query string when routing, so
  // `contents?x=1` must price identically to `contents`.
  { label: "exa/contents x1", path: "exa/contents", body: { urls: ["https://example.com"] }, expected: estimateExaCost("contents", { urls: ["https://example.com"] }) },
  { label: "exa/contents x25", path: "exa/contents", body: { urls: Array.from({ length: 25 }, (_, i) => `https://example.com/${i}`) }, expected: estimateExaCost("contents", { urls: Array.from({ length: 25 }, (_, i) => `https://example.com/${i}`) }) },

  // Chat: priced on INPUT tokens too. Reserving off max_tokens alone left a
  // 100k-word prompt 11.4x short. Over-reserving is intended here (the tier's
  // settling model is unknown up front); under-reserving is not.
  ...([1_000, 100_000].map((chars) => {
    const message = "word ".repeat(Math.round(chars / 5));
    return {
      label: `chat balanced ${chars / 1000}k chars`,
      path: "chat/completions",
      body: { model: "openai/gpt-5.6-terra", messages: [{ role: "user", content: message }], max_tokens: 1024 },
      expected: estimateChatCost(1024, "balanced", undefined, undefined, promptCharSize(message)),
      allowOver: true,
    };
  })),
];

const EPSILON = 1e-9;
let short = 0;
let over = 0;
let unreachable = 0;

console.log(`Verifying ${PROBES.length} routes against live 402 quotes (free — no payment attached)\n`);

for (const probe of PROBES) {
  const live = await quote(probe.path, probe.body);
  if (typeof live === "string") {
    console.log(`  ?  ${probe.label.padEnd(26)} ${live}`);
    unreachable++;
    continue;
  }
  const delta = probe.expected - live;
  if (delta < -EPSILON) {
    // The only genuinely dangerous direction: we reserve less than we pay.
    console.log(`  ✗  ${probe.label.padEnd(26)} reserve $${probe.expected} < charge $${live}  UNDER-RESERVES by $${(-delta).toFixed(6)}`);
    short++;
  } else if (probe.allowOver && delta >= -EPSILON) {
    console.log(`  ✓  ${probe.label.padEnd(26)} $${live}  (reserve $${probe.expected.toFixed(6)}, intentionally conservative)`);
  } else if (delta > 0.001) {
    console.log(`  !  ${probe.label.padEnd(26)} reserve $${probe.expected} > charge $${live}  over-reserves by $${delta.toFixed(6)}`);
    over++;
  } else {
    console.log(`  ✓  ${probe.label.padEnd(26)} $${live}`);
  }
}

console.log(
  `\n${short} under-reserving, ${over} over-reserving, ${unreachable} unreachable, ` +
    `${PROBES.length - short - over - unreachable} exact`,
);
if (unreachable) console.log("Unreachable routes were NOT verified — treat them as unknown, not as passing.");
// Under-reserving is a release blocker: it means the budget cap is a lie.
// Over-reserving only blocks affordable calls, so it warns without failing.
if (short) {
  console.log("\nFAIL: an estimator reserves less than the gateway charges. Fix it before publishing.");
  process.exit(1);
}
