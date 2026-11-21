// Task 2.5, Property 11: Preservation - Client display and interaction.
// Observation-first: `Model` below is a small reference of what the unfixed store does today for
// the candle, book, position, order, last-trade, and tape slices. The real reducers must equal it
// for any message sequence without Indicators events (indicator timing is what the fix changes).
// Tape entries are compared by content (symbol, price, qty, side, ts) because task 6.3 adds an id.
// Validates: Requirements 3.11, 3.12, 3.13
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Bar, Event, ServerMessage, Side, Timeframe } from "../../shared/protocol/index";
import {
  MAX_CANDLES,
  MAX_TAPE,
  applyServerMessage,
  candleKey,
  initialState,
  type TerminalState,
} from "./store";

const SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;
const FRAMES: readonly Timeframe[] = ["1m", "5m"];
const ACCOUNT = "guest";

interface TapeContent {
  symbol: string;
  price: string;
  qty: string;
  side: Side;
  ts: number;
}
interface ModelOrder {
  symbol: string | null;
  side: Side | null;
  qty: string;
  filled: string;
  remaining: string;
}
interface Model {
  candles: Map<string, Bar[]>;
  book: Map<string, Event & { type: "book" }>;
  positions: Map<string, Event & { type: "position" }>;
  realized: Map<string, string>;
  orders: Map<string, ModelOrder>;
  lastTrade: Map<string, TapeContent>;
  tape: TapeContent[];
}

function emptyModel(): Model {
  return {
    candles: new Map(),
    book: new Map(),
    positions: new Map(),
    realized: new Map(),
    orders: new Map(),
    lastTrade: new Map(),
    tape: [],
  };
}

function modelApply(m: Model, e: Event): void {
  switch (e.type) {
    case "candle": {
      const key = candleKey(e.symbol, e.timeframe);
      if (e.snapshot) {
        m.candles.set(key, e.bars.slice(-MAX_CANDLES));
        return;
      }
      const byT = new Map<number, Bar>((m.candles.get(key) ?? []).map((b) => [b.t, b]));
      for (const bar of e.bars) byT.set(bar.t, bar);
      const sorted = [...byT.values()].sort((a, b) => a.t - b.t);
      m.candles.set(key, sorted.slice(-MAX_CANDLES));
      return;
    }
    case "book":
      m.book.set(e.symbol, e);
      return;
    case "position":
      if (BigInt(e.qty) === 0n) m.positions.delete(e.symbol);
      else m.positions.set(e.symbol, e);
      m.realized.set(e.symbol, e.realized);
      return;
    case "order_ack":
      if (e.status !== "accepted") {
        m.orders.delete(e.order_id);
      } else if (!m.orders.has(e.order_id)) {
        m.orders.set(e.order_id, { symbol: null, side: null, qty: "0", filled: "0", remaining: "0" });
      }
      return;
    case "fill": {
      const o = m.orders.get(e.order_id);
      if (o === undefined) return;
      const filled = (BigInt(o.filled) + BigInt(e.qty)).toString();
      m.orders.set(e.order_id, {
        symbol: o.symbol ?? e.symbol,
        side: o.side ?? e.side,
        filled,
        remaining: e.remaining,
        qty: o.qty === "0" ? (BigInt(filled) + BigInt(e.remaining)).toString() : o.qty,
      });
      return;
    }
    case "trade": {
      const entry = { symbol: e.symbol, price: e.price, qty: e.qty, side: e.side, ts: e.ts };
      m.lastTrade.set(e.symbol, entry);
      m.tape = [entry, ...m.tape].slice(0, MAX_TAPE);
      return;
    }
    default:
      return;
  }
}

const content = (t: TapeContent): TapeContent => ({
  symbol: t.symbol,
  price: t.price,
  qty: t.qty,
  side: t.side,
  ts: t.ts,
});

function expectEqualToModel(s: TerminalState, m: Model): void {
  expect(s.candles).toEqual(Object.fromEntries(m.candles));
  expect(Object.keys(s.book).sort()).toEqual([...m.book.keys()].sort());
  for (const [sym, e] of m.book) {
    expect(s.book[sym]).toEqual({
      bids: e.bids,
      asks: e.asks,
      spread: e.spread,
      imbalanceBps: e.imbalance_bps,
      ts: e.ts,
    });
  }
  expect(s.positions).toEqual(
    Object.fromEntries(
      [...m.positions].map(([sym, e]) => [
        sym,
        { symbol: sym, qty: e.qty, avgEntry: e.avg_entry, realized: e.realized, unrealized: e.unrealized },
      ]),
    ),
  );
  expect(s.realizedBySymbol).toEqual(
    Object.fromEntries([...m.realized].map(([sym, realized]) => [sym, { realized }])),
  );
  expect(Object.keys(s.openOrders).sort()).toEqual([...m.orders.keys()].sort());
  for (const [id, o] of m.orders) {
    const row = s.openOrders[id];
    expect(row?.symbol).toBe(o.symbol);
    expect(row?.side).toBe(o.side);
    expect(row?.qty).toBe(o.qty);
    expect(row?.filled).toBe(o.filled);
    expect(row?.remaining).toBe(o.remaining);
  }
  // Watchlist prices come from the last trade per symbol.
  expect(Object.fromEntries(Object.entries(s.lastTrade).map(([k, v]) => [k, content(v)]))).toEqual(
    Object.fromEntries(m.lastTrade),
  );
  expect(s.tape.map(content)).toEqual(m.tape);
}

