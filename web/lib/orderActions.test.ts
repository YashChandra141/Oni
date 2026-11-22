// Order entry flows (Task 12.3, Req 22, 30.2-30.5, 31.2): what is sent, and what is not.
import { beforeEach, describe, expect, test } from "bun:test";
import type { ClientMessage, OrderPreview } from "../../shared/protocol/index";
import { createOrderActions } from "./orderActions";
import { initialState, useTerminalStore } from "./store";

let sent: ClientMessage[] = [];
let open = true;

function actions() {
  return createOrderActions((message) => {
    if (!open) return false;
    sent.push(message);
    return true;
  }, useTerminalStore);
}

const PREVIEW: OrderPreview = {
  preview_id: "p1",
  text: "BUY BTC-USD 0.1 LMT 64000.00",
  action: { type: "place", symbol: "BTC-USD", venue: "replay", side: "buy", qty: "10000000", kind: { type: "limit", price: "6400000" } },
  expires_at: 0,
};

beforeEach(() => {
  sent = [];
  open = true;
  useTerminalStore.setState(initialState());
});

describe("ticket orders (B and S)", () => {
  test("send command_text only, never an order, and stay out of the history", () => {
    const store = useTerminalStore.getState();
    store.prefillLimit("BTC-USD", "6400000");
    store.setTicketQty("10000000");
    expect(actions().submitTicket("buy")).toBe(true);
    expect(sent.length).toBe(1);
    const message = sent[0];
    expect(message?.type).toBe("command_text");
    if (message?.type === "command_text") expect(message.text).toBe("BUY BTC-USD 0.1 LMT 64000.00");
    expect(useTerminalStore.getState().commandHistory).toEqual([]);
    expect(useTerminalStore.getState().lastRequestId).not.toBeNull();
  });

  test("an incomplete ticket sends nothing and shows a rejection", () => {
    expect(actions().submitTicket("sell")).toBe(false);
    expect(sent).toEqual([]);
    expect(useTerminalStore.getState().rejections[0]?.reason).toBe("enter a quantity");
  });

  test("a closed socket shows a rejection", () => {
    useTerminalStore.getState().setTicketQty("1");
    open = false;
    expect(actions().submitTicket("buy")).toBe(false);
    expect(useTerminalStore.getState().rejections[0]?.reason).toBe("not connected");
  });
});

describe("command bar", () => {
  test("submitCommand sends the text as typed and records history", () => {
    expect(actions().submitCommand("?buy a bit of bitcoin")).toBe(true);
    expect(sent[0]).toMatchObject({ type: "command_text", text: "?buy a bit of bitcoin", venue: "replay" });
    expect(useTerminalStore.getState().commandHistory).toEqual(["?buy a bit of bitcoin"]);
  });

  test("blank text and a closed socket send nothing and keep the history clean", () => {
    expect(actions().submitCommand("   ")).toBe(false);
    open = false;
    expect(actions().submitCommand("FLAT")).toBe(false);
    expect(sent).toEqual([]);
    expect(useTerminalStore.getState().commandHistory).toEqual([]);
  });
});

describe("preview dialog", () => {
  function withPreview() {
    useTerminalStore.setState({ preview: { requestId: "r1", preview: PREVIEW } });
  }

  test("confirm sends confirm with the preview id and closes the dialog", () => {
    withPreview();
    actions().confirmPreview();
    expect(sent).toEqual([expect.objectContaining({ type: "confirm", preview_id: "p1" })]);
    expect(useTerminalStore.getState().preview).toBeNull();
    expect(useTerminalStore.getState().pendingPlacements.length).toBe(1);
  });

  test("discard sends discard and nothing else", () => {
    withPreview();
    actions().discardPreview();
    expect(sent).toEqual([{ type: "discard", preview_id: "p1" }]);
    expect(useTerminalStore.getState().preview).toBeNull();
    expect(useTerminalStore.getState().pendingPlacements).toEqual([]);
  });

  test("with no preview open, confirm and discard do nothing", () => {
    actions().confirmPreview();
    actions().discardPreview();
    expect(sent).toEqual([]);
  });
});

describe("flatten all and cancel all (F and X)", () => {
  test("asking opens the dialog and sends nothing (Req 30.4, 30.5)", () => {
    actions().askFlatten();
    expect(useTerminalStore.getState().confirmAction).toBe("flatten_all");
    actions().askCancelAll();
    expect(useTerminalStore.getState().confirmAction).toBe("cancel_all");
    expect(sent).toEqual([]);
  });

  test("confirming sends flatten_all or cancel_all and closes the dialog", () => {
    actions().askFlatten();
    actions().confirmPending();
    expect(sent[0]?.type).toBe("flatten_all");
    expect(useTerminalStore.getState().confirmAction).toBeNull();
    actions().askCancelAll();
    actions().confirmPending();
    expect(sent[1]?.type).toBe("cancel_all");
  });

  test("cancelling the dialog sends nothing", () => {
    actions().askFlatten();
    actions().cancelPending();
    expect(sent).toEqual([]);
    expect(useTerminalStore.getState().confirmAction).toBeNull();
    actions().confirmPending();
    expect(sent).toEqual([]);
  });
});

describe("cancel one order (✕ and Del)", () => {
  test("sends cancel with the order id", () => {
    actions().cancelOrder("o-1");
    expect(sent).toEqual([expect.objectContaining({ type: "cancel", order_id: "o-1" })]);
  });
});
