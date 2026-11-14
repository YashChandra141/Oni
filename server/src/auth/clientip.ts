// Client IP for rate limiting (Req 45.15; design "Rate limits").
//
// Behind Render's proxy the rightmost `X-Forwarded-For` entry is the one the proxy appended;
// entries further left can be forged by the client. Outside production (or without the
// header) the socket address is used.
// TODO(Task 18.6): confirm Render's X-Forwarded-For behaviour; if it differs, change this
// function, not the limits.

import { isIP } from "node:net";

export const UNKNOWN_IP = "unknown";

function validIp(text: string | undefined): string | null {
  if (text === undefined) return null;
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 45 && isIP(trimmed) !== 0 ? trimmed : null;
}

/**
 * @param forwardedFor value of the `X-Forwarded-For` header, or null/undefined
 * @param socketAddress `server.requestIP(req)?.address`, or undefined
 * @param trustProxy true when NODE_ENV is production (the proxy header is honoured)
 */
export function clientIp(
  forwardedFor: string | null | undefined,
  socketAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy && forwardedFor !== null && forwardedFor !== undefined) {
    const parts = forwardedFor.split(",");
    const fromHeader = validIp(parts[parts.length - 1]);
    if (fromHeader !== null) return fromHeader;
  }
  return validIp(socketAddress) ?? UNKNOWN_IP;
}