// ---- generators ----
const symbol = fc.constantFrom(...SYMBOLS);
const frame = fc.constantFrom(...FRAMES);
const int = (max: number) => fc.integer({ min: 1, max }).map(String);
const side = fc.constantFrom<Side>("buy", "sell");
const barArb = fc.record({
  t: fc.integer({ min: 0, max: 40 }).map((n) => n * 60_000),
  open: int(100_000),
  high: int(100_000),
  low: int(100_000),
  close: int(100_000),
  volume: int(1_000),
});
const levelArb = fc.record({ price: int(100_000), qty: int(1_000) });
const orderId = fc.constantFrom("o1", "o2", "o3");

const eventArb: fc.Arbitrary<Event> = fc.oneof(
  fc.record({
    type: fc.constant("candle" as const),
    symbol,
    timeframe: frame,
    snapshot: fc.boolean(),
    bars: fc
      .uniqueArray(barArb, { selector: (b) => b.t, maxLength: 12 })
      .map((bars) => bars.sort((a, b) => a.t - b.t)),
  }),
  fc.record({
    type: fc.constant("trade" as const),
    symbol,
    price: int(100_000),
    qty: int(1_000),
    side,
    ts: fc.integer({ min: 0, max: 10_000_000 }),
  }),
  fc.record({
    type: fc.constant("book" as const),
    symbol,
    bids: fc.array(levelArb, { maxLength: 5 }),
    asks: fc.array(levelArb, { maxLength: 5 }),
    spread: fc.option(int(100), { nil: null }),
    imbalance_bps: fc.integer({ min: -10_000, max: 10_000 }),
    ts: fc.integer({ min: 0, max: 10_000_000 }),
  }),
  fc.record({
    type: fc.constant("position" as const),
    account_id: fc.constant(ACCOUNT),
    symbol,
    qty: fc.integer({ min: -3, max: 3 }).map(String),
    avg_entry: fc.option(int(100_000), { nil: null }),
    realized: fc.integer({ min: -1000, max: 1000 }).map(String),
    unrealized: fc.integer({ min: -1000, max: 1000 }).map(String),
  }),
  fc.record({
    type: fc.constant("order_ack" as const),
    account_id: fc.constant(ACCOUNT),
    order_id: orderId,
    status: fc.constantFrom("accepted" as const, "canceled" as const, "filled" as const),
  }),
  fc.record({
    type: fc.constant("fill" as const),
    account_id: fc.constant(ACCOUNT),
    order_id: orderId,
    symbol,
    side,
    price: int(100_000),
    qty: int(100),
    fee: int(100),
    remaining: fc.integer({ min: 0, max: 100 }).map(String),
    ts: fc.integer({ min: 0, max: 10_000_000 }),
  }),
  fc.record({ type: fc.constant("heartbeat" as const), ts: fc.integer({ min: 0, max: 1000 }) }),
) as fc.Arbitrary<Event>;

const wrap = (event: Event): ServerMessage => ({ type: "event", event });

describe("store preservation (Property 11)", () => {
  test("candles, book, positions, orders, last trade, and tape equal the reference model", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 60 }), (events) => {
        let state = initialState();
        const model = emptyModel();
        for (const e of events) {
          state = applyServerMessage(state, wrap(e));
          modelApply(model, e);
        }
        expectEqualToModel(state, model);
      }),
      { numRuns: 200 },
    );
  });

  test("lastTrade matches the newest trade of each symbol for any trade sequence", () => {
    const trades = fc.array(
      eventArb.filter((e) => e.type === "trade"),
      { maxLength: 80 },
    );
    fc.assert(
      fc.property(trades, (events) => {
        let state = initialState();
        const newest = new Map<string, Event & { type: "trade" }>();
        for (const e of events) {
          state = applyServerMessage(state, wrap(e));
          if (e.type === "trade") newest.set(e.symbol, e);
        }
        for (const [sym, e] of newest) {
          expect(state.lastTrade[sym]).toMatchObject({
            symbol: sym,
            price: e.price,
            qty: e.qty,
            side: e.side,
            ts: e.ts,
          });
        }
        expect(Object.keys(state.lastTrade).sort()).toEqual([...newest.keys()].sort());
      }),
      { numRuns: 100 },
    );
  });

  test("tape is newest first and capped at MAX_TAPE", () => {
    let state = initialState();
    for (let i = 0; i < MAX_TAPE + 25; i += 1) {
      state = applyServerMessage(
        state,
        wrap({
          type: "trade",
          venue: "replay",
          symbol: "BTC-USD",
          price: String(i + 1),
          qty: "1",
          side: "buy",
          synthetic: false,
          ts: i,
        }),
      );
    }
    expect(state.tape.length).toBe(MAX_TAPE);
    expect(state.tape[0]?.ts).toBe(MAX_TAPE + 24);
    expect(state.tape[MAX_TAPE - 1]?.ts).toBe(25);
  });

  test("live candles keep at most MAX_CANDLES, newest kept", () => {
    let state = initialState();
    for (let i = 0; i < MAX_CANDLES + 20; i += 1) {
      const bar: Bar = { t: i * 60_000, open: "1", high: "2", low: "1", close: "2", volume: "1" };
      state = applyServerMessage(
        state,
        wrap({ type: "candle", venue: "replay", symbol: "BTC-USD", timeframe: "1m", snapshot: false, bars: [bar] }),
      );
    }
    const bars = state.candles[candleKey("BTC-USD", "1m")] ?? [];
    expect(bars.length).toBe(MAX_CANDLES);
    expect(bars[0]?.t).toBe(20 * 60_000);
  });
});
