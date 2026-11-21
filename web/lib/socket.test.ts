// Req 33.1-33.3: reconnect with capped backoff, resubscribe, ping. Uses a fake WebSocket and a
// manual scheduler, so no test sleeps or opens a connection.
import { describe, expect, test } from "bun:test";
import {
  MAX_FRAME_CHARS,
  PING_INTERVAL_MS,
  createTerminalSocket,
  parseFrame,
  type SocketDeps,
  type SocketEvent,
} from "./socket";
import { FakeNetwork, ManualScheduler } from "./testing";

type Connecting = Extract<SocketEvent, { type: "connecting" }>;

const HELLO_TEXT = JSON.stringify({
  type: "hello",
  protocol_version: 3,
  data_mode: "replay",
  live_venues: [],
  venue_status: [],
  default_venue: "replay",
  starting_balance: "1000000000000000",
  engine_running: true,
  instruments: [],
  providers: [],
  news_enabled: false,
});

function setup(url = "ws://localhost:8080/ws") {
  const scheduler = new ManualScheduler();
  const net = new FakeNetwork();
  const events: SocketEvent[] = [];
  const socket = createTerminalSocket(url, {
    onEvent: (event) => events.push(event),
    createWebSocket: net.create,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
  });
  return { scheduler, net, events, socket };
}

function connectings(events: readonly SocketEvent[]): Connecting[] {
  return events.filter((event): event is Connecting => event.type === "connecting");
}

function lastConnecting(events: readonly SocketEvent[]): Connecting {
  const last = connectings(events).at(-1);
  if (last === undefined) throw new Error("no connecting event");
  return last;
}

function sub(symbol: string, timeframe: string): unknown {
  return { type: "subscribe", venue: "replay", symbol, timeframe };
}

describe("parseFrame", () => {
  test("accepts a JSON object with a string type", () => {
    const result = parseFrame('{"type":"pong","id":3}');
    expect(result).toEqual({ ok: true, message: { type: "pong", id: 3 } });
  });

  test.each([
    ["not json"],
    ["[]"],
    ["null"],
    ['"text"'],
    ["42"],
    ['{"x":1}'],
    ['{"type":5}'],
    [""],
  ])("rejects the text frame %p", (text) => {
    expect(parseFrame(text).ok).toBe(false);
  });

  test("rejects binary frames and oversized frames", () => {
    expect(parseFrame(new Uint8Array([1, 2, 3]))).toEqual({
      ok: false,
      error: "unexpected binary frame",
    });
    expect(parseFrame(`{"type":"pong","pad":"${"x".repeat(MAX_FRAME_CHARS)}"}`).ok).toBe(false);
  });
});

