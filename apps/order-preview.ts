// apps/order-preview.ts — the Polymarket order card.
//
// Rendered by the host for every blockrun_polymarket_read result. For the
// `preview` action it shows the live quote and lets the user re-quote a
// different amount or place the order. Placing goes through the host as a
// tools/call on blockrun_polymarket with confirm:true — the host's consent
// prompt and the server's caps (POLYMARKET_MAX_BET_USD, session cap) are
// unchanged; this card only replaces the model typing the call.
import { $, autoSize, bootApp, el, resultText, setBusy, structured, usd, type ToolResult } from "./shared";
import { declinedByUser, outcomeIsUnknown } from "./order-safety.js";

interface Preview {
  dryRun: true;
  action: "buy" | "sell";
  tokenId: string;
  price?: number;
  size?: number;
  amountUsd?: number;
  estimatedSize?: number;
  orderType: string;
  notionalUsd: number;
  tickSize: string;
  negRisk: boolean;
  question?: string;
  outcome?: string;
  conditionId?: string;
  bestQuote?: number | null;
  /** Market orders: the limit the order will be signed at (buy: max, sell: min price per share). */
  worstFillPrice?: number;
  minSize?: number;
  maxBetUsd?: number;
  sessionSpentUsd?: number;
  sessionCapUsd?: number | null;
  expiresAt?: number;
  postOnly?: boolean;
}

interface Placed {
  orderID?: string;
  status?: string;
  success?: boolean;
  transactionsHashes?: string[];
  notionalUsd?: number;
  session?: { totalUsd: number; count: number };
}

const app = await bootApp("BlockRun Polymarket order");
autoSize(app);

const questionEl = $("question");
const subtitleEl = $("subtitle");
const body = $("body");

/** The arguments the model passed to blockrun_polymarket_read (we re-use them to re-quote). */
let toolArgs: Record<string, unknown> = {};
app.ontoolinput = (p) => { toolArgs = { ...(p.arguments ?? {}) }; };
app.ontoolresult = (r) => render(r as ToolResult);

function render(r: ToolResult): void {
  const s = structured<Record<string, unknown>>(r);
  if (r.isError) return renderFallback(resultText(r), true);
  if (s && s.dryRun === true) return renderPreview(s as unknown as Preview);
  if (s && Array.isArray(s.positions)) return renderTable("Positions", s.positions as Array<Record<string, unknown>>);
  if (s && Array.isArray(s.orders)) return renderTable("Open orders", s.orders as Array<Record<string, unknown>>);
  renderFallback(resultText(r), false);
}

function renderFallback(text: string, isError: boolean): void {
  questionEl.textContent = isError ? "Polymarket" : "Polymarket";
  subtitleEl.textContent = isError ? "Error" : "";
  body.replaceChildren(el("pre", { class: "fallback" }, text || "(empty result)"));
  if (isError) body.firstElementChild?.classList.add("err");
}

function renderTable(title: string, rows: Array<Record<string, unknown>>): void {
  questionEl.textContent = title;
  subtitleEl.textContent = rows.length ? `${rows.length} item${rows.length === 1 ? "" : "s"}` : "None";
  if (!rows.length) { body.replaceChildren(el("div", { class: "note" }, `No ${title.toLowerCase()}.`)); return; }
  const cols = Object.keys(rows[0]).filter((k) => typeof rows[0][k] !== "object").slice(0, 6);
  const table = el("table");
  table.append(el("thead", {}, el("tr", {}, ...cols.map((c) => el("th", {}, c)))));
  const tb = el("tbody");
  for (const row of rows) {
    tb.append(el("tr", {}, ...cols.map((c) => {
      const v = row[c];
      const isNum = typeof v === "number";
      return el("td", { class: isNum ? "num" : "" }, isNum ? String(Number(v.toFixed(4))) : String(v ?? ""));
    })));
  }
  table.append(tb);
  body.replaceChildren(table);
}

function kv(k: string, v: string | Node, big = false): HTMLElement {
  return el("div", { class: "kv" }, el("span", { class: "k" }, k), el("span", { class: `v${big ? " big" : ""}` }, v));
}

