// Pure reducers of the Web UI store (design §5, Req 33).
import { beforeEach, describe, expect, test } from "bun:test";
import type { Bar, Event, ServerMessage } from "../../shared/protocol/index";
import {
  MAX_CANDLES,
  MAX_NOTICES,
  MAX_TAPE,
  applyEvent,
  applyServerMessage,
  applySocketEvent,
  candleKey,
  initialState,
  mergeBar,
  useTerminalStore,
  withSymbol,
  withTimeframe,
  type TerminalState,
} from "./store";

function bar(t: number, close = "100"): Bar {
  return { t, open: "100", high: "110", low: "90", close, volume: "5" };
}

function bars(from: number, count: number): Bar[] {
  return Array.from({ length: count }, (_, i) => bar(from + i));
}

function candle(
  symbol: string,
  timeframe: "1m" | "5m",
  snapshot: boolean,
  list: Bar[],
): ServerMessage {
  return { type: "event", event: { type: "candle", symbol, timeframe, snapshot, bars: list } };
}

function trade(ts: number, symbol = "BTC-USD", price = "6400012"): ServerMessage {
  return {
    type: "event",
    event: { type: "trade", symbol, price, qty: "1000000", side: "buy", ts },
  };
}

const HELLO: ServerMessage = {
  type: "hello",
  protocol_version: 2,
  data_mode: "live",
  venue: "backpack",
  engine_running: true,
  instruments: [
    { symbol: "BTC-USD", short: "BTC", price_decimals: 2, qty_decimals: 8 },
    { symbol: "ETH-USD", short: "ETH", price_decimals: 2, qty_decimals: 8 },
  ],
};

function times(list: readonly Bar[] | undefined): number[] {
  return (list ?? []).map((b) => b.t);
}

describe("initial state", () => {
  test("selects BTC-USD 1m and starts connecting", () => {
    const state = initialState();
    expect(state.selection).toEqual({ symbol: "BTC-USD", timeframe: "1m" });
    expect(state.connection).toEqual({ kind: "connecting", attempt: 1 });
    expect(state.hello).toBeNull();
    expect(state.session).toBeNull();
    expect(state.tape).toEqual([]);
    expect(state.badFrames).toBe(0);
    expect(state.lastError).toBeNull();
  });
});

describe("hello and session", () => {
  test("hello stores the server info and the instrument table", () => {
    const state = applyServerMessage(initialState(), HELLO);
    expect(state.hello).toEqual({
      protocolVersion: 2,
      dataMode: "live",
      venue: "backpack",
      engineRunning: true,
    });
    expect(Object.keys(state.instruments)).toEqual(["BTC-USD", "ETH-USD"]);
    expect(state.instruments["BTC-USD"]?.price_decimals).toBe(2);
  });

  test("a later hello replaces the instrument table", () => {
    const first = applyServerMessage(initialState(), HELLO);
    const second = applyServerMessage(first, {
      type: "hello",
      protocol_version: 2,
      data_mode: "replay",
      venue: null,
      engine_running: false,
      instruments: [{ symbol: "SOL-USD", short: "SOL", price_decimals: 2, qty_decimals: 8 }],
    });
    expect(Object.keys(second.instruments)).toEqual(["SOL-USD"]);
    expect(second.hello?.dataMode).toBe("replay");
    expect(second.hello?.venue).toBeNull();
  });

  test("session stores the account and address", () => {
    const guest = applyServerMessage(initialState(), {
      type: "session",
      account_id: "guest",
      address: null,
    });
    expect(guest.session).toEqual({ accountId: "guest", address: null });
    const wallet = applyServerMessage(guest, {
      type: "session",
      account_id: "w_abc",
      address: "abc",
    });
    expect(wallet.session).toEqual({ accountId: "w_abc", address: "abc" });
  });
});

