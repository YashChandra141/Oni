// The order entry flows as functions of a `send` and a store (Task 12.3, Req 22, 30, 31), so the
// components and the hotkey handler share one implementation. No React here.
//
// Nothing in this module places an order directly. Typed and ticket orders go out as
// `command_text` and wait for the server's preview (Req 22.4); F and X send `flatten_all` and
// `cancel_all` only after the user confirms the dialog (Req 30.4, 30.5); ✕ sends `cancel`.

import type { ClientMessage } from "../../shared/protocol/index";
import {
  DEFAULT_PRICE_DECIMALS,
  DEFAULT_QTY_DECIMALS,
  cancelAllMessage,
  cancelMessage,
  commandTextMessage,
  confirmMessage,
  discardMessage,
  flattenAllMessage,
  nextRequestId,
  ticketToCommandText,
} from "./orderEntry";
import type { TerminalStore } from "./store";

export interface OrderStore {
  getState(): TerminalStore;
}

export interface OrderActions {
  /** Sends command bar text for parsing; false when the socket is not open. */
  submitCommand(text: string): boolean;
  /**
   * Builds the ticket's command and sends it for a preview (Req 30.2). An incomplete ticket or a
   * closed socket is shown as a rejection. Returns true when the command went out.
   */
  submitTicket(side: "buy" | "sell"): boolean;
  /** Sends `confirm` for the open preview. */
  confirmPreview(): void;
  /** Sends `discard` for the open preview and closes it. */
  discardPreview(): void;
  /** Opens the flatten-all dialog (F). */
  askFlatten(): void;
  /** Opens the cancel-all dialog (X). */
  askCancelAll(): void;
  /** Sends the pending flatten-all or cancel-all request, then closes the dialog. */
  confirmPending(): void;
  /** Closes the dialog without sending anything. */
  cancelPending(): void;
  /** Sends a cancel request for one open order (✕ or Del). */
  cancelOrder(orderId: string): void;
}

export function createOrderActions(
  send: (message: ClientMessage) => boolean,
  store: OrderStore,
): OrderActions {
  return {
    submitCommand(text) {
      if (text.trim().length === 0) return false;
      const requestId = nextRequestId();
      if (!send(commandTextMessage(requestId, text))) return false;
      store.getState().commandSent(requestId, text);
      return true;
    },

    submitTicket(side) {
      const state = store.getState();
      const instrument = state.instruments[state.ticket.symbol];
      const result = ticketToCommandText(
        { symbol: state.ticket.symbol, price: state.ticket.price, qty: state.ticket.qty },
        side,
        {
          priceDecimals: instrument?.price_decimals ?? DEFAULT_PRICE_DECIMALS,
          qtyDecimals: instrument?.qty_decimals ?? DEFAULT_QTY_DECIMALS,
        },
      );
      if (!result.ok) {
        state.addRejection(result.error);
        return false;
      }
      const requestId = nextRequestId();
      if (!send(commandTextMessage(requestId, result.text))) {
        state.addRejection("not connected");
        return false;
      }
      // Ticket orders are not typed, so they stay out of the command history.
      state.commandSent(requestId, null);
      return true;
    },

    confirmPreview() {
      const state = store.getState();
      const open = state.preview;
      if (open === null) return;
      send(confirmMessage(nextRequestId(), open.preview.preview_id));
      state.previewConfirmed();
    },

    discardPreview() {
      const state = store.getState();
      const open = state.preview;
      if (open === null) return;
      send(discardMessage(open.preview.preview_id));
      state.clearPreview();
    },

    askFlatten() {
      store.getState().requestConfirm("flatten_all");
    },

    askCancelAll() {
      store.getState().requestConfirm("cancel_all");
    },

    confirmPending() {
      const state = store.getState();
      const action = state.confirmAction;
      if (action === null) return;
      const requestId = nextRequestId();
      send(action === "flatten_all" ? flattenAllMessage(requestId) : cancelAllMessage(requestId));
      state.clearConfirm();
    },

    cancelPending() {
      store.getState().clearConfirm();
    },

    cancelOrder(orderId) {
      send(cancelMessage(nextRequestId(), orderId));
    },
  };
}
