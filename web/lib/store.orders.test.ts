// Account panels, previews, rejections, history, and dialogs of the Web UI store
// (Task 12.3, Req 22, 28, 30, 31). Pure reducers only.
import { describe, expect, test } from "bun:test";
import type { Event, OrderPreview, ServerMessage } from "../../shared/protocol/index";
import {
  MAX_FILLS,
  MAX_REJECTIONS,
  applyServerMessage,
  applySocketEvent,
  initialState,
  prefillTicketFromBook,
  withCommandSent,
  withConfirmCleared,
  withConfirmRequested,
  withPreviewCleared,
  withPreviewConfirmed,
  withRejectionsCleared,
  withSymbol,
  withTicketPrice,
  withTicketQty,
  type TerminalState,
} from "./store";

const guestSession: ServerMessage = { type: "session", account_id: "guest", address: null };

function event(e: Event): ServerMessage {
  return { type: "event", event: e };
}

function position(
  account: string,
  symbol: string,
  qty: string,
  avg: string | null,
  realized = "0",
  unrealized = "0",
): ServerMessage {
  return event({ type: "position", account_id: account, symbol, qty, avg_entry: avg, realized, unrealized });
}

function ack(account: string, orderId: string, status: "accepted" | "canceled" | "filled"): ServerMessage {
  return event({ type: "order_ack", account_id: account, venue: "replay", order_id: orderId, status });
}

function fill(account: string, orderId: string, qty: string, remaining: string): ServerMessage {
  return event({
    type: "fill",
    account_id: account,
    venue: "replay",
    order_id: orderId,
    symbol: "BTC-USD",
    side: "buy",
    price: "6400000",
    qty,
    fee: "100",
    remaining,
    ts: 1,
  });
}

function rejected(account: string, orderId: string, reason: string): ServerMessage {
  return event({ type: "order_rejected", account_id: account, venue: "replay", order_id: orderId, reason });
}

const PLACE_PREVIEW: OrderPreview = {
  preview_id: "p1",
  text: "BUY BTC-USD 0.1 LMT 64000.00",
  action: {
    type: "place",
    symbol: "BTC-USD",
    venue: "replay",
    side: "buy",
    qty: "10000000",
    kind: { type: "limit", price: "6400000" },
  },
  expires_at: 1_000_060_000,
};

function run(start: TerminalState, ...messages: ServerMessage[]): TerminalState {
  return messages.reduce(applyServerMessage, start);
}

function asGuest(): TerminalState {
  return applyServerMessage(initialState(), guestSession);
}

describe("positions (Req 28.1, 28.3)", () => {
  test("a position event sets the row and a later one replaces it", () => {
    let state = run(asGuest(), position("guest", "BTC-USD", "10000000", "6400000", "5", "7"));
    expect(state.positions["BTC-USD"]).toEqual({
      symbol: "BTC-USD",
      qty: "10000000",
      avgEntry: "6400000",
      realized: "5",
      unrealized: "7",
    });
    state = run(state, position("guest", "BTC-USD", "-20000000", "6500000", "9", "-3"));
    expect(Object.keys(state.positions)).toEqual(["BTC-USD"]);
    expect(state.positions["BTC-USD"]?.qty).toBe("-20000000");
    expect(state.positions["BTC-USD"]?.unrealized).toBe("-3");
  });

  test("a flat position drops the row but keeps its realized P&L", () => {
    let state = run(asGuest(), position("guest", "BTC-USD", "10", "100", "0", "1"));
    state = run(state, position("guest", "BTC-USD", "0", null, "42", "0"));
    expect(state.positions).toEqual({});
    expect(state.realizedBySymbol["BTC-USD"]).toEqual({ realized: "42" });
  });

  test("events of another account are ignored", () => {
    const state = asGuest();
    expect(run(state, position("w_other", "BTC-USD", "10", "100"))).toBe(state);
    expect(run(state, ack("w_other", "o-1", "accepted"))).toBe(state);
    expect(run(state, fill("w_other", "o-1", "1", "0"))).toBe(state);
    expect(run(state, rejected("w_other", "o-1", "kill_switch"))).toBe(state);
  });
});

