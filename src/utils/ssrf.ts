// src/utils/ssrf.ts
//
// Guard for server-side fetches of caller/model-supplied URLs (blockrun_image's
// reference image/mask). The MCP server runs on the user's machine, which can
// reach localhost dev servers, cloud metadata endpoints (169.254.169.254), and
// internal hosts — so a supplied (or prompt-injected) URL must not be allowed to
// probe the private network. This is a literal-host deny-list applied to every
// redirect hop; it is not full DNS-rebinding protection (a public name resolving
// to a private IP would still pass), but it blocks the realistic vectors.

function ipv4Blocked(host: string): boolean | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null; // not a dotted-quad
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return true; // malformed → block
  const [a, b] = o;
  return (
    a === 0 ||                                  // 0.0.0.0/8
    a === 127 ||                                // loopback
    a === 10 ||                                 // private
    (a === 172 && b >= 16 && b <= 31) ||        // private
    (a === 192 && b === 168) ||                 // private
    (a === 169 && b === 254) ||                 // link-local (incl. metadata)
    (a === 100 && b >= 64 && b <= 127)          // CGNAT
  );
}

/**
 * True when a hostname must NOT be fetched server-side: loopback, private,
 * link-local/metadata, CGNAT, or an internal-only name. Accepts bare hosts and
 * bracketed IPv6 (`[::1]`).
 */
export function isBlockedFetchHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  // A fully-qualified name keeps its root dot through the WHATWG URL parser
  // (new URL("http://localhost./").hostname === "localhost."), which would slip
  // past the exact/endsWith name checks below while DNS still resolves it. Strip
  // trailing dots so "localhost." and "metadata.google.internal." are caught
  // (numeric IPs are already dot-normalized by the parser, so this only matters
  // for names).
  host = host.replace(/\.+$/, "");
  if (!host) return true;

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;

  const v4 = ipv4Blocked(host);
  if (v4 !== null) return v4;

  // IPv6: loopback, unique-local (fc00::/7 → fc/fd), link-local (fe80::/10),
  // unspecified, and IPv4-mapped (::ffff:a.b.c.d → check the embedded v4).
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
    // IPv4-mapped, decimal form (::ffff:127.0.0.1).
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
    if (mapped) return ipv4Blocked(mapped[1]) === true;
    // IPv4-mapped, HEX-compressed form (::ffff:7f00:1) — this is what the WHATWG
    // URL parser actually emits for new URL('http://[::ffff:127.0.0.1]/'), so it
    // must be decoded too or the deny-list is bypassable.
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
      return ipv4Blocked(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`) === true;
    }
    return false;
  }

  return false;
}
