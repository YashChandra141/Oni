import { describe, expect, test } from "bun:test";
import { confirmPairing, formatCode, normalizeCode } from "./pairing";
import type { PairDeps } from "./pairing";

interface Call {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function fakeDeps(status: number | Error, token: string | null = "tok"): { deps: PairDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: PairDeps = {
    apiUrl: "http://api.test",
    token,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (status instanceof Error) throw status;
      return { status };
    },
  };
  return { deps, calls };
}

describe("normalizeCode", () => {
  test("accepts a valid code", () => expect(normalizeCode("ABCD2345")).toBe("ABCD2345"));
  test("accepts lowercase, hyphen, and spaces", () => {
    expect(normalizeCode("abcd-2345")).toBe("ABCD2345");
    expect(normalizeCode(" abcd 2345 ")).toBe("ABCD2345");
  });
  test("rejects wrong length, bad characters, and missing values", () => {
    expect(normalizeCode("ABCD234")).toBeNull();
    expect(normalizeCode("ABCD23456")).toBeNull();
    expect(normalizeCode("ABCD234O")).toBeNull();
    expect(normalizeCode("ABCD2341")).toBeNull();
    expect(normalizeCode("")).toBeNull();
    expect(normalizeCode(null)).toBeNull();
    expect(normalizeCode(undefined)).toBeNull();
  });
});

describe("formatCode", () => {
  test("inserts a hyphen in the middle", () => expect(formatCode("ABCD2345")).toBe("ABCD-2345"));
});

describe("confirmPairing", () => {
  test("204 is success; request has Bearer header and exact body", async () => {
    const { deps, calls } = fakeDeps(204);
    expect(await confirmPairing("abcd-2345", deps)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://api.test/auth/pair/confirm");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers.authorization).toBe("Bearer tok");
    expect(calls[0]?.init.body).toBe('{"code":"ABCD2345"}');
  });
  test("maps 401, 404, 400, and other statuses", async () => {
    expect(await confirmPairing("ABCD2345", fakeDeps(401).deps)).toEqual({ ok: false, reason: "not_signed_in" });
    expect(await confirmPairing("ABCD2345", fakeDeps(404).deps)).toEqual({ ok: false, reason: "expired_or_unknown" });
    expect(await confirmPairing("ABCD2345", fakeDeps(400).deps)).toEqual({ ok: false, reason: "rejected" });
    expect(await confirmPairing("ABCD2345", fakeDeps(500).deps)).toEqual({ ok: false, reason: "network" });
  });
  test("network error maps to network", async () => {
    expect(await confirmPairing("ABCD2345", fakeDeps(new Error("down")).deps)).toEqual({ ok: false, reason: "network" });
  });
  test("sends nothing when not signed in", async () => {
    const { deps, calls } = fakeDeps(204, null);
    expect(await confirmPairing("ABCD2345", deps)).toEqual({ ok: false, reason: "not_signed_in" });
    expect(calls).toHaveLength(0);
  });
  test("sends nothing for an invalid code", async () => {
    const { deps, calls } = fakeDeps(204);
    expect((await confirmPairing("bad", deps)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