describe("open orders and fills (Req 28.2, 28.3)", () => {
  function confirmedPlace(): TerminalState {
    let state = withCommandSent(asGuest(), "r1", "BUY BTC 0.1 LMT 64000");
    state = run(state, { type: "preview", request_id: "r1", preview: PLACE_PREVIEW });
    return withPreviewConfirmed(state);
  }

  test("an accepted ack opens a row labelled from the confirmed preview", () => {
    const state = run(confirmedPlace(), ack("guest", "o-1", "accepted"));
    expect(state.pendingPlacements).toEqual([]);
    expect(state.openOrders["o-1"]).toEqual({
      orderId: "o-1",
      symbol: "BTC-USD",
      side: "buy",
      kind: "limit",
      price: "6400000",
      qty: "10000000",
      filled: "0",
      remaining: "10000000",
    });
  });

  test("an ack with no known placement still opens a row", () => {
    const state = run(asGuest(), ack("guest", "o-9", "accepted"));
    expect(state.openOrders["o-9"]?.symbol).toBeNull();
    expect(state.openOrders["o-9"]?.kind).toBeNull();
  });

  test("fills update filled and remaining, and the filled ack closes the row", () => {
    let state = run(confirmedPlace(), ack("guest", "o-1", "accepted"));
    state = run(state, fill("guest", "o-1", "4000000", "6000000"));
    expect(state.openOrders["o-1"]?.filled).toBe("4000000");
    expect(state.openOrders["o-1"]?.remaining).toBe("6000000");
    state = run(state, fill("guest", "o-1", "6000000", "0"));
    expect(state.openOrders["o-1"]?.filled).toBe("10000000");
    expect(state.fills.length).toBe(2);
    state = run(state, ack("guest", "o-1", "filled"));
    expect(state.openOrders).toEqual({});
  });

  test("a canceled ack removes the row, and an unknown id changes nothing", () => {
    let state = run(asGuest(), ack("guest", "o-1", "accepted"));
    state = run(state, ack("guest", "o-1", "canceled"));
    expect(state.openOrders).toEqual({});
    expect(run(state, ack("guest", "o-2", "canceled"))).toBe(state);
  });

  test("a fill for an order with an unknown size derives it from filled + remaining", () => {
    let state = run(asGuest(), ack("guest", "o-1", "accepted"));
    state = run(state, fill("guest", "o-1", "3", "7"));
    expect(state.openOrders["o-1"]).toMatchObject({ qty: "10", filled: "3", remaining: "7", symbol: "BTC-USD", side: "buy" });
  });

  test("the fill list is capped and newest first", () => {
    let state = asGuest();
    for (let i = 0; i < MAX_FILLS + 5; i += 1) state = run(state, fill("guest", `o-${i}`, "1", "0"));
    expect(state.fills.length).toBe(MAX_FILLS);
    expect(state.fills[0]?.orderId).toBe(`o-${MAX_FILLS + 4}`);
  });
});

