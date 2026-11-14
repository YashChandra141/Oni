// Auth state in the store, address shortening, and the /pair page contract (Task 20.4,
// Req 47.4, 47.6, 47.7, 48.5).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { confirmPairing } from "./pairing";
import type { PairDeps } from "./pairing";
import { accountLabel, shortAddress } from "./status";
import { applyServerMessage, applySocketEvent, initialState } from "./store";
import type { SessionInfo } from "./store";

const ADDRESS = "AbCdEfGhJkLmNpQrStUvWxYz123456789abcdWxYz";

describe("session and auth notices in the store", () => {
  test("session switches guest -> wallet -> guest, each replacing the last", () => {
    let state = applyServerMessage(initialState(), { type: "session", account_id: "guest", address: null });
    expect(state.session).toEqual({ accountId: "guest", address: null });
    state = applyServerMessage(state, { type: "session", account_id: `w_${ADDRESS}`, address: ADDRESS });
    expect(state.session).toEqual({ accountId: `w_${ADDRESS}`, address: ADDRESS });
    state = applyServerMessage(state, { type: "session", account_id: "guest", address: null });
    expect(state.session).toEqual({ accountId: "guest", address: null });
  });

  for (const kind of ["auth_failed", "session_expired", "signed_out"] as const) {
    test(`${kind} is recorded as a notice and leaves the session to the next session message`, () => {
      let state = applyServerMessage(initialState(), { type: "session", account_id: `w_${ADDRESS}`, address: ADDRESS });
      state = applyServerMessage(state, { type: "notice", kind, message: `msg ${kind}` });
      expect(state.notices).toEqual([{ kind, message: `msg ${kind}` }]);
      // The reducer stays pure; the server follows these notices with a guest `session`.
      expect(state.session).toEqual({ accountId: `w_${ADDRESS}`, address: ADDRESS });
      state = applyServerMessage(state, { type: "session", account_id: "guest", address: null });
      expect(state.session).toEqual({ accountId: "guest", address: null });
      expect(state.notices).toHaveLength(1);
    });
  }

  test("auth notices keep their order among other notices", () => {
    let state = initialState();
    for (const kind of ["engine_down", "auth_failed", "session_expired", "signed_out", "engine_up"] as const) {
      state = applyServerMessage(state, { type: "notice", kind, message: kind });
    }
    expect(state.notices.map((n) => n.kind)).toEqual([
      "engine_down",
      "auth_failed",
      "session_expired",
      "signed_out",
      "engine_up",
    ]);
  });

  test("a reconnect clears the session until the new connection authenticates", () => {
    let state = applyServerMessage(initialState(), { type: "session", account_id: `w_${ADDRESS}`, address: ADDRESS });
    state = applySocketEvent(state, { type: "open" });
    expect(state.session).toBeNull();
  });
});

describe("address shortening", () => {
  test("keeps the first 4 and last 4 characters around a single ellipsis character", () => {
    const short = shortAddress(ADDRESS);
    expect(short).toBe("AbCd…WxYz");
    expect([...short]).toHaveLength(9);
  });

  test("boundaries: empty, 8, 9 unchanged; 10 shortened", () => {
    expect(shortAddress("")).toBe("");
    expect(shortAddress("12345678")).toBe("12345678");
    expect(shortAddress("123456789")).toBe("123456789");
    expect(shortAddress("1234567890")).toBe("1234…7890");
  });

  test("a 44-character address is shortened", () => {
    expect(shortAddress("1".repeat(44))).toBe("1111…1111");
  });

  test("accountLabel: dash, GUEST, address, and account id fallback", () => {
    expect(accountLabel(null)).toBe("—");
    expect(accountLabel({ accountId: "guest", address: null } as SessionInfo)).toBe("GUEST");
    expect(accountLabel({ accountId: `w_${ADDRESS}`, address: ADDRESS } as SessionInfo)).toBe("AbCd…WxYz");
    expect(accountLabel({ accountId: `w_${ADDRESS}`, address: null } as SessionInfo)).toBe(shortAddress(`w_${ADDRESS}`));
  });
});

describe("/pair sends nothing until Confirm (Req 48.5)", () => {
  function deps(token: string | null): { deps: PairDeps; urls: string[] } {
    const urls: string[] = [];
    return {
      urls,
      deps: {
        apiUrl: "http://api.test",
        token,
        fetch: async (url) => {
          urls.push(url);
          return { status: 204 };
        },
      },
    };
  }

  test("confirmPairing sends nothing without a token or with a bad code", async () => {
    for (const token of [null, ""]) {
      const { deps: d, urls } = deps(token);
      expect(await confirmPairing("ABCD2345", d)).toEqual({ ok: false, reason: "not_signed_in" });
      expect(urls).toEqual([]);
    }
    const { deps: d, urls } = deps("tok");
    expect(await confirmPairing("ABCD234O", d)).toEqual({ ok: false, reason: "rejected" });
    expect(urls).toEqual([]);
  });

  // The page component is not separable from React, so its contract is checked on the source:
  // confirmPairing (and fetch) are reachable only through onConfirm, which only the Confirm
  // button's onClick calls. Nothing runs on mount except reading the stored session.
  const page = readFileSync(join(import.meta.dir, "..", "app", "pair", "page.tsx"), "utf8");

  test("the page calls confirmPairing once, inside onConfirm", () => {
    expect(page.match(/\bconfirmPairing\(/g)).toHaveLength(1);
    const handlerStart = page.indexOf("async function onConfirm");
    expect(handlerStart).toBeGreaterThan(-1);
    expect(page.indexOf("confirmPairing(")).toBeGreaterThan(handlerStart);
  });

  test("the only network call is the fetch passed to confirmPairing", () => {
    expect(page.match(/\bfetch\(/g)).toHaveLength(1);
    expect(page.indexOf("fetch(")).toBeGreaterThan(page.indexOf("async function onConfirm"));
  });

  test("onConfirm is called only from the button's onClick, never from an effect", () => {
    expect(page.match(/\bonConfirm\(/g)).toHaveLength(2); // the definition and the click handler
    expect(page).toMatch(/onClick=\{\(\) => void onConfirm\(code\)\}/);
    const effects = [...page.matchAll(/useEffect\(([\s\S]*?)\}, \[[^\]]*\]\)/g)].map((m) => m[1] ?? "");
    expect(effects.length).toBeGreaterThan(0);
    for (const body of effects) {
      expect(body).not.toContain("onConfirm");
      expect(body).not.toContain("confirmPairing");
      expect(body).not.toContain("fetch");
    }
  });

  test("the Confirm button is disabled until signed in, and the warning is shown", () => {
    expect(page).toContain("disabled={!canConfirm}");
    expect(page).toContain("const canConfirm = session !== null");
    expect(page).toContain("Only confirm a code shown in your own terminal");
  });
});
