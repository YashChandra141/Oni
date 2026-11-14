"use client";

// Global order hotkeys (Task 12.3, Req 30.2, 30.4, 30.5, 31): B and S open a preview for the order
// ticket, F and X open the flatten-all and cancel-all dialogs, `:` focuses the command bar, and
// while a dialog is open Enter/Y confirm and Escape/N cancel. Keys come from the shared keymap
// (lib/orderKeys.ts); text inputs are ignored. Renders nothing.

import { useEffect } from "react";
import { orderActionForKey, orderFocus } from "../lib/orderKeys";
import { useTerminalStore } from "../lib/store";
import { useOrderActions } from "../lib/useOrderActions";
import { COMMAND_INPUT_ID } from "./CommandBar";

export function OrderHotkeys() {
  const actions = useOrderActions();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = useTerminalStore.getState();
      const focus = orderFocus({
        dialogOpen: state.preview !== null || state.confirmAction !== null,
        commandFocused: false,
        ordersActive: false,
      });
      const action = orderActionForKey(event, focus);
      if (action === null) return;
      switch (action) {
        case "buy":
          actions.submitTicket("buy");
          break;
        case "sell":
          actions.submitTicket("sell");
          break;
        case "flatten":
          actions.askFlatten();
          break;
        case "cancel_all":
          actions.askCancelAll();
          break;
        case "focus_command":
          document.getElementById(COMMAND_INPUT_ID)?.focus();
          break;
        case "confirm":
          if (state.confirmAction !== null) actions.confirmPending();
          else actions.confirmPreview();
          break;
        case "cancel":
          if (state.confirmAction !== null) actions.cancelPending();
          else actions.discardPreview();
          break;
        default:
          return;
      }
      // Keeps `:` out of the command input, and Enter from also clicking a focused button.
      event.preventDefault();
    };
    // Capture phase: runs before the book and chart handlers, so a dialog key such as Enter is not
    // also read as "prefill from the book" (those handlers skip events that are already handled).
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [actions]);

  return null;
}
