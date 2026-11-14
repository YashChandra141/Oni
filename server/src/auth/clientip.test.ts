import { describe, expect, test } from "bun:test";
import { clientIp } from "./clientip.ts";

describe("clientIp", () => {
  test("uses the rightmost forwarded entry in production", () => {
    expect(clientIp("6.6.6.6, 203.0.113.9", "10.0.0.1", true)).toBe("203.0.113.9");
  });

  test("ignores the header outside production", () => {
    expect(clientIp("203.0.113.9", "127.0.0.1", false)).toBe("127.0.0.1");
  });

  test("falls back to the socket, then to unknown, and rejects non-IP text", () => {
    expect(clientIp("not-an-ip", "::1", true)).toBe("::1");
    expect(clientIp(null, undefined, true)).toBe("unknown");
    expect(clientIp("bad", "bad", true)).toBe("unknown");
  });
});

describe("clientIp forwarded-for handling", () => {
  test("picks the rightmost of several entries and trims spaces", () => {
    expect(clientIp("1.1.1.1, 2.2.2.2,   3.3.3.3  ", "10.0.0.1", true)).toBe("3.3.3.3");
  });

  test("accepts an IPv6 address from the header and from the socket", () => {
    expect(clientIp("1.1.1.1, 2001:db8::1", "10.0.0.1", true)).toBe("2001:db8::1");
    expect(clientIp("2001:db8::1", "::1", false)).toBe("::1");
  });

  test("a garbage rightmost entry falls back to the socket, not to an earlier entry", () => {
    expect(clientIp("1.1.1.1, garbage", "10.0.0.1", true)).toBe("10.0.0.1");
    expect(clientIp("1.1.1.1,", "10.0.0.1", true)).toBe("10.0.0.1");
    expect(clientIp("", "10.0.0.1", true)).toBe("10.0.0.1");
  });

  test("never returns header text when it is not trusted or not an IP", () => {
    expect(clientIp("203.0.113.9", undefined, false)).toBe("unknown");
    expect(clientIp(`${"1".repeat(50)}`, undefined, true)).toBe("unknown");
    expect(clientIp("999.1.1.1", "bad socket", true)).toBe("unknown");
  });
});