function renderPreview(p: Preview): void {
  const isLimit = p.price !== undefined;
  const isBuy = p.action === "buy";
  questionEl.textContent = p.question ?? `Token ${p.tokenId.slice(0, 12)}…`;
  subtitleEl.replaceChildren(
    el("span", { class: `pill ${p.action}` }, p.action.toUpperCase()),
    " ",
    p.outcome ? el("span", { class: "pill" }, p.outcome) : "",
    " ",
    el("span", {}, `${isLimit ? "Limit" : "Market"} ${p.orderType}${p.postOnly ? " · post-only" : ""}`),
  );

  const priceLabel = isLimit ? "Limit price" : isBuy ? "Best ask" : "Best bid";
  const priceVal = isLimit ? p.price! : p.bestQuote ?? NaN;
  const prob = Number.isFinite(priceVal) ? `${(priceVal * 100).toFixed(1)}¢` : "—";
  const shares = p.estimatedSize ?? p.size;
  const cap = p.maxBetUsd ?? null;
  const capPct = cap ? Math.min(100, (p.notionalUsd / cap) * 100) : 0;

  const grid = el("div", { class: "grid" },
    kv(isBuy ? "You spend" : "You receive (est.)", usd(p.notionalUsd), true),
    kv(priceLabel, `${prob}  ·  ${Number.isFinite(priceVal) ? priceVal.toFixed(3) : "—"}`, true),
    // Market orders are SIGNED at this bound (the server walks the book), so
    // the fill can never be worse than the number shown here.
    ...(!isLimit && typeof p.worstFillPrice === "number"
      ? [kv(isBuy ? "Worst fill (signed max)" : "Worst fill (signed min)", `${(p.worstFillPrice * 100).toFixed(1)}¢  ·  ${p.worstFillPrice.toFixed(3)}`)]
      : []),
    kv("Shares", shares !== undefined ? `${isLimit ? "" : "≈ "}${shares.toFixed(4)}` : "—"),
    kv("Max payout if right", isBuy && shares !== undefined ? usd(shares) : "—"),
    kv("Per-order cap", el("span", {}, `${usd(p.notionalUsd)} of ${cap ? usd(cap) : "—"}`, el("div", { class: "meter" }, el("i", { style: `width:${capPct}%` })))),
    kv("Session bets", p.sessionCapUsd ? `${usd(p.sessionSpentUsd ?? 0)} of ${usd(p.sessionCapUsd)}` : `${usd(p.sessionSpentUsd ?? 0)} so far`),
    kv("Tick · neg-risk · min size", `${p.tickSize} · ${p.negRisk ? "yes" : "no"} · ${p.minSize ?? "n/a"}`),
    kv("Fees", "taker-only (CLOB)"),
  );

  // Editable amount → re-quote through the read-only tool.
  const amountField = el("input", { type: "number", min: "0", step: isBuy && !isLimit ? "0.5" : "1", id: "amount" }) as HTMLInputElement;
  amountField.value = String(isLimit ? p.size ?? "" : isBuy ? p.amountUsd ?? "" : p.size ?? "");
  const amountLabel = isLimit ? "shares" : isBuy ? "USD" : "shares";
  const requote = el("button", { class: "small", id: "requote" }, "Re-quote") as HTMLButtonElement;
  const place = el("button", { class: "primary", id: "place" }, `Place ${p.action} · ${usd(p.notionalUsd)}`) as HTMLButtonElement;
  const cancel = el("button", { class: "small", id: "cancel", hidden: "" }, "Cancel") as HTMLButtonElement;
  const note = el("div", { class: "note" }, "Nothing is signed until you place the order. The host will ask for permission before the order tool runs.");

  const controls = el("div", { class: "row" },
    el("label", { for: "amount" }, isBuy && !isLimit ? "Amount" : "Size"), amountField, el("span", { class: "mono" }, amountLabel), requote,
    el("span", { class: "spacer" }), cancel, place,
  );
  body.replaceChildren(grid, controls, note);

  const currentArgs = (): Record<string, unknown> => {
    const n = parseFloat(amountField.value);
    const base: Record<string, unknown> = {
      side: p.action,
      token_id: p.tokenId,
      order_type: p.orderType,
    };
    if (isLimit) { base.price = p.price; base.size = n; }
    else if (isBuy) base.amount_usd = n;
    else base.size = n;
    if (p.expiresAt) base.expires_at = p.expiresAt;
    if (p.postOnly) base.post_only = true;
    return base;
  };

  requote.addEventListener("click", async () => {
    setBusy(requote, true, "Quoting…");
    try {
      const r = (await app.callServerTool({ name: "blockrun_polymarket_read", arguments: { action: "preview", ...currentArgs() } })) as ToolResult;
      if (r.isError) { note.className = "note err"; note.textContent = resultText(r); }
      else render(r);
    } catch (e) {
      note.className = "note err"; note.textContent = String((e as Error).message ?? e);
    } finally {
      setBusy(requote, false, "Re-quote");
    }
  });

  // Two-step arm → confirm, so a stray click never signs.
  let armed = false;
  const disarm = () => { armed = false; place.textContent = `Place ${p.action} · ${usd(p.notionalUsd)}`; place.classList.remove("danger"); cancel.hidden = true; };
  cancel.addEventListener("click", disarm);

  // Every figure on this card — notional, shares, worst fill, the confirm
  // label — describes the amount that was QUOTED. currentArgs() reads the
  // field live, so an edited amount used to be submitted under the old
  // label ("Confirm — sign & submit $5.00" placing $50). Placing is only
  // allowed while the field still equals the quoted amount; a change disarms
  // and disables Place until Re-quote renders a fresh card.
  const quotedAmount = parseFloat(amountField.value);
  // Submitting, or submitted-with-unknown-outcome. Either way this card must
  // not offer Place again: the first is a duplicate in flight, the second is a
  // duplicate bet on an order that may already be live at the CLOB.
  let submitting = false;
  let outcomeUnknown = false;
  const syncPlace = () => {
    const stale = parseFloat(amountField.value) !== quotedAmount;
    if (stale && armed) disarm();
    // Never re-enable during or after a submit. The stale guard wrote
    // `place.disabled = stale` unconditionally on every input event, so
    // nudging the amount up and back down while the CLOB round-trip was
    // outstanding re-enabled an ARMED button reading "Submitting…" — one more
    // click placed a second identical real-money order with no confirmation.
    place.disabled = stale || submitting || outcomeUnknown;
    place.title = stale ? "Amount changed — Re-quote first" : outcomeUnknown ? "Outcome unknown — check your positions before retrying" : "";
    if (stale) { note.className = "note"; note.textContent = "Amount changed — Re-quote first to refresh the price and notional before placing."; }
  };
  amountField.addEventListener("input", syncPlace);

  place.addEventListener("click", async () => {
    if (submitting || outcomeUnknown) return;
    if (parseFloat(amountField.value) !== quotedAmount) { syncPlace(); return; }
    if (!armed) {
      armed = true;
      place.textContent = `Confirm — sign & submit ${usd(p.notionalUsd)}`;
      place.classList.add("danger");
      cancel.hidden = false;
      return;
    }
    const args = { action: p.action, ...currentArgs(), confirm: true };
    delete (args as Record<string, unknown>).side;
    submitting = true;
    setBusy(place, true, "Submitting…"); setBusy(requote, true); cancel.hidden = true;
    amountField.disabled = true;
    try {
      const r = (await app.callServerTool({ name: "blockrun_polymarket", arguments: args })) as ToolResult;
      submitting = false; amountField.disabled = false;
      if (r.isError) {
        // A tool-level error is the server's own report, so it knows whether
        // anything was signed — and it says so. Only re-arm when it tells us
        // nothing landed; otherwise this card must not invite a second bet.
        const text = resultText(r);
        note.className = "note err"; note.textContent = text;
        if (outcomeIsUnknown(text)) { outcomeUnknown = true; setBusy(place, false); setBusy(requote, false); syncPlace(); }
        else { disarm(); setBusy(place, false); setBusy(requote, false); }
        return;
      }
      renderPlaced(p, structured<Placed>(r) ?? {}, resultText(r));
      void app.updateModelContext({
        content: [{ type: "text", text: `User placed the order from the order card: ${resultText(r)}` }],
        structuredContent: (r.structuredContent ?? {}) as Record<string, unknown>,
      }).catch(() => {});
    } catch (e) {
      submitting = false; amountField.disabled = false;
      const msg = String((e as Error).message ?? e);
      note.className = "note err";
      // A THROW is transport-level — a host/SDK timeout, a dropped connection,
      // a torn-down sandbox — which is exactly when the order may already be
      // live at the CLOB. Re-arming here reads as "nothing happened, try
      // again" and places a duplicate. A refusal at the consent prompt is the
      // one case where nothing was signed, and it says so.
      if (declinedByUser(msg)) {
        note.textContent = msg;
        disarm(); setBusy(place, false); setBusy(requote, false);
      } else {
        outcomeUnknown = true;
        note.textContent = `${msg}\n\nThe request did not complete, so this order MAY already be live at the exchange. Check your positions before placing it again — this card will not re-submit it.`;
        setBusy(place, false); setBusy(requote, false); syncPlace();
      }
    }
  });
}

