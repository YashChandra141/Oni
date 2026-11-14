// Web UI runtime configuration (Req 37.2).
//
// NEXT_PUBLIC_* variables are inlined by Next.js at build time, so the static
// export carries the WebSocket URL it was built with. Without one, the UI
// points at a local server.

export const DEFAULT_WS_URL = "ws://localhost:8080/ws";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Validates a Server WebSocket URL. Accepts only absolute `ws:` or `wss:` URLs
 * with a host and without credentials, query, or fragment. Returns the URL as
 * given (trimmed) so the value the operator set is the value the socket uses.
 */
export function parseWsUrl(raw: string): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`NEXT_PUBLIC_WS_URL is not a valid URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new ConfigError(`NEXT_PUBLIC_WS_URL must use ws: or wss:, got ${url.protocol}`);
  }
  if (url.hostname === "") {
    throw new ConfigError("NEXT_PUBLIC_WS_URL must include a host");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("NEXT_PUBLIC_WS_URL must not contain credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError("NEXT_PUBLIC_WS_URL must not contain a query or fragment");
  }
  return value;
}

/** Resolves the WebSocket URL from an env value, falling back to the local default when unset or blank. */
export function resolveWsUrl(env: string | undefined): string {
  if (env === undefined || env.trim() === "") return DEFAULT_WS_URL;
  return parseWsUrl(env);
}

/**
 * Derives the Server's HTTP base URL from its WebSocket URL: ws becomes http, wss becomes https,
 * and a trailing `/ws` path is dropped. `ws://localhost:8080/ws` gives `http://localhost:8080`.
 * The result has no trailing slash.
 */
export function deriveApiUrl(wsUrl: string): string {
  const url = new URL(parseWsUrl(wsUrl));
  const protocol = url.protocol === "wss:" ? "https:" : "http:";
  const path = url.pathname.replace(/\/+$/, "").replace(/\/ws$/, "");
  return `${protocol}//${url.host}${path}`;
}

/** Validates an explicit HTTP base URL: absolute http(s), no credentials, query, or fragment. */
export function parseApiUrl(raw: string): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`NEXT_PUBLIC_API_URL is not a valid URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`NEXT_PUBLIC_API_URL must use http: or https:, got ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("NEXT_PUBLIC_API_URL must not contain credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError("NEXT_PUBLIC_API_URL must not contain a query or fragment");
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** Resolves the HTTP base URL: the env value when set, otherwise derived from the WebSocket URL. */
export function resolveApiUrl(env: string | undefined, wsUrl: string): string {
  if (env === undefined || env.trim() === "") return deriveApiUrl(wsUrl);
  return parseApiUrl(env);
}

// Next.js replaces this exact expression at build time; keep it a direct property access.
export const WS_URL: string = resolveWsUrl(process.env.NEXT_PUBLIC_WS_URL);

/** HTTP base URL for the auth routes (`/auth/nonce`, `/auth/verify`, `/auth/logout`). */
export const API_URL: string = resolveApiUrl(process.env.NEXT_PUBLIC_API_URL, WS_URL);