describe("preview and parse error (Req 22.1, 31.4)", () => {
  const PREVIEW: ServerMessage = { type: "preview", request_id: "r1", preview: PLACE_PREVIEW };

  test("a preview is kept only when its request id is the last one sent", () => {
    const idle = initialState();
    expect(applyServerMessage(idle, PREVIEW)).toBe(idle);
    const sent = withCommandSent(idle, "r1", "BUY BTC 0.1 LMT 64000");
    const shown = applyServerMessage(sent, PREVIEW);
    expect(shown.preview).toEqual({ requestId: "r1", preview: PLACE_PREVIEW });
    // A newer command makes the older answer stale.
    const newer = withCommandSent(sent, "r2", "FLAT");
    expect(applyServerMessage(newer, PREVIEW)).toBe(newer);
  });

  test("a parse error is kept only for the last request and replaces the preview", () => {
    const error: ServerMessage = { type: "parse_error", request_id: "r2", message: "unknown keyword", position: 4 };
    const state = withCommandSent(withCommandSent(initialState(), "r1", "A"), "r2", "BUY BT");
    expect(applyServerMessage(withCommandSent(initialState(), "r1", "A"), error).parseError).toBeNull();
    const shown = applyServerMessage(state, error);
    expect(shown.parseError).toEqual({ requestId: "r2", message: "unknown keyword", position: 4 });
    expect(shown.preview).toBeNull();
  });

  test("sending a command clears the old preview and parse error", () => {
    let state = withCommandSent(initialState(), "r1", "x");
    state = applyServerMessage(state, PREVIEW);
    state = withCommandSent(state, "r2", "FLAT");
    expect(state.preview).toBeNull();
    expect(state.parseError).toBeNull();
    expect(state.lastRequestId).toBe("r2");
  });

  test("confirming a place preview queues its placement and closes it", () => {
    let state = withCommandSent(initialState(), "r1", "x");
    state = applyServerMessage(state, PREVIEW);
    state = withPreviewConfirmed(state);
    expect(state.preview).toBeNull();
    expect(state.pendingPlacements).toEqual([
      { symbol: "BTC-USD", side: "buy", kind: "limit", price: "6400000", qty: "10000000" },
    ]);
  });

  test("confirming a flatten preview queues nothing; discard closes without queueing", () => {
    const flat: OrderPreview = { preview_id: "p2", text: "FLAT", action: { type: "flatten_all" }, expires_at: 1 };
    let state = withCommandSent(initialState(), "r1", "FLAT");
    state = applyServerMessage(state, { type: "preview", request_id: "r1", preview: flat });
    expect(withPreviewConfirmed(state).pendingPlacements).toEqual([]);
    expect(withPreviewCleared(state).preview).toBeNull();
    expect(withPreviewConfirmed(initialState())).toEqual(initialState());
  });
});

describe("rejections (Req 30.6)", () => {
  test("an order_rejected for this account is shown newest first and capped", () => {
    let state = asGuest();
    for (let i = 0; i < MAX_REJECTIONS + 3; i += 1) state = run(state, rejected("guest", `o-${i}`, "max_order_value"));
    expect(state.rejections.length).toBe(MAX_REJECTIONS);
    expect(state.rejections[0]).toEqual({ orderId: `o-${MAX_REJECTIONS + 2}`, reason: "max_order_value" });
  });

  test("an invalid_command error from confirm or cancel is shown; other errors are not", () => {
    let state = run(asGuest(), event({ type: "error", code: "invalid_command", message: "confirm rejected: expired" }));
    expect(state.rejections).toEqual([{ orderId: null, reason: "confirm rejected: expired" }]);
    state = run(state, event({ type: "error", code: "unknown_symbol", message: "nope" }));
    expect(state.rejections.length).toBe(1);
  });

  test("a rejected new order drops the oldest waiting placement; a rejected cancel does not", () => {
    let state = withCommandSent(asGuest(), "r1", "x");
    state = run(state, { type: "preview", request_id: "r1", preview: PLACE_PREVIEW });
    state = withPreviewConfirmed(state);
    state = run(state, rejected("guest", "o-1", "kill_switch"));
    expect(state.pendingPlacements).toEqual([]);

    let open = run(asGuest(), ack("guest", "o-1", "accepted"));
    open = { ...open, pendingPlacements: [{ symbol: "BTC-USD", side: "buy", kind: "market", price: null, qty: "1" }] };
    open = run(open, rejected("guest", "o-1", "engine_unavailable"));
    expect(open.pendingPlacements.length).toBe(1);
  });

  test("dismissing clears the list", () => {
    const state = run(asGuest(), rejected("guest", "o-1", "rate_limit"));
    expect(withRejectionsCleared(state).rejections).toEqual([]);
  });
});

describe("dialogs", () => {
  test("requesting a confirmation sets the slot and closes any preview", () => {
    let state = withCommandSent(initialState(), "r1", "x");
    state = run(state, { type: "preview", request_id: "r1", preview: PLACE_PREVIEW });
    state = withConfirmRequested(state, "flatten_all");
    expect(state.confirmAction).toBe("flatten_all");
    expect(state.preview).toBeNull();
    expect(withConfirmCleared(state).confirmAction).toBeNull();
  });
});

