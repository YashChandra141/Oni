// Maps keyboard events to order entry actions through the shared keymap (design §4 and §5,
// Req 30.2-30.5, 31.3, 32). Pure: no DOM access, so tests pass plain objects.
//
// Focus contexts, highest priority first: `dialog` (a preview or confirmation dialog is open),
// `command` (the command bar input has focus), `orders` (the open orders panel is hovered or
// focused), then `global`. Inside a dialog only dialog bindings apply, so B, S, F, and X cannot
// open a second order while the user is deciding. Inside the command bar only command bindings
// apply, so letters type text.

import { forClient, keyFromEvent, keymap, resolve, type Action, type Keymap } from "../../shared/keymap";
import { isEditableTarget, type ChartKeyEvent } from "./chartKeys";

export type OrderFocus = "dialog" | "command" | "orders" | "global";

export type OrderKeyAction =
  | "buy"
  | "sell"
  | "flatten"
  | "cancel_all"
  | "focus_command"
  | "history_prev"
  | "history_next"
  | "submit"
  | "blur"
  | "confirm"
  | "cancel"
  | "orders_up"
  | "orders_down"
  | "cancel_order";

const WEB_KEYMAP: Keymap = forClient(keymap, "web");

/** The focus context for the current UI state (dialog > command > orders > global). */
export function orderFocus(state: {
  readonly dialogOpen: boolean;
  readonly commandFocused: boolean;
  readonly ordersActive: boolean;
}): OrderFocus {
  if (state.dialogOpen) return "dialog";
  if (state.commandFocused) return "command";
  if (state.ordersActive) return "orders";
  return "global";
}

/** Converts a keymap action to an order key action, or null for actions this module ignores. */
export function orderKeyActionFromName(action: Action): OrderKeyAction | null {
  switch (action) {
    case "order.buy":
      return "buy";
    case "order.sell":
      return "sell";
    case "account.flatten":
      return "flatten";
    case "orders.cancel_all":
      return "cancel_all";
    case "command.focus":
      return "focus_command";
    case "history.prev":
      return "history_prev";
    case "history.next":
      return "history_next";
    case "command.submit":
      return "submit";
    case "command.blur":
      return "blur";
    case "dialog.confirm":
      return "confirm";
    case "dialog.cancel":
      return "cancel";
    case "orders.up":
      return "orders_up";
    case "orders.down":
      return "orders_down";
    case "order.cancel":
      return "cancel_order";
    default:
      return null;
  }
}

/**
 * The order action for a key event, or null. Returns null when Ctrl, Alt, or Meta is held, during
 * IME composition, or when the event was already handled. A text input target is ignored unless
 * the focus is `command` (the command bar itself). In `dialog` focus only dialog actions count;
 * in `orders` focus the orders bindings come first and the global ones follow.
 */
export function orderActionForKey(
  event: ChartKeyEvent,
  focus: OrderFocus,
  map: Keymap = WEB_KEYMAP,
): OrderKeyAction | null {
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return null;
  if (event.isComposing === true || event.defaultPrevented === true) return null;
  if (focus !== "command" && isEditableTarget(event.target)) return null;
  const key = keyFromEvent(event);
  if (key === null) return null;
  const name = resolve(map, focus, key);
  if (name === null) return null;
  const action = orderKeyActionFromName(name);
  if (action === null) return null;
  if (focus === "dialog" && action !== "confirm" && action !== "cancel") return null;
  if (focus === "command" && !["history_prev", "history_next", "submit", "blur"].includes(action)) {
    return null;
  }
  return action;
}