describe("createTerminalSocket: connecting", () => {
  test("starts attempt 1 at once, with no delay", () => {
    const { net, events } = setup("ws://example.test/ws");
    expect(events).toEqual([{ type: "connecting", attempt: 1, nextDelayMs: 0 }]);
    expect(net.sockets).toHaveLength(1);
    expect(net.last.url).toBe("ws://example.test/ws");
  });

  test("open reports `open` and isOpen", () => {
    const { net, events, socket } = setup();
    expect(socket.isOpen()).toBe(false);
    net.last.open();
    expect(events.at(-1)).toEqual({ type: "open" });
    expect(socket.isOpen()).toBe(true);
  });

  test("a lost connection reports why, then the next attempt", () => {
    const { net, events } = setup();
    net.last.open();
    net.last.fail("going away", 1001);
    expect(events.at(-2)).toEqual({ type: "closed", reason: "connection closed (1001): going away" });
    expect(events.at(-1)).toEqual({ type: "connecting", attempt: 2, nextDelayMs: 250 });
  });

  test("a failed first attempt is retried", () => {
    const { net, events, scheduler } = setup();
    net.last.fail();
    expect(events.at(-2)).toEqual({ type: "closed", reason: "connection closed (1006)" });
    scheduler.advance(250);
    expect(net.sockets).toHaveLength(2);
  });

  test("retries wait 250 ms, double, and stop at 10 s (Req 33.2)", () => {
    const { net, events, scheduler } = setup();
    const delays: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      net.last.fail();
      const next = lastConnecting(events);
      expect(next.attempt).toBe(i + 2);
      delays.push(next.nextDelayMs);
      scheduler.advance(next.nextDelayMs);
    }
    expect(delays).toEqual([250, 500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
    expect(net.sockets).toHaveLength(10);
  });

  test("the next socket is created only when the delay has passed", () => {
    const { net, scheduler } = setup();
    net.last.fail();
    scheduler.advance(249);
    expect(net.sockets).toHaveLength(1);
    scheduler.advance(1);
    expect(net.sockets).toHaveLength(2);
  });

  test("a constructor that throws counts as a failed attempt", () => {
    const scheduler = new ManualScheduler();
    const events: SocketEvent[] = [];
    let creates = 0;
    const deps: SocketDeps = {
      onEvent: (event) => events.push(event),
      createWebSocket: () => {
        creates += 1;
        throw new Error("bad url");
      },
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
    };
    createTerminalSocket("ws://x/ws", deps);
    expect(events).toEqual([
      { type: "connecting", attempt: 1, nextDelayMs: 0 },
      { type: "closed", reason: "bad url" },
      { type: "connecting", attempt: 2, nextDelayMs: 250 },
    ]);
    scheduler.advance(250);
    expect(creates).toBe(2);
    expect(lastConnecting(events)).toEqual({ type: "connecting", attempt: 3, nextDelayMs: 500 });
  });
});

describe("createTerminalSocket: backoff reset", () => {
  test("hello resets the delay and the attempt count", () => {
    const { net, events, scheduler } = setup();
    net.last.fail();
    scheduler.advance(250);
    net.last.fail();
    scheduler.advance(500);
    net.last.open();
    net.last.receive(HELLO_TEXT);
    net.last.fail();
    expect(lastConnecting(events)).toEqual({ type: "connecting", attempt: 1, nextDelayMs: 250 });
  });

  test("an open without hello does not reset the delay", () => {
    const { net, events, scheduler } = setup();
    net.last.fail();
    scheduler.advance(250);
    net.last.open();
    net.last.fail();
    expect(lastConnecting(events)).toEqual({ type: "connecting", attempt: 3, nextDelayMs: 500 });
  });

  test("hello is passed on as a message", () => {
    const { net, events } = setup();
    net.last.open();
    net.last.receive(HELLO_TEXT);
    const last = events.at(-1);
    expect(last?.type).toBe("message");
    if (last?.type === "message") expect(last.message.type).toBe("hello");
  });
});

describe("createTerminalSocket: subscriptions", () => {
  test("subscriptions made before the socket opens are sent on open, deduplicated", () => {
    const { net, socket } = setup();
    socket.subscribe("BTC-USD", "1m");
    socket.subscribe("ETH-USD", "5m");
    socket.subscribe("BTC-USD", "1m");
    expect(net.last.sent).toEqual([]);
    net.last.open();
    expect(net.last.sentMessages()).toEqual([sub("BTC-USD", "1m"), sub("ETH-USD", "5m")]);
  });

  test("a subscription made while open goes out at once", () => {
    const { net, socket } = setup();
    net.last.open();
    socket.subscribe("SOL-USD", "1h");
    expect(net.last.sentMessages()).toEqual([sub("SOL-USD", "1h")]);
  });

  test("every reconnect resends the current set (Req 33.3)", () => {
    const { net, socket, scheduler } = setup();
    socket.subscribe("BTC-USD", "1m");
    net.last.open();
    socket.subscribe("ETH-USD", "5m");
    socket.unsubscribe("BTC-USD", "1m");
    expect(net.last.sentMessages()).toEqual([
      sub("BTC-USD", "1m"),
      sub("ETH-USD", "5m"),
      { type: "unsubscribe", venue: "replay", symbol: "BTC-USD", timeframe: "1m" },
    ]);

    net.last.fail();
    scheduler.advance(250);
    socket.subscribe("SOL-USD", "1d");
    net.last.open();
    expect(net.sockets).toHaveLength(2);
    expect(net.last.sentMessages()).toEqual([sub("ETH-USD", "5m"), sub("SOL-USD", "1d")]);

    net.last.fail();
    scheduler.advance(500);
    net.last.open();
    expect(net.last.sentMessages()).toEqual([sub("ETH-USD", "5m"), sub("SOL-USD", "1d")]);
  });

  test("changing the selection while offline changes what is resent", () => {
    const { net, socket, scheduler } = setup();
    socket.subscribe("BTC-USD", "1m");
    net.last.open();
    net.last.fail();
    socket.unsubscribe("BTC-USD", "1m");
    socket.subscribe("ETH-USD", "15m");
    scheduler.advance(250);
    net.last.open();
    expect(net.last.sentMessages()).toEqual([sub("ETH-USD", "15m")]);
  });

  test("subscriptions() lists the set in the order added", () => {
    const { socket } = setup();
    socket.subscribe("BTC-USD", "1m");
    socket.subscribe("ETH-USD", "5m");
    socket.subscribe("BTC-USD", "1m");
    socket.unsubscribe("SOL-USD", "1d");
    expect(socket.subscriptions()).toEqual([
      { symbol: "BTC-USD", timeframe: "1m" },
      { symbol: "ETH-USD", timeframe: "5m" },
    ]);
  });
});

describe("createTerminalSocket: sending", () => {
  test("messages other than subscriptions are dropped while offline, not queued", () => {
    const { net, socket } = setup();
    expect(socket.send({ type: "ping", id: 1 })).toBe(false);
    expect(socket.send({ type: "cancel_all", request_id: "r1" })).toBe(false);
    net.last.open();
    expect(net.last.sent).toEqual([]);
  });

  test("send reports true when the message went out", () => {
    const { net, socket } = setup();
    net.last.open();
    expect(socket.send({ type: "cancel_all", request_id: "r1" })).toBe(true);
    expect(net.last.sentMessages()).toEqual([{ type: "cancel_all", request_id: "r1" }]);
  });
});

describe("createTerminalSocket: bad frames", () => {
  test("invalid frames are reported and skipped, and the connection stays up", () => {
    const { net, events, socket } = setup();
    net.last.open();
    net.last.receive("not json");
    net.last.receive("[]");
    net.last.receive('{"x":1}');
    net.last.receive('{"type":5}');
    net.last.receive(new Uint8Array([1, 2, 3]));
    net.last.receive(HELLO_TEXT);
    const types = events.map((event) => event.type);
    expect(types.filter((type) => type === "bad_frame")).toHaveLength(5);
    expect(types.at(-1)).toBe("message");
    expect(socket.isOpen()).toBe(true);
    expect(types.filter((type) => type === "closed")).toHaveLength(0);
  });
});

describe("createTerminalSocket: ping", () => {
  test("pings every 15 s while open, with increasing ids", () => {
    const { net, scheduler } = setup();
    expect(PING_INTERVAL_MS).toBe(15_000);
    net.last.open();
    scheduler.advance(14_999);
    expect(net.last.sent).toEqual([]);
    scheduler.advance(1);
    expect(net.last.sentMessages()).toEqual([{ type: "ping", id: 1 }]);
    scheduler.advance(15_000);
    expect(net.last.sentMessages()).toEqual([
      { type: "ping", id: 1 },
      { type: "ping", id: 2 },
    ]);
  });

  test("no ping before the socket opens", () => {
    const { net, scheduler } = setup();
    scheduler.advance(60_000);
    expect(net.last.sent).toEqual([]);
  });

  test("pings stop when the connection is lost and restart on the next open", () => {
    const { net, scheduler } = setup();
    const first = net.last;
    first.open();
    scheduler.advance(15_000);
    first.fail();
    scheduler.advance(250);
    const second = net.last;
    expect(second).not.toBe(first);
    scheduler.advance(60_000);
    expect(first.sentMessages()).toEqual([{ type: "ping", id: 1 }]);
    expect(second.sent).toEqual([]);

    second.open();
    scheduler.advance(15_000);
    expect(second.sentMessages()).toEqual([{ type: "ping", id: 2 }]);
  });
});

describe("createTerminalSocket: close", () => {
  test("close stops reconnecting", () => {
    const { net, events, socket, scheduler } = setup();
    net.last.fail();
    expect(scheduler.pending).toBe(1);
    const count = events.length;
    socket.close();
    expect(scheduler.pending).toBe(0);
    scheduler.advance(60_000);
    expect(net.sockets).toHaveLength(1);
    expect(events).toHaveLength(count);
  });

  test("close while open closes the socket, stops pings, and emits nothing", () => {
    const { net, events, socket, scheduler } = setup();
    net.last.open();
    const count = events.length;
    socket.close();
    expect(net.last.closeCalls).toBe(1);
    expect(socket.isOpen()).toBe(false);
    expect(scheduler.pending).toBe(0);
    scheduler.advance(60_000);
    expect(net.last.sent).toEqual([]);
    net.last.fail();
    expect(net.sockets).toHaveLength(1);
    expect(events).toHaveLength(count);
  });

  test("close is idempotent and later sends are dropped", () => {
    const { net, socket } = setup();
    net.last.open();
    socket.close();
    socket.close();
    expect(net.last.closeCalls).toBe(1);
    expect(socket.send({ type: "ping", id: 1 })).toBe(false);
    socket.subscribe("BTC-USD", "1m");
    expect(socket.subscriptions()).toEqual([]);
  });

  test("events from a socket that was replaced are ignored", () => {
    const { net, events, scheduler } = setup();
    const first = net.last;
    first.open();
    first.fail();
    scheduler.advance(250);
    const count = events.length;
    first.receive(HELLO_TEXT);
    first.fail();
    expect(events).toHaveLength(count);
    expect(net.sockets).toHaveLength(2);
  });
});