describe("command history (Req 31.3)", () => {
  test("typed texts are kept, consecutive repeats are not, ticket orders are not", () => {
    let state = withCommandSent(initialState(), "r1", "BUY BTC 1");
    state = withCommandSent(state, "r2", "BUY BTC 1");
    state = withCommandSent(state, "r3", "FLAT");
    state = withCommandSent(state, "r4", null);
    expect(state.commandHistory).toEqual(["BUY BTC 1", "FLAT"]);
  });
});

describe("account change and reset (Req 15.7, 46.4)", () => {
  function busy(): TerminalState {
    let state = run(asGuest(), position("guest", "BTC-USD", "10", "100", "5", "1"), ack("guest", "o-1", "accepted"));
    state = run(state, fill("guest", "o-1", "1", "9"), rejected("guest", "o-2", "price_band"));
    state = withCommandSent(state, "r1", "x");
    state = run(state, { type: "preview", request_id: "r1", preview: PLACE_PREVIEW });
    return withConfirmRequested(state, "cancel_all");
  }

  test("a session for a different account clears everything of the old one", () => {
    const next = run(busy(), { type: "session", account_id: "w_abc", address: "abc" });
    expect(next.positions).toEqual({});
    expect(next.realizedBySymbol).toEqual({});
    expect(next.openOrders).toEqual({});
    expect(next.fills).toEqual([]);
    expect(next.preview).toBeNull();
    expect(next.confirmAction).toBeNull();
    expect(next.rejections).toEqual([]);
    expect(next.session?.accountId).toBe("w_abc");
  });

  test("the same account again (reconnect) keeps the data", () => {
    const before = run(busy(), { type: "session", account_id: "guest", address: null });
    expect(Object.keys(before.positions)).toEqual(["BTC-USD"]);
    expect(Object.keys(before.openOrders)).toEqual(["o-1"]);
  });

  test("events of the old account are ignored after the switch", () => {
    const next = run(busy(), { type: "session", account_id: "w_abc", address: "abc" });
    expect(run(next, position("guest", "BTC-USD", "10", "100"))).toBe(next);
  });

  test("an account_reset notice clears positions, orders, fills, and previews but keeps rejections", () => {
    const next = run(busy(), { type: "notice", kind: "account_reset", message: "engine restarted" });
    expect(next.positions).toEqual({});
    expect(next.openOrders).toEqual({});
    expect(next.fills).toEqual([]);
    expect(next.preview).toBeNull();
    expect(next.confirmAction).toBeNull();
    expect(next.rejections.length).toBe(1);
    expect(next.notices.length).toBe(1);
  });

  test("a new connection drops the preview and dialog but keeps the account data", () => {
    const before = busy();
    const next = applySocketEvent(before, { type: "open" });
    expect(next.preview).toBeNull();
    expect(next.confirmAction).toBeNull();
    expect(next.positions).toBe(before.positions);
  });
});

describe("ticket", () => {
  test("quantity and price setters", () => {
    let state = prefillTicketFromBook(initialState(), "BTC-USD", "6400000");
    state = withTicketQty(state, "10000000");
    expect(state.ticket).toEqual({ symbol: "BTC-USD", side: null, price: "6400000", qty: "10000000" });
    expect(withTicketPrice(state, null).ticket.price).toBeNull();
    expect(withTicketQty(state, "10000000")).toBe(state);
  });

  test("selecting another symbol resets the ticket price and quantity", () => {
    let state = withTicketQty(prefillTicketFromBook(initialState(), "BTC-USD", "6400000"), "5");
    state = withSymbol(state, "ETH-USD");
    expect(state.ticket).toEqual({ symbol: "ETH-USD", side: null, price: null, qty: null });
    // Selecting the symbol the ticket already has keeps it.
    const kept = withSymbol(withTicketQty(initialState(), "5"), "BTC-USD");
    expect(kept.ticket.qty).toBe("5");
  });
});
