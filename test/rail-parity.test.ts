// Run with: npm test  (tsx --test)
//
// THE RAIL-PARITY MATRIX.
//
// Round 1 of the 0.49.0 audit was fixed by six agents working in parallel, one
// per area, and round 2's regressions had a single fingerprint: each agent
// hardened the rail it was looking at and left its siblings alone. The quote
// guard landed on video and image but not music and speech; the in-flight
// booking on Base and the account rail but not Solana, the default chain;
// music's Solana call passed no onQuote at all, so the guard hook fired against
// nobody. Every one of those was a real money path, and every one passed CI.
//
// So this is not another audit. It is the table the round-2 completeness critic
// asked for: every paid tool, every rail it serves, every treatment a paid call
// needs. A cell is a claim about the source, and adding a rail-specific guard
// without filling in its siblings turns this file red.
//
// It is deliberately a STATIC check. Driving all 13 tools across 3 rails
// through their handlers would need a mock harness per tool, and the failure it
// is guarding against is structural — "this file never mentions the thing" —
// which reading the source proves directly and cheaply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tools");
const src = (f: string) => readFileSync(join(TOOLS, f), "utf8");

/** A paid tool that performs its OWN 402 (reads the quote, signs the payment). */
const MANUAL_402 = ["video.ts", "music.ts", "speech.ts", "image.ts", "realface.ts"] as const;

/** Paid tools that hand the whole 402 to the SDK or the account helper. */
const DELEGATED_402 = ["markets.ts", "exa.ts", "defi.ts", "rpc.ts", "search.ts", "phone.ts", "modal.ts"] as const;

test("every manual-402 tool checks the quote before it signs", () => {
  // The gateway can quote a different product than the one asked for — proven
  // on 2026-09-08, when sol.blockrun.ai answered azure/sora-2 with "Seedance
  // 2.0 Pro video generation (5s)" at 2.7x the published rate. A tool that
  // signs whatever arrives cannot notice.
  for (const f of MANUAL_402) {
    const s = src(f);
    assert.match(s, /assertQuoteNearEstimate|assertVideoQuoteSane/, `${f}: no quote-sanity check before signing`);
  }
});

test("every manual-402 tool re-reserves against the cap at the REAL price", () => {
  // The estimate is what the gate approved and what the human was shown; the
  // 402 is what will actually be taken. A quote above the estimate has to be
  // re-checked against the cap before anything is signed.
  for (const f of MANUAL_402) {
    const s = src(f);
    assert.match(
      s,
      /reserveBudget\(budget, agent_id, (quotedUsd|solQuotedUsd|settledUsd|billedUsd)|reReserveIfHigher\(/,
      `${f}: never re-reserves at the quoted price`,
    );
  }
});

test("every rail a manual-402 tool serves gets its quote checked, not just the first one", () => {
  // music's Solana call passed only pollBudgetMs, so the helper's onQuote hook
  // — which exists for exactly this — fired against nothing while the SPL
  // transfer was signed for whatever the quote said.
  for (const f of MANUAL_402) {
    const s = src(f);
    if (!/solanaPaid(Post|AsyncPost)\(/.test(s)) continue;
    assert.match(s, /onQuote:/, `${f}: calls the Solana helper without an onQuote guard`);
  }
});

test("every tool that can give up while a paid request is outstanding books the charge", () => {
  // The gateway settles on its own clock and does not stop because the client
  // disconnected. A give-up that books nothing tells the caller a real charge
  // was free, and the obvious next step pays for it twice.
  for (const f of MANUAL_402) {
    const s = src(f);
    assert.match(
      s,
      /paidPollInFlight|paidRequestInFlight|BilledJobError/,
      `${f}: no in-flight tracking, so an abort after settlement books nothing`,
    );
  }
});

test("a tool that gives up on Solana never claims 'No payment was taken'", () => {
  // Base can promise it (settlement happens only on a poll the gateway answers
  // "completed"); Solana and the account rail cannot. The promise used to be
  // gated on `getChain() !== "solana"` in a way that fell through to silence
  // rather than to an honest sentence.
  for (const f of ["video.ts", "music.ts"] as const) {
    const s = src(f);
    assert.match(s, /getChain\(\) === "solana"[\s\S]{0,600}MAY have gone through/, `${f}: the Solana give-up must say the charge may stand`);
  }
});

test("every delegated-402 tool books the observed charge, not its reserve", () => {
  // The reserve rounds against us on purpose ($0.002 fee where the gateway
  // charges $0.001 on Base and nothing on Solana). Booking it inflates recorded
  // spend on every call and trips caps early — up to 2x on the default chain.
  for (const f of DELEGATED_402) {
    const s = src(f);
    assert.match(s, /ledgerFallback\(/, `${f}: books its reserve as settled spend`);
  }
});

test("no delegated-402 tool pretends to check a quote it cannot see", () => {
  // The SDK owns their 402 and does not surface the amount, so a guard there
  // would be theatre. This asserts the DIVISION is deliberate: if one of these
  // ever grows a quote check, it has moved rails and this table must say so.
  for (const f of DELEGATED_402) {
    const s = src(f);
    assert.doesNotMatch(s, /assertQuoteNearEstimate|assertVideoQuoteSane/, `${f}: grew a quote guard — update the matrix`);
  }
});

test("the matrix covers every paid tool in the directory", () => {
  // The point of a table is that nothing is missing from it. A new paid tool
  // must be classified, not silently skipped.
  const classified = new Set<string>([...MANUAL_402, ...DELEGATED_402]);
  const unclassified: string[] = [];
  for (const f of readdirSync(TOOLS).filter((n) => n.endsWith(".ts"))) {
    if (classified.has(f)) continue;
    const s = src(f);
    // Free tools and the wallet/chat tools are out of scope by construction:
    // chat settles per token through the SDK and has its own settled-cost
    // wrapper; wallet, models, dex and polymarket_read take no payment here.
    if (!/reserveBudget\(budget/.test(s)) continue;
    if (["chat.ts", "chat-anthropic.ts", "polymarket.ts", "price.ts", "wallet.ts"].includes(f)) continue;
    unclassified.push(f);
  }
  assert.deepEqual(unclassified, [], `paid tools missing from the rail-parity matrix: ${unclassified.join(", ")}`);
});
