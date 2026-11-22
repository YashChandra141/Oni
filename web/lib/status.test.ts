// Req 33.1 and 44.7: status bar text.
import { describe, expect, test } from "bun:test";
import { accountLabel, connectionLabel, modeLabel, shortAddress } from "./status";

describe("connectionLabel", () => {
  test("every state except connected reads as waking the server", () => {
    expect(connectionLabel({ kind: "connecting", attempt: 1 })).toBe("WAKING SERVER… attempt 1");
    expect(connectionLabel({ kind: "waking", attempt: 3, nextDelayMs: 500 })).toBe(
      "WAKING SERVER… attempt 3, retry in 0.5s",
    );
    expect(connectionLabel({ kind: "waking", attempt: 9, nextDelayMs: 10_000 })).toBe(
      "WAKING SERVER… attempt 9, retry in 10s",
    );
    expect(connectionLabel({ kind: "disconnected", reason: "x" })).toStartWith("WAKING SERVER");
  });

  test("connected does not say waking", () => {
    expect(connectionLabel({ kind: "connected" })).toBe("CONNECTED");
  });
});

describe("modeLabel", () => {
  const base = { protocolVersion: 3, engineRunning: true } as const;

  test("replay", () => {
    expect(
      modeLabel({ ...base, dataMode: "replay", venue: null, liveVenues: [], defaultVenue: "replay" }),
    ).toBe("REPLAY");
  });

  test("live shows the venues", () => {
    expect(
      modeLabel({ ...base, dataMode: "live", venue: "backpack", liveVenues: ["backpack"], defaultVenue: "backpack" }),
    ).toBe("LIVE · Backpack (USDC)");
    expect(
      modeLabel({ ...base, dataMode: "live", venue: "coinbase", liveVenues: ["coinbase"], defaultVenue: "coinbase" }),
    ).toBe("LIVE · Coinbase");
    expect(
      modeLabel({
        ...base,
        dataMode: "live",
        venue: "coinbase",
        liveVenues: ["coinbase", "backpack"],
        defaultVenue: "coinbase",
      }),
    ).toBe("LIVE · Coinbase, Backpack (USDC)");
    expect(
      modeLabel({ ...base, dataMode: "live", venue: null, liveVenues: [], defaultVenue: "coinbase" }),
    ).toBe("LIVE");
  });
});

describe("accountLabel", () => {
  test("no session yet", () => {
    expect(accountLabel(null)).toBe("—");
  });

  test("guest", () => {
    expect(accountLabel({ accountId: "guest", address: null })).toBe("GUEST");
  });

  test("a wallet account shows the shortened address", () => {
    const address = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    expect(accountLabel({ accountId: `w_${address}`, address })).toBe("9xQe…VFin");
  });

  test("shortAddress leaves short text alone", () => {
    expect(shortAddress("abc")).toBe("abc");
    expect(shortAddress("123456789")).toBe("123456789");
    expect(shortAddress("1234567890")).toBe("1234…7890");
  });
});
