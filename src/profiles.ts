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
  | "surf"
  | "rpc"
  | "defi";

export const ALL_TOOLS: ToolName[] = [
  "wallet", "chat", "models", "image", "music", "speech", "video", "realface",
  "search", "exa", "markets", "price", "dex", "modal", "phone", "surf", "rpc", "defi",
];

// "all" is a sentinel meaning "every tool" — kept distinct from an explicit
// list so the full profile never drifts out of sync when tools are added.
export const PROFILES: Record<string, ToolName[] | "all"> = {
  full: "all",
  // Image + video focused build: generation/editing tools (image, video,
  // realface) plus the other generative-media tools (music, speech), and the
  // wallet (funding/balance — media calls cost USDC) and models (discover
  // what's available). Strips chat, market data, search, and the rest.
  media: ["wallet", "models", "image", "video", "realface", "music", "speech"],
};

const DEFAULT_PROFILE = "full";

/**
 * Resolve the active profile name. Precedence: explicit `--profile <name>` /
 * `--profile=<name>` CLI flag, then BLOCKRUN_MCP_PROFILE env, then "full".
 * An unknown name falls back to "full" (logged by the caller).
 */
export function resolveProfileName(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--profile") return (argv[i + 1] ?? DEFAULT_PROFILE).toLowerCase();
    if (arg.startsWith("--profile=")) return arg.slice("--profile=".length).toLowerCase();
  }
  if (env.BLOCKRUN_MCP_PROFILE) return env.BLOCKRUN_MCP_PROFILE.toLowerCase();
  return DEFAULT_PROFILE;
}

/**
 * Resolve a profile name to the concrete set of tools to register.
 * Returns the canonical profile name actually used (after unknown-name
 * fallback) alongside the tool list, so the server can log it accurately.
 */
export function resolveTools(
  argv?: string[],
  env?: NodeJS.ProcessEnv,
): { profile: string; tools: Set<ToolName> } {
  const requested = resolveProfileName(argv, env);
  const spec = PROFILES[requested];
  if (!spec) {
    return { profile: DEFAULT_PROFILE, tools: new Set(ALL_TOOLS) };
  }
  return {
    profile: requested,
    tools: new Set(spec === "all" ? ALL_TOOLS : spec),
  };
}