function renderPlaced(p: Preview, r: Placed, text: string): void {
  subtitleEl.replaceChildren(el("span", { class: `pill ${p.action}` }, p.action.toUpperCase()), " ", el("span", { class: "pill active" }, r.status ?? "submitted"));
  const txs = (r.transactionsHashes ?? []).map((h) => {
    const a = el("a", { href: "#", class: "mono" }, `${h.slice(0, 10)}…${h.slice(-6)}`);
    a.addEventListener("click", (ev) => { ev.preventDefault(); void app.openLink({ url: `https://polygonscan.com/tx/${h}` }); });
    return a;
  });
  body.replaceChildren(
    el("div", { class: "note ok" }, "✅ Order submitted"),
    el("div", { class: "grid" },
      kv("Order ID", el("span", { class: "mono" }, r.orderID ?? "n/a")),
      kv("Notional", usd(r.notionalUsd ?? p.notionalUsd)),
      kv("Status", r.status ?? "submitted"),
      kv("Session bets", r.session ? `${usd(r.session.totalUsd)} across ${r.session.count}` : "—"),
      ...(txs.length ? [kv("Transactions", el("span", {}, ...txs.flatMap((a, i) => (i ? [", ", a] : [a]))))] : []),
    ),
    el("details", {}, el("summary", {}, "Raw result"), el("pre", { class: "fallback" }, text)),
  );
}
