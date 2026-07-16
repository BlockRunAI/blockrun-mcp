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
import { MARKETS_PRICE_USD } from "../src/tools/markets.js";
import { withTxFee } from "../src/utils/tx-fee.js";

const BASE = "https://blockrun.ai/api/v1/";

type Probe = {
  label: string;
  path: string;
  body?: unknown; // present => POST
  expected: number; // what our estimator reserves
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
