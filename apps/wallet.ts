// apps/wallet.ts — the wallet panel.
//
// Rendered by the host for every blockrun_wallet result. For `status` it
// shows both chains, lets the user switch the active chain, copy an address,
// show a funding QR, and open the card on-ramp — each of which is a
// tools/call on blockrun_wallet through the host.
import QRCode from "qrcode";
import { $, autoSize, bootApp, copyText, el, resultText, setBusy, shortAddr, structured, type ToolResult } from "./shared";

interface Status {
  activeChain: "base" | "solana";
  address: string;
  balance: number | null;
  explorerUrl: string;
  explorerLabel: string;
  isNew?: boolean;
  wallets: { base: { address: string; balance: number | null }; solana: { address: string; balance: number | null } };
}

// Payment-request URIs, same encoding as src/utils/qr.ts (EIP-681 on Base,
// Solana Pay on Solana) so a wallet app that scans the QR pre-fills USDC.
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const paymentUri = (chain: "base" | "solana", address: string) =>
  chain === "solana"
    ? `solana:${address}?spl-token=${USDC_SOL_MINT}&label=BlockRun`
    : `ethereum:${USDC_BASE}@8453/transfer?address=${address}`;

const app = await bootApp("BlockRun wallet");
autoSize(app);

const subtitle = $("subtitle");
const body = $("body");

app.ontoolresult = (r) => render(r as ToolResult);

async function call(args: Record<string, unknown>): Promise<ToolResult> {
  return (await app.callServerTool({ name: "blockrun_wallet", arguments: args })) as ToolResult;
}

function render(r: ToolResult): void {
  const s = structured<Record<string, unknown>>(r);
  if (!r.isError && s && s.wallets) return renderStatus(s as unknown as Status);
  if (!r.isError && s && typeof s.onramp_url === "string") return renderOnramp(s.onramp_url as string, resultText(r));
  renderFallback(resultText(r), Boolean(r.isError));
}

function renderFallback(text: string, isError: boolean): void {
  subtitle.textContent = isError ? "Error" : "";
  const refresh = el("button", { class: "small" }, "Show balances") as HTMLButtonElement;
  refresh.addEventListener("click", async () => { setBusy(refresh, true, "Loading…"); try { render(await call({ action: "status" })); } finally { setBusy(refresh, false, "Show balances"); } });
  body.replaceChildren(el("pre", { class: `fallback${isError ? " err" : ""}` }, text || "(empty result)"), el("div", { class: "row end", style: "margin-top:10px" }, refresh));
}

function renderOnramp(url: string, text: string): void {
  subtitle.textContent = "Card top-up";
  const open = el("button", { class: "primary" }, "Open Coinbase Onramp") as HTMLButtonElement;
  open.addEventListener("click", () => { void app.openLink({ url }); });
  const back = el("button", { class: "small" }, "Back to balances") as HTMLButtonElement;
  back.addEventListener("click", async () => { setBusy(back, true); render(await call({ action: "status" })); });
  body.replaceChildren(
    el("div", { class: "note" }, text),
    el("div", { class: "row end", style: "margin-top:10px" }, back, open),
  );
}

function renderStatus(s: Status): void {
  subtitle.textContent = `Paying on ${s.activeChain === "solana" ? "Solana" : "Base"} · self-custody · pay-per-call`;
  const note = el("div", { class: "note", hidden: "" });

  const chainCard = (chain: "base" | "solana") => {
    const w = s.wallets[chain];
    const active = s.activeChain === chain;
    const bal = w.balance;
    const low = bal !== null && bal < 1;
    const useBtn = el("button", { class: "small" }, active ? "Active" : `Use ${chain === "base" ? "Base" : "Solana"}`) as HTMLButtonElement;
    useBtn.disabled = active;
    if (active) useBtn.className = "pill active";
    useBtn.addEventListener("click", async () => {
      setBusy(useBtn, true, "Switching…");
      try {
        const r = await call({ action: "chain", chain });
        if (r.isError) { note.hidden = false; note.className = "note err"; note.textContent = resultText(r); setBusy(useBtn, false, `Use ${chain}`); return; }
        render(await call({ action: "status" }));
      } catch (e) { note.hidden = false; note.className = "note err"; note.textContent = String((e as Error).message ?? e); setBusy(useBtn, false); }
    });

    const copy = el("button", { class: "small" }, "Copy") as HTMLButtonElement;
    copy.addEventListener("click", async () => { copy.textContent = (await copyText(w.address)) ? "Copied" : "Copy failed"; setTimeout(() => (copy.textContent = "Copy"), 1500); });
    const qrBtn = el("button", { class: "small" }, "QR") as HTMLButtonElement;
    const qrHolder = el("div");
    qrBtn.addEventListener("click", async () => {
      if (qrHolder.childElementCount) { qrHolder.replaceChildren(); qrBtn.textContent = "QR"; return; }
      const dataUrl = await QRCode.toDataURL(paymentUri(chain, w.address), { margin: 1, width: 168 });
      qrHolder.replaceChildren(el("img", { class: "qr", src: dataUrl, alt: `${chain} funding QR` }), el("div", { class: "sub", style: "text-align:center;margin-top:6px" }, chain === "solana" ? "Send USDC (SPL) on Solana" : "Send USDC on Base"));
      qrBtn.textContent = "Hide QR";
    });

    return el("div", { class: `chain${active ? " active" : ""}` },
      el("div", { class: "name" }, chain === "base" ? "Base" : "Solana", useBtn),
      el("div", { class: "bal" }, bal === null ? "—" : `$${bal.toFixed(2)}`, el("span", { class: "sub", style: "font-size:12px;font-weight:400" }, " USDC")),
      low ? el("div", { class: "sub", style: "color:var(--warn)" }, "Low balance") : el("div", { class: "sub" }, " "),
      el("div", { class: "row", style: "margin-top:8px" }, el("span", { class: "mono addr", title: w.address }, shortAddr(w.address)), copy, qrBtn),
      qrHolder,
    );
  };

  const buy = el("button", { class: "primary" }, "Buy USDC with card") as HTMLButtonElement;
  buy.addEventListener("click", async () => {
    setBusy(buy, true, "Minting link…");
    try { render(await call({ action: "deposit" })); } catch (e) { note.hidden = false; note.className = "note err"; note.textContent = String((e as Error).message ?? e); }
    finally { setBusy(buy, false, "Buy USDC with card"); }
  });
  const explorer = el("button", { class: "small" }, s.explorerLabel || "Explorer") as HTMLButtonElement;
  explorer.addEventListener("click", () => { void app.openLink({ url: s.explorerUrl }); });
  const refresh = el("button", { class: "small" }, "Refresh") as HTMLButtonElement;
  refresh.addEventListener("click", async () => { setBusy(refresh, true, "…"); try { render(await call({ action: "status" })); } finally { setBusy(refresh, false, "Refresh"); } });

  body.replaceChildren(
    el("div", { class: "chains" }, chainCard("base"), chainCard("solana")),
    s.isNew ? el("div", { class: "note warn" }, "New wallet on the active chain — fund it before paid calls.") : "",
    note,
    el("div", { class: "row end", style: "margin-top:10px" }, refresh, explorer, buy),
  );
}
