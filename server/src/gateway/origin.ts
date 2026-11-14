// WebSocket Origin check (design §3 "Gateway (Req 17)", Req 17.2, trading-safety rule 8).
//
// Policy, from design.md: "Requests without `Origin` (TUI, MCP, CLI tools) are allowed,
// because browsers always send it and the check exists to stop other websites."
// - No Origin header: allow. Only browsers send one; the TUI, the MCP server, and CLI tools
//   connect without it.
// - An Origin listed in ALLOWED_ORIGINS: allow.
// - Any other Origin, including the opaque origin "null" (sandboxed iframes, file: pages,
//   some redirects): deny, and the caller answers 403.
//
// Both sides are normalized before comparing: lowercase scheme and host, default port
// dropped, no trailing slash. Pure: no I/O.

export type OriginDecision = "allow" | "deny";

/**
 * Normalizes an origin to `scheme://host[:port]` (what `URL.origin` returns), or returns null
 * when the value is not a plain http(s) origin. One trailing slash is tolerated.
 */
export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "null") return null;
  const candidate = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // An Origin header never carries credentials, a path, a query, or a fragment.
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (candidate.endsWith("/")) return null; // more than one trailing slash
  return url.origin;
}

/**
 * Decides whether a WebSocket upgrade may proceed (Req 17.2).
 * `originHeader` is the raw header value, or null when the request has no Origin header.
 */
export function checkOrigin(originHeader: string | null | undefined, allowed: readonly string[]): OriginDecision {
  // Missing header: a non-browser client (TUI, MCP, CLI). See design §3 Gateway.
  if (originHeader === null || originHeader === undefined) return "allow";
  const origin = normalizeOrigin(originHeader);
  if (origin === null) return "deny"; // includes the literal "null" and malformed values
  for (const entry of allowed) {
    if (normalizeOrigin(entry) === origin) return "allow";
  }
  return "deny";
}
