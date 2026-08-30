// apps/shared.ts — what both MCP Apps have in common: host handshake, theme
// wiring, tool-result plumbing, and a few DOM helpers. No framework.
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolResult = CallToolResult & { structuredContent?: Record<string, unknown> };

/** Create the App, wire host theme/styles, connect. */
export async function bootApp(name: string): Promise<App> {
  const app = new App({ name, version: "1" });
  const applyContext = (ctx: McpUiHostContext | undefined) => {
    if (!ctx) return;
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  };
  app.onhostcontextchanged = (ctx) => applyContext(ctx);
  await app.connect();
  applyContext(app.getHostContext());
  return app;
}

/** Text content of a tool result, joined. */
export function resultText(r: ToolResult | undefined): string {
  if (!r) return "";
  return (r.content ?? [])
    .map((c) => (c.type === "text" ? (c as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

export function structured<T = Record<string, unknown>>(r: ToolResult | undefined): T | undefined {
  return (r?.structuredContent ?? undefined) as T | undefined;
}

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

export function el(tag: string, attrs: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElement {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c);
  return n;
}

export function usd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(digits)}`;
}

export function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Tell the host our height so the iframe fits the card instead of scrolling. */
export function reportSize(app: App): void {
  const h = document.documentElement.scrollHeight;
  void app.sendSizeChanged({ height: h }).catch(() => {});
}

/** Debounced size reporting on any DOM change. */
export function autoSize(app: App): void {
  let t: number | undefined;
  const kick = () => {
    if (t) window.clearTimeout(t);
    t = window.setTimeout(() => reportSize(app), 30);
  };
  new MutationObserver(kick).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  window.addEventListener("resize", kick);
  kick();
}

export function setBusy(button: HTMLButtonElement, busy: boolean, label?: string): void {
  button.disabled = busy;
  if (label !== undefined) button.textContent = label;
  button.classList.toggle("busy", busy);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
