// src/profiles.ts
//
// Tool profiles let one published package expose a trimmed tool set so MCP
// clients (Claude Code, etc.) only load the schemas they need into context.
// Select a profile with `--profile <name>` (CLI flag) or BLOCKRUN_MCP_PROFILE.
//
//   claude mcp add blockrun-media -- npx -y @blockrun/mcp@latest --profile media
//
// "full" (default) registers everything — identical to the historical behavior.

export type ToolName =
  | "wallet"
  | "chat"
  | "models"
  | "image"
  | "music"
  | "speech"
  | "video"
  | "realface"
  | "search"
  | "exa"
  | "markets"
  | "price"
  | "dex"
  | "modal"
  | "phone"
  | "rpc"
  | "defi"
  | "polymarket_read"
  | "polymarket";

// `as const satisfies` keeps the literal tuple type (so the exhaustiveness
// guard below can see the actual entries) AND rejects any entry that isn't a
// real ToolName (catches typos).
export const ALL_TOOLS = [
  "wallet", "chat", "models", "image", "music", "speech", "video", "realface",
  "search", "exa", "markets", "price", "dex", "modal", "phone", "rpc", "defi",
  "polymarket_read", "polymarket",
] as const satisfies readonly ToolName[];

// Compile-time guard: if a new ToolName is added to the union but not to
// ALL_TOOLS, `MissingFromAllTools` is non-`never` and this assignment fails —
// keeping the "full" profile from silently dropping a tool.
type MissingFromAllTools = Exclude<ToolName, (typeof ALL_TOOLS)[number]>;
const _allToolsExhaustive: Record<MissingFromAllTools, true> = {};
void _allToolsExhaustive;

// "all" is a sentinel meaning "every tool" — kept distinct from an explicit
// list so the full profile never drifts out of sync when tools are added.
export const PROFILES: Record<string, ToolName[] | "all"> = {
  full: "all",
  // Generative media: image/video/realface plus the other media-generation
  // tools (music, speech), with wallet (funding/balance — media calls cost
  // USDC) and models (discover what's available).
  media: ["wallet", "models", "image", "video", "realface", "music", "speech"],
  // Markets & on-chain data: prediction markets (data + Polymarket trading),
  // realtime prices, DEX/CEX data, DeFi metrics, and raw RPC, plus the wallet
  // for balance/funding.
  trading: ["wallet", "price", "dex", "markets", "defi", "rpc", "polymarket_read", "polymarket"],
  // Web research & analysis: live search, neural search, Surf's news/SQL,
  // and chat for synthesis, plus wallet and the model catalogue.
  research: ["wallet", "models", "chat", "search", "exa"],
  // Minimal LLM gateway: just chat + model discovery + wallet.
  chat: ["wallet", "models", "chat"],
};

const DEFAULT_PROFILE = "full";

// Profile names are case-insensitive and whitespace-tolerant: a JSON client's
// `"args": ["--profile", "trading "]` or `BLOCKRUN_MCP_PROFILE=" Media"` is a
// typo, not a different profile. Blank means "not specified".
function normalizeProfileName(raw: string | undefined): string {
  const name = (raw ?? "").trim().toLowerCase();
  return name || DEFAULT_PROFILE;
}

/**
 * Resolve the active profile name. Precedence: explicit `--profile <name>` /
 * `--profile=<name>` CLI flag, then BLOCKRUN_MCP_PROFILE env, then "full".
 * Returns the name as REQUESTED (trimmed, lower-cased); it may not be a known
 * profile — `resolveTools` does the fallback and reports both names so the
 * caller can log when they differ.
 */
export function resolveProfileName(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--profile") return normalizeProfileName(argv[i + 1]);
    if (arg.startsWith("--profile=")) return normalizeProfileName(arg.slice("--profile=".length));
  }
  return normalizeProfileName(env.BLOCKRUN_MCP_PROFILE);
}

/** The profile names `--profile` accepts, for help text and the unknown-name warning. */
export function knownProfileNames(): string[] {
  return Object.keys(PROFILES);
}

/**
 * Resolve a profile name to the concrete set of tools to register.
 * Returns the canonical profile name actually used (after unknown-name
 * fallback) alongside the tool list, plus the name that was requested, so the
 * server can log accurately — and can say so when the two differ, because a
 * misspelt `--profile tradng` otherwise loads all 20 schemas in silence for a
 * user who asked for 9.
 */
export function resolveTools(
  argv?: string[],
  env?: NodeJS.ProcessEnv,
): { profile: string; tools: Set<ToolName>; requested: string } {
  const requested = resolveProfileName(argv, env);
  // Use hasOwn so inherited Object.prototype members ("constructor",
  // "__proto__", …) are treated as unknown names and fall back to "full"
  // instead of resolving to a non-iterable function and crashing at startup.
  const spec = Object.hasOwn(PROFILES, requested) ? PROFILES[requested] : undefined;
  if (!spec) {
    return { profile: DEFAULT_PROFILE, tools: new Set(ALL_TOOLS), requested };
  }
  return {
    profile: requested,
    tools: new Set(spec === "all" ? ALL_TOOLS : spec),
    requested,
  };
}
