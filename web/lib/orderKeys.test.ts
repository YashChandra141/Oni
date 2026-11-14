// Order entry hotkeys through the shared keymap (Task 12.3, Req 30.2-30.5, 31.3, 32).
import { describe, expect, test } from "bun:test";
import { orderActionForKey, orderFocus, type OrderFocus } from "./orderKeys";

function press(key: string, extra: Record<string, unknown> = {}) {
  return { key, ...extra };
}

describe("global focus", () => {
  test("B, S, F, X open the order flows (either case)", () => {
    expect(orderActionForKey(press("b"), "global")).toBe("buy");
    expect(orderActionForKey(press("B", { shiftKey: true }), "global")).toBe("buy");
    expect(orderActionForKey(press("s"), "global")).toBe("sell");
    expect(orderActionForKey(press("f"), "global")).toBe("flatten");
    expect(orderActionForKey(press("x"), "global")).toBe("cancel_all");
  });

  test("`:` focuses the command bar", () => {
    expect(orderActionForKey(press(":", { shiftKey: true }), "global")).toBe("focus_command");
  });

  test("other global keys and TUI-only keys are not order actions", () => {
    for (const key of ["1", "Tab", "e", "w", "p", "q", "Enter", "Escape", "y", "n"]) {
      expect(orderActionForKey(press(key), "global")).toBeNull();
    }
  });

  test("ignored inside text inputs, with modifiers, while composing, or when handled", () => {
    expect(orderActionForKey(press("b", { target: { tagName: "INPUT" } }), "global")).toBeNull();
    expect(orderActionForKey(press("b", { target: { tagName: "textarea" } }), "global")).toBeNull();
    expect(orderActionForKey(press("b", { target: { isContentEditable: true } }), "global")).toBeNull();
    expect(orderActionForKey(press("b", { ctrlKey: true }), "global")).toBeNull();
    expect(orderActionForKey(press("b", { metaKey: true }), "global")).toBeNull();
    expect(orderActionForKey(press("b", { altKey: true }), "global")).toBeNull();
    expect(orderActionForKey(press("b", { isComposing: true }), "global")).toBeNull();
    expect(orderActionForKey(press("b", { defaultPrevented: true }), "global")).toBeNull();
    // A button is not a text input.
    expect(orderActionForKey(press("b", { target: { tagName: "BUTTON" } }), "global")).toBe("buy");
  });
});

describe("dialog focus", () => {
  test("Enter and Y confirm; Escape and N cancel", () => {
    expect(orderActionForKey(press("Enter"), "dialog")).toBe("confirm");
    expect(orderActionForKey(press("y"), "dialog")).toBe("confirm");
    expect(orderActionForKey(press("Y"), "dialog")).toBe("confirm");
    expect(orderActionForKey(press("Escape"), "dialog")).toBe("cancel");
    expect(orderActionForKey(press("n"), "dialog")).toBe("cancel");
  });

  test("order keys do nothing while a dialog is open", () => {
    for (const key of ["b", "s", "f", "x", ":"]) {
      expect(orderActionForKey(press(key), "dialog")).toBeNull();
    }
  });
});

describe("command focus", () => {
  test("Up, Down, Enter, Escape map to history, submit, and blur", () => {
    const target = { target: { tagName: "INPUT" } };
    expect(orderActionForKey(press("ArrowUp", target), "command")).toBe("history_prev");
    expect(orderActionForKey(press("ArrowDown", target), "command")).toBe("history_next");
    expect(orderActionForKey(press("Enter", target), "command")).toBe("submit");
    expect(orderActionForKey(press("Escape", target), "command")).toBe("blur");
  });

  test("letters type text", () => {
    const target = { target: { tagName: "INPUT" } };
    for (const key of ["b", "s", "f", "x", "y", ":", "a"]) {
      expect(orderActionForKey(press(key, target), "command")).toBeNull();
    }
  });
});

describe("orders focus", () => {
  test("Up, Down, Delete act on open orders and global keys still work", () => {
    expect(orderActionForKey(press("ArrowUp"), "orders")).toBe("orders_up");
    expect(orderActionForKey(press("ArrowDown"), "orders")).toBe("orders_down");
    expect(orderActionForKey(press("Delete"), "orders")).toBe("cancel_order");
    expect(orderActionForKey(press("x"), "orders")).toBe("cancel_all");
  });

  test("Delete means nothing outside the orders panel", () => {
    expect(orderActionForKey(press("Delete"), "global")).toBeNull();
  });
});

describe("orderFocus priority", () => {
  const cases: [Parameters<typeof orderFocus>[0], OrderFocus][] = [
    [{ dialogOpen: true, commandFocused: true, ordersActive: true }, "dialog"],
    [{ dialogOpen: false, commandFocused: true, ordersActive: true }, "command"],
    [{ dialogOpen: false, commandFocused: false, ordersActive: true }, "orders"],
    [{ dialogOpen: false, commandFocused: false, ordersActive: false }, "global"],
  ];
  test("dialog > command > orders > global", () => {
    for (const [state, expected] of cases) expect(orderFocus(state)).toBe(expected);
  });
});