describe("candles", () => {
  test("a snapshot replaces the list for its symbol and timeframe only", () => {
    let state = applyServerMessage(initialState(), candle("BTC-USD", "1m", true, [bar(1), bar(2)]));
    state = applyServerMessage(state, candle("BTC-USD", "5m", true, [bar(10)]));
    state = applyServerMessage(state, candle("BTC-USD", "1m", true, [bar(5), bar(6), bar(7)]));
    expect(times(state.candles[candleKey("BTC-USD", "1m")])).toEqual([5, 6, 7]);
    expect(times(state.candles[candleKey("BTC-USD", "5m")])).toEqual([10]);
  });

  test("a snapshot keeps only the newest 500 bars", () => {
    const state = applyServerMessage(
      initialState(),
      candle("BTC-USD", "1m", true, bars(0, MAX_CANDLES + 100)),
    );
    const list = state.candles[candleKey("BTC-USD", "1m")] ?? [];
    expect(list).toHaveLength(MAX_CANDLES);
    expect(list[0]?.t).toBe(100);
    expect(list[list.length - 1]?.t).toBe(MAX_CANDLES + 99);
  });

  test("a live bar with the same t replaces the last bar", () => {
    let state = applyServerMessage(initialState(), candle("BTC-USD", "1m", true, [bar(1), bar(2)]));
    state = applyServerMessage(state, candle("BTC-USD", "1m", false, [bar(2, "105")]));
    const list = state.candles[candleKey("BTC-USD", "1m")] ?? [];
    expect(times(list)).toEqual([1, 2]);
    expect(list[1]?.close).toBe("105");
  });

  test("a live bar with a newer t is appended", () => {
    let state = applyServerMessage(initialState(), candle("BTC-USD", "1m", true, [bar(1)]));
    state = applyServerMessage(state, candle("BTC-USD", "1m", false, [bar(2), bar(3)]));
    expect(times(state.candles[candleKey("BTC-USD", "1m")])).toEqual([1, 2, 3]);
  });

  test("a live bar with no snapshot yet starts the list", () => {
    const state = applyServerMessage(initialState(), candle("ETH-USD", "1m", false, [bar(7)]));
    expect(times(state.candles[candleKey("ETH-USD", "1m")])).toEqual([7]);
  });

  test("an older live bar replaces its match or is inserted in order", () => {
    const base = [bar(1), bar(3), bar(5)];
    expect(times(mergeBar(base, bar(3, "999")))).toEqual([1, 3, 5]);
    expect(mergeBar(base, bar(3, "999"))[1]?.close).toBe("999");
    expect(times(mergeBar(base, bar(4)))).toEqual([1, 3, 4, 5]);
    expect(times(mergeBar(base, bar(0)))).toEqual([0, 1, 3, 5]);
  });

  test("live bars never push the list past 500", () => {
    let state = applyServerMessage(initialState(), candle("BTC-USD", "1m", true, bars(0, MAX_CANDLES)));
    state = applyServerMessage(state, candle("BTC-USD", "1m", false, [bar(MAX_CANDLES)]));
    const list = state.candles[candleKey("BTC-USD", "1m")] ?? [];
    expect(list).toHaveLength(MAX_CANDLES);
    expect(list[0]?.t).toBe(1);
    expect(list[list.length - 1]?.t).toBe(MAX_CANDLES);
  });

  test("a merge does not change the previous state", () => {
    const before = applyServerMessage(initialState(), candle("BTC-USD", "1m", true, [bar(1)]));
    const beforeList = before.candles[candleKey("BTC-USD", "1m")];
    applyServerMessage(before, candle("BTC-USD", "1m", false, [bar(1, "1"), bar(2)]));
    expect(before.candles[candleKey("BTC-USD", "1m")]).toBe(beforeList);
    expect(times(beforeList)).toEqual([1]);
    expect(beforeList?.[0]?.close).toBe("100");
  });

  test("a candle event without a bars array does not throw", () => {
    const bad = { type: "candle", symbol: "BTC-USD", timeframe: "1m", snapshot: true } as unknown as Event;
    const state = applyEvent(initialState(), bad);
    expect(state.candles[candleKey("BTC-USD", "1m")]).toEqual([]);
  });
});

describe("trades and tape", () => {
  test("a trade sets the last trade for its symbol and goes on top of the tape", () => {
    let state = applyServerMessage(initialState(), trade(1, "BTC-USD", "6400012"));
    state = applyServerMessage(state, trade(2, "ETH-USD", "350000"));
    state = applyServerMessage(state, trade(3, "BTC-USD", "6400100"));
    expect(state.lastTrade["BTC-USD"]?.price).toBe("6400100");
    expect(state.lastTrade["ETH-USD"]?.price).toBe("350000");
    expect(state.tape.map((t) => t.ts)).toEqual([3, 2, 1]);
    expect(state.tape[0]).toEqual({
      symbol: "BTC-USD",
      price: "6400100",
      qty: "1000000",
      side: "buy",
      ts: 3,
    });
  });

  test("the tape keeps the newest 200 trades", () => {
    let state = initialState();
    for (let ts = 0; ts < MAX_TAPE + 50; ts += 1) state = applyServerMessage(state, trade(ts));
    expect(state.tape).toHaveLength(MAX_TAPE);
    expect(state.tape[0]?.ts).toBe(MAX_TAPE + 49);
    expect(state.tape[MAX_TAPE - 1]?.ts).toBe(50);
  });
});

