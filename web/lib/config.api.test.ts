import { describe, expect, test } from "bun:test";
import { ConfigError, deriveApiUrl, resolveApiUrl } from "./config";

describe("deriveApiUrl", () => {
  test("maps ws to http and wss to https and drops /ws", () => {
    expect(deriveApiUrl("ws://localhost:8080/ws")).toBe("http://localhost:8080");
    expect(deriveApiUrl("wss://api.example.com/ws")).toBe("https://api.example.com");
    expect(deriveApiUrl("wss://example.com/prefix/ws")).toBe("https://example.com/prefix");
  });
});

describe("resolveApiUrl", () => {
  test("falls back to the derived URL when unset or blank", () => {
    expect(resolveApiUrl(undefined, "ws://localhost:8080/ws")).toBe("http://localhost:8080");
    expect(resolveApiUrl("  ", "ws://localhost:8080/ws")).toBe("http://localhost:8080");
  });

  test("uses a valid explicit value without a trailing slash", () => {
    expect(resolveApiUrl("https://api.example.com/", "ws://x/ws")).toBe("https://api.example.com");
  });

  test("rejects bad explicit values", () => {
    expect(() => resolveApiUrl("ftp://x", "ws://x/ws")).toThrow(ConfigError);
    expect(() => resolveApiUrl("not a url", "ws://x/ws")).toThrow(ConfigError);
    expect(() => resolveApiUrl("https://u:p@x", "ws://x/ws")).toThrow(ConfigError);
    expect(() => resolveApiUrl("https://x?a=1", "ws://x/ws")).toThrow(ConfigError);
  });
});
