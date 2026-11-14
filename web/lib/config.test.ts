// Req 37.2: the Web UI connects to the WebSocket URL in NEXT_PUBLIC_WS_URL.
import { describe, expect, test } from "bun:test";
import { ConfigError, DEFAULT_WS_URL, parseWsUrl, resolveWsUrl } from "./config.ts";

describe("resolveWsUrl", () => {
  test("defaults to the local server when unset", () => {
    expect(resolveWsUrl(undefined)).toBe("ws://localhost:8080/ws");
    expect(DEFAULT_WS_URL).toBe("ws://localhost:8080/ws");
  });

  test("defaults when blank", () => {
    expect(resolveWsUrl("")).toBe(DEFAULT_WS_URL);
    expect(resolveWsUrl("   ")).toBe(DEFAULT_WS_URL);
  });

  test("uses a valid configured URL", () => {
    expect(resolveWsUrl("wss://oni-server.onrender.com/ws")).toBe(
      "wss://oni-server.onrender.com/ws",
    );
    expect(resolveWsUrl(" ws://127.0.0.1:9000/ws ")).toBe("ws://127.0.0.1:9000/ws");
  });

  test("rejects an invalid configured URL instead of falling back", () => {
    expect(() => resolveWsUrl("http://example.com/ws")).toThrow(ConfigError);
  });
});

describe("parseWsUrl", () => {
  test.each([
    ["not a url"],
    ["localhost:8080/ws"],
    ["http://localhost:8080/ws"],
    ["https://example.com/ws"],
    ["ftp://example.com/ws"],
    ["ws://user:pass@example.com/ws"],
    ["ws://example.com/ws?token=abc"],
    ["ws://example.com/ws#x"],
  ])("rejects %p", (raw) => {
    expect(() => parseWsUrl(raw)).toThrow(ConfigError);
  });

  test.each([["ws://localhost:8080/ws"], ["wss://example.com/ws"], ["wss://example.com:443/ws"]])(
    "accepts %p",
    (raw) => {
      expect(parseWsUrl(raw)).toBe(raw);
    },
  );
});