describe("notices, errors, and ignored messages", () => {
  test("notices are appended in order and capped", () => {
    let state = initialState();
    for (let i = 0; i < MAX_NOTICES + 5; i += 1) {
      state = applyServerMessage(state, { type: "notice", kind: "engine_down", message: `n${i}` });
    }
    expect(state.notices).toHaveLength(MAX_NOTICES);
    expect(state.notices[0]?.message).toBe("n5");
    expect(state.notices[MAX_NOTICES - 1]?.message).toBe(`n${MAX_NOTICES + 4}`);
    expect(state.notices[0]?.kind).toBe("engine_down");
  });

  test("a server error event sets lastError", () => {
    const state = applyServerMessage(initialState(), {
      type: "event",
      event: { type: "error", code: "unknown_symbol", message: "no such symbol" },
    });
    expect(state.lastError).toBe("server error unknown_symbol: no such symbol");
  });

  // Book events used to be listed here; the book panel now stores them (store.book.test.ts).
  test("heartbeat, pong, and a parse error for another request leave the state alone", () => {
    const state = applyServerMessage(initialState(), HELLO);
    const ignored: ServerMessage[] = [
      { type: "event", event: { type: "heartbeat", ts: 1 } },
      { type: "event", event: { type: "pong", id: 1 } },
      { type: "pong", id: 1 },
      { type: "parse_error", request_id: "r", message: "bad", position: 0 },
    ];
    for (const message of ignored) expect(applyServerMessage(state, message)).toBe(state);
  });
});

describe("connection events", () => {
  test("connecting with no delay is `connecting`, with a delay is `waking`", () => {
    let state = applySocketEvent(initialState(), { type: "connecting", attempt: 1, nextDelayMs: 0 });
    expect(state.connection).toEqual({ kind: "connecting", attempt: 1 });
    state = applySocketEvent(state, { type: "connecting", attempt: 3, nextDelayMs: 500 });
    expect(state.connection).toEqual({ kind: "waking", attempt: 3, nextDelayMs: 500 });
  });

  test("open marks the connection connected and clears hello and session", () => {
    let state = applyServerMessage(initialState(), HELLO);
    state = applyServerMessage(state, { type: "session", account_id: "guest", address: null });
    state = applySocketEvent(state, { type: "open" });
    expect(state.connection).toEqual({ kind: "connected" });
    expect(state.hello).toBeNull();
    expect(state.session).toBeNull();
  });

  test("open keeps candles, instruments, and the tape", () => {
    let state = applyServerMessage(initialState(), HELLO);
    state = applyServerMessage(state, candle("BTC-USD", "1m", true, [bar(1)]));
    state = applyServerMessage(state, trade(1));
    const after = applySocketEvent(state, { type: "open" });
    expect(after.candles).toBe(state.candles);
    expect(after.instruments).toBe(state.instruments);
    expect(after.tape).toBe(state.tape);
  });

  test("closed marks the connection disconnected and records the reason", () => {
    const state = applySocketEvent(initialState(), { type: "closed", reason: "connection closed (1006)" });
    expect(state.connection).toEqual({ kind: "disconnected", reason: "connection closed (1006)" });
    expect(state.lastError).toBe("connection closed (1006)");
  });

  test("a bad frame is counted and recorded", () => {
    let state = applySocketEvent(initialState(), { type: "bad_frame", error: "invalid JSON" });
    state = applySocketEvent(state, { type: "bad_frame", error: "frame has no string type" });
    expect(state.badFrames).toBe(2);
    expect(state.lastError).toBe("bad frame: frame has no string type");
  });

  test("a message event applies the server message", () => {
    const state = applySocketEvent(initialState(), { type: "message", message: HELLO });
    expect(state.hello?.protocolVersion).toBe(2);
  });
});

describe("selection", () => {
  test("withSymbol and withTimeframe change one field each", () => {
    const state = withTimeframe(withSymbol(initialState(), "ETH-USD"), "1h");
    expect(state.selection).toEqual({ symbol: "ETH-USD", timeframe: "1h" });
  });

  test("selecting the current value returns the same state", () => {
    const state = initialState();
    expect(withSymbol(state, "BTC-USD")).toBe(state);
    expect(withTimeframe(state, "1m")).toBe(state);
  });
});

describe("useTerminalStore", () => {
  beforeEach(() => {
    useTerminalStore.setState(initialState());
  });

  test("starts from the initial state with its actions", () => {
    const state = useTerminalStore.getState();
    expect(state.selection).toEqual({ symbol: "BTC-USD", timeframe: "1m" });
    expect(typeof state.handleSocketEvent).toBe("function");
  });

  test("handleSocketEvent applies socket events", () => {
    useTerminalStore.getState().handleSocketEvent({ type: "open" });
    useTerminalStore.getState().handleSocketEvent({ type: "message", message: HELLO });
    const state: TerminalState = useTerminalStore.getState();
    expect(state.connection.kind).toBe("connected");
    expect(state.hello?.venue).toBe("backpack");
  });

  test("selectSymbol and selectTimeframe update the selection", () => {
    useTerminalStore.getState().selectSymbol("SOL-USD");
    useTerminalStore.getState().selectTimeframe("15m");
    expect(useTerminalStore.getState().selection).toEqual({ symbol: "SOL-USD", timeframe: "15m" });
  });
});
