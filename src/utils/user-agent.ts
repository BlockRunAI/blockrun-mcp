const BLOCKRUN_HOSTS = new Set(["blockrun.ai", "www.blockrun.ai", "sol.blockrun.ai"]);
const INSTALL_MARKER = Symbol.for("blockrun.mcp.userAgentInstalled");

type MarkedGlobal = typeof globalThis & { [INSTALL_MARKER]?: boolean };

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    const raw = input instanceof Request ? input.url : input.toString();
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Wrap fetch so every request to a BlockRun gateway is attributable to MCP. */
export function withBlockrunMcpUserAgent(
  baseFetch: typeof fetch,
  version: string,
): typeof fetch {
  const userAgent = `blockrun-mcp/${version}`;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (!url || !BLOCKRUN_HOSTS.has(url.hostname)) {
      return baseFetch(input, init);
    }

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    // Deliberately override the SDK's blockrun-ts/* identifier: this process is
    // the MCP product boundary and should be counted as MCP in gateway logs.
    headers.set("User-Agent", userAgent);
    return baseFetch(input, { ...init, headers });
  }) as typeof fetch;
}

export function installBlockrunMcpUserAgent(version: string): void {
  const target = globalThis as MarkedGlobal;
  if (target[INSTALL_MARKER]) return;
  globalThis.fetch = withBlockrunMcpUserAgent(globalThis.fetch.bind(globalThis), version);
  target[INSTALL_MARKER] = true;
}
