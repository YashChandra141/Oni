// PreviewStore unit tests (Req 22.4, 46.4).
import { describe, expect, test } from "bun:test";
import type { ParsedCommand } from "./parser.ts";
import { MAX_PER_CONNECTION, MAX_PREVIEWS, PREVIEW_TTL_MS, PreviewStore, previewAction } from "./previews.ts";

const BUY: ParsedCommand = {
  kind: "place",
  side: "buy",
  symbol: "BTC-USD",
  qty: 10_000_000n,
  order: { type: "limit", price: 6_400_000n },
  source: "absolute",
};

function makeStore(options: { maxPreviews?: number; maxPerConnection?: number } = {}) {
  const clock = { now: 1_000_000 };
  let n = 0;
  const store = new PreviewStore({ now: () => clock.now, newId: () => `p${++n}`, ...options });
  return { store, clock };
}

describe("create", () => {
  test("returns the wire preview with a 60 s expiry", () => {
    const { store } = makeStore();
    expect(store.create("c1", "guest", BUY, "BUY BTC-USD 0.1 LMT 64000.00")).toEqual({
      preview_id: "p1",
      text: "BUY BTC-USD 0.1 LMT 64000.00",
      action: { type: "place", symbol: "BTC-USD", side: "buy", qty: "10000000", kind: { type: "limit", price: "6400000" } },
      expires_at: 1_000_000 + PREVIEW_TTL_MS,
    });
    expect(PREVIEW_TTL_MS).toBe(60_000);
  });

  test("previewAction covers every command", () => {
    expect(previewAction({ kind: "cancel_all" })).toEqual({ type: "cancel_all" });
    expect(previewAction({ kind: "flatten_all" })).toEqual({ type: "flatten_all" });
    expect(previewAction({ ...BUY, order: { type: "market" } })).toMatchObject({ kind: { type: "market" } });
    expect(previewAction({ ...BUY, order: { type: "stop", stopPrice: 5n } })).toMatchObject({ kind: { type: "stop", stop_price: "5" } });
  });
});

describe("take", () => {
  test("returns the command once (single use)", () => {
    const { store } = makeStore();
    const p = store.create("c1", "guest", BUY, "t");
    expect(store.take(p.preview_id, "c1", "guest")).toEqual({ ok: true, command: BUY });
    expect(store.take(p.preview_id, "c1", "guest")).toEqual({ ok: false, error: "unknown_preview" });
    expect(store.size).toBe(0);
  });

  test("an unknown id is unknown_preview", () => {
    const { store } = makeStore();
    expect(store.take("nope", "c1", "guest")).toEqual({ ok: false, error: "unknown_preview" });
  });

  test("valid just before 60 s, expired at exactly 60 s", () => {
    const a = makeStore();
    const pa = a.store.create("c1", "guest", BUY, "t");
    a.clock.now += PREVIEW_TTL_MS - 1;
    expect(a.store.take(pa.preview_id, "c1", "guest").ok).toBe(true);

    const b = makeStore();
    const pb = b.store.create("c1", "guest", BUY, "t");
    b.clock.now += PREVIEW_TTL_MS;
    expect(b.store.take(pb.preview_id, "c1", "guest")).toEqual({ ok: false, error: "expired" });
    expect(b.store.size).toBe(0);
  });

  test("another connection cannot take it, and the owner still can", () => {
    const { store } = makeStore();
    const p = store.create("c1", "guest", BUY, "t");
    expect(store.take(p.preview_id, "c2", "guest")).toEqual({ ok: false, error: "wrong_connection" });
    expect(store.take(p.preview_id, "c1", "guest").ok).toBe(true);
  });

  test("a different current account is account_changed, and the preview is gone", () => {
    const { store } = makeStore();
    const p = store.create("c1", "guest", BUY, "t");
    expect(store.take(p.preview_id, "c1", "w_Abc")).toEqual({ ok: false, error: "account_changed" });
    expect(store.take(p.preview_id, "c1", "guest")).toEqual({ ok: false, error: "unknown_preview" });
  });
});

describe("discard", () => {
  test("only the owner can discard", () => {
    const { store } = makeStore();
    const p = store.create("c1", "guest", BUY, "t");
    expect(store.discard(p.preview_id, "c2")).toBe(false);
    expect(store.discard(p.preview_id, "c1")).toBe(true);
    expect(store.discard(p.preview_id, "c1")).toBe(false);
    expect(store.take(p.preview_id, "c1", "guest")).toEqual({ ok: false, error: "unknown_preview" });
  });

  test("discardForConnection drops that connection's previews only", () => {
    const { store } = makeStore();
    const a1 = store.create("c1", "guest", BUY, "t");
    const a2 = store.create("c1", "guest", BUY, "t");
    const b = store.create("c2", "guest", BUY, "t");
    expect(store.discardForConnection("c1")).toBe(2);
    expect(store.discardForConnection("c1")).toBe(0);
    expect(store.take(a1.preview_id, "c1", "guest").ok).toBe(false);
    expect(store.take(a2.preview_id, "c1", "guest").ok).toBe(false);
    expect(store.take(b.preview_id, "c2", "guest").ok).toBe(true);
    expect(store.countFor("c1")).toBe(0);
  });
});

describe("bounds", () => {
  test("expired previews are pruned on create", () => {
    const { store, clock } = makeStore();
    store.create("c1", "guest", BUY, "t");
    store.create("c2", "guest", BUY, "t");
    clock.now += PREVIEW_TTL_MS;
    store.create("c3", "guest", BUY, "t");
    expect(store.size).toBe(1);
  });

  test("per-connection cap drops that connection's oldest", () => {
    const { store } = makeStore();
    const ids: string[] = [];
    for (let i = 0; i < MAX_PER_CONNECTION + 1; i++) ids.push(store.create("c1", "guest", BUY, "t").preview_id);
    expect(store.countFor("c1")).toBe(MAX_PER_CONNECTION);
    expect(store.take(ids[0] ?? "", "c1", "guest")).toEqual({ ok: false, error: "unknown_preview" });
    expect(store.take(ids[MAX_PER_CONNECTION] ?? "", "c1", "guest").ok).toBe(true);
  });

  test("global cap drops the oldest preview overall", () => {
    const { store } = makeStore({ maxPreviews: 3, maxPerConnection: 10 });
    const p1 = store.create("c1", "guest", BUY, "t");
    store.create("c2", "guest", BUY, "t");
    store.create("c3", "guest", BUY, "t");
    const p4 = store.create("c4", "guest", BUY, "t");
    expect(store.size).toBe(3);
    expect(store.take(p1.preview_id, "c1", "guest")).toEqual({ ok: false, error: "unknown_preview" });
    expect(store.take(p4.preview_id, "c4", "guest").ok).toBe(true);
  });

  test("default caps", () => {
    expect(MAX_PREVIEWS).toBe(1_000);
    expect(MAX_PER_CONNECTION).toBe(20);
  });
});
