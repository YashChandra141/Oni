// Pure text for the status bar (Req 33.1, 44.7).

import { formatDelaySeconds } from "./format";
import type { ConnectionState, HelloInfo, SessionInfo } from "./store";

/** Req 33.1: every state except `connected` reads as a "waking server" status. */
export function connectionLabel(connection: ConnectionState): string {
  switch (connection.kind) {
    case "connected":
      return "CONNECTED";
    case "connecting":
      return `WAKING SERVER… attempt ${connection.attempt}`;
    case "waking":
      return `WAKING SERVER… attempt ${connection.attempt}, retry in ${formatDelaySeconds(connection.nextDelayMs)}`;
    case "disconnected":
      return "WAKING SERVER… reconnecting";
  }
}

/** Venue display name; Backpack's USDC pairs are shown as USD, so it carries "(USDC)". */
export function venueName(venue: "coinbase" | "backpack"): string {
  return venue === "backpack" ? "Backpack (USDC)" : "Coinbase";
}

/** `REPLAY`, or `LIVE · <venue>` (`LIVE` when the venue is unknown). Req 27.4, 44.7. */
export function modeLabel(hello: HelloInfo): string {
  if (hello.dataMode === "replay") return "REPLAY";
  return hello.venue === null ? "LIVE" : `LIVE · ${venueName(hello.venue)}`;
}

export const displayVenue = modeLabel;

/** `AbCd…WxYz` for long addresses; shorter text is returned as is. */
export function shortAddress(address: string): string {
  return address.length <= 9 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** `GUEST` for the guest account, a shortened address for a wallet account, `—` before `session`. */
export function accountLabel(session: SessionInfo | null): string {
  if (session === null) return "—";
  if (session.accountId === "guest") return "GUEST";
  return shortAddress(session.address ?? session.accountId);
}
