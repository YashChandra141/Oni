// Origin check for WebSocket upgrades (Req 17.2, design §3 Gateway).
import { describe, expect, test } from "bun:test";
import { checkOrigin, normalizeOrigin } from "./origin.ts";

const ALLOWED = ["http://localhost:3000", "https://haunted-terminal-web.onrender.com"];

describe("checkOrigin", () => {
  test("allows a listed origin", () => {
    expect(checkOrigin("http://localhost:3000", ALLOWED)).toBe("allow");
    expect(checkOrigin("https://haunted-terminal-web.onrender.com", ALLOWED)).toBe("allow");
  });

  test("denies an origin that is not listed (Req 17.2)", () => {
    expect(checkOrigin("https://evil.example", ALLOWED)).toBe("deny");
    expect(checkOrigin("http://localhost:3001", ALLOWED)).toBe("deny");
    expect(checkOrigin("https://localhost:3000", ALLOWED)).toBe("deny");
    expect(checkOrigin("http://localhost:3000.evil.example", ALLOWED)).toBe("deny");
  });

  test("allows a request without an Origin header (TUI, MCP, CLI clients)", () => {
    expect(checkOrigin(null, ALLOWED)).toBe("allow");
    expect(checkOrigin(undefined, ALLOWED)).toBe("allow");
    expect(checkOrigin(null, [])).toBe("allow");
  });

  test('denies the opaque origin "null"', () => {
    expect(checkOrigin("null", ALLOWED)).toBe("deny");
    expect(checkOrigin("null", ["null"])).toBe("deny");
  });

  test("denies empty and malformed values", () => {
    for (const value of ["", " ", "localhost:3000", "file:///tmp", "ws://localhost:3000", "http://localhost:3000/app"]) {
      expect(checkOrigin(value, ALLOWED)).toBe("deny");
    }
  });

  test("compares normalized values: case, trailing slash, default port", () => {
    expect(checkOrigin("HTTP://LocalHost:3000", ALLOWED)).toBe("allow");
    expect(checkOrigin("http://localhost:3000/", ALLOWED)).toBe("allow");
    expect(checkOrigin("https://example.com:443", ["https://example.com"])).toBe("allow");
    expect(checkOrigin("https://example.com", ["HTTPS://EXAMPLE.COM/"])).toBe("allow");
  });
});

describe("normalizeOrigin", () => {
  test("returns scheme://host[:port]", () => {
    expect(normalizeOrigin("HTTPS://Example.COM/")).toBe("https://example.com");
    expect(normalizeOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });

  test("rejects non-origins", () => {
    expect(normalizeOrigin("null")).toBeNull();
    expect(normalizeOrigin("http://a.example//")).toBeNull();
    expect(normalizeOrigin("http://user:pw@a.example")).toBeNull();
    expect(normalizeOrigin("http://a.example/?q=1")).toBeNull();
  });
});
