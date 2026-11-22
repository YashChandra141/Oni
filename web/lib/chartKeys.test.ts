// Key mapping for the chart through the shared keymap (Task 5.4, Req 25.3, 29.1, 29.2).
import { describe, expect, test } from "bun:test";
import {
  chartActionForKey,
  chartActionFromName,
  indicatorToggleForKey,
  isEditableTarget,
  type ChartKeyEvent,
} from "./chartKeys";

const press = (key: string, extra: Partial<ChartKeyEvent> = {}): ChartKeyEvent => ({ key, ...extra });

describe("timeframe keys 1-6", () => {
  const expected = [
    ["1", "1m"],
    ["2", "5m"],
    ["3", "15m"],
    ["4", "1h"],
    ["5", "4h"],
    ["6", "1d"],
  ] as const;

  test.each(expected)("key %p selects %p with chart focus", (key, timeframe) => {
    expect(chartActionForKey(press(key), "chart")).toEqual({ kind: "timeframe", timeframe });
  });

  test.each(expected)("key %p selects %p without chart focus", (key, timeframe) => {
    expect(chartActionForKey(press(key), "global")).toEqual({ kind: "timeframe", timeframe });
  });

  test("other digits do nothing", () => {
    expect(chartActionForKey(press("0"))).toBeNull();
    expect(chartActionForKey(press("7"))).toBeNull();
  });
});

describe("zoom and pan keys", () => {
  test("+ zooms in and - zooms out", () => {
    expect(chartActionForKey(press("+"))).toEqual({ kind: "zoom_in" });
    expect(chartActionForKey(press("-"))).toEqual({ kind: "zoom_out" });
  });

  test("+ still works when Shift is held, as on layouts where + needs Shift", () => {
    expect(chartActionForKey(press("+", { shiftKey: true }))).toEqual({ kind: "zoom_in" });
  });

  test("left and right arrows pan back and forward", () => {
    expect(chartActionForKey(press("ArrowLeft"))).toEqual({ kind: "pan_back" });
    expect(chartActionForKey(press("ArrowRight"))).toEqual({ kind: "pan_forward" });
  });

  test("they apply only with chart focus", () => {
    for (const key of ["+", "-", "ArrowLeft", "ArrowRight"]) {
      expect(chartActionForKey(press(key), "global")).toBeNull();
    }
  });

  test("up and down arrows are not chart actions", () => {
    expect(chartActionForKey(press("ArrowUp"))).toBeNull();
    expect(chartActionForKey(press("ArrowDown"))).toBeNull();
  });

  test("Shift with an arrow is a different key and does nothing", () => {
    expect(chartActionForKey(press("ArrowLeft", { shiftKey: true }))).toBeNull();
  });
});

describe("keys that belong to other actions", () => {
  test("order, symbol, and indicator keys are not chart actions", () => {
    for (const key of ["b", "B", "s", "Tab", "x", "e", ":", "Enter", "Escape", "p", "q"]) {
      expect(chartActionForKey(press(key))).toBeNull();
    }
  });
});

describe("ignored events", () => {
  test("ignored while typing in an input or textarea", () => {
    for (const tagName of ["INPUT", "input", "TEXTAREA", "SELECT"]) {
      expect(chartActionForKey(press("1", { target: { tagName } }))).toBeNull();
      expect(chartActionForKey(press("+", { target: { tagName } }))).toBeNull();
      expect(chartActionForKey(press("ArrowLeft", { target: { tagName } }))).toBeNull();
    }
  });

  test("ignored in a contenteditable element", () => {
    expect(chartActionForKey(press("1", { target: { tagName: "DIV", isContentEditable: true } }))).toBeNull();
  });

  test("a plain element or no target does not block the key", () => {
    expect(chartActionForKey(press("1", { target: { tagName: "DIV" } }))?.kind).toBe("timeframe");
    expect(chartActionForKey(press("1", { target: { tagName: "BUTTON" } }))?.kind).toBe("timeframe");
    expect(chartActionForKey(press("1", { target: null }))?.kind).toBe("timeframe");
    expect(chartActionForKey(press("1"))?.kind).toBe("timeframe");
  });

  test("ignored with Ctrl, Meta, or Alt held", () => {
    for (const key of ["1", "5", "+", "-", "ArrowLeft", "ArrowRight"]) {
      expect(chartActionForKey(press(key, { ctrlKey: true }))).toBeNull();
      expect(chartActionForKey(press(key, { metaKey: true }))).toBeNull();
      expect(chartActionForKey(press(key, { altKey: true }))).toBeNull();
    }
  });

  test("ignored during IME composition and when already handled", () => {
    expect(chartActionForKey(press("1", { isComposing: true }))).toBeNull();
    expect(chartActionForKey(press("1", { defaultPrevented: true }))).toBeNull();
  });

  test("an unknown key name gives null", () => {
    expect(chartActionForKey(press("Dead"))).toBeNull();
    expect(chartActionForKey(press(""))).toBeNull();
  });
});

describe("isEditableTarget", () => {
  test("recognises text controls only", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "textarea" })).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV" })).toBe(false);
    expect(isEditableTarget({})).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget("input")).toBe(false);
  });
});

describe("chartActionFromName", () => {
  test("maps the chart and timeframe actions", () => {
    expect(chartActionFromName("chart.zoom_in")).toEqual({ kind: "zoom_in" });
    expect(chartActionFromName("chart.zoom_out")).toEqual({ kind: "zoom_out" });
    expect(chartActionFromName("chart.pan_back")).toEqual({ kind: "pan_back" });
    expect(chartActionFromName("chart.pan_forward")).toEqual({ kind: "pan_forward" });
    expect(chartActionFromName("timeframe.15m")).toEqual({ kind: "timeframe", timeframe: "15m" });
  });

  test("other actions are not chart actions", () => {
    expect(chartActionFromName("order.buy")).toBeNull();
    expect(chartActionFromName("symbol.next")).toBeNull();
    expect(chartActionFromName("book.up")).toBeNull();
  });
});

describe("indicator keys E, W, O, R, T (Task 9.3, Req 26.3)", () => {
  const expected = [
    ["e", "ema"],
    ["E", "ema"],
    ["w", "vwap"],
    ["o", "bollinger"],
    ["r", "rsi"],
    ["t", "atr"],
  ] as const;

  test.each(expected)("key %p toggles %p with and without chart focus", (key, name) => {
    expect(indicatorToggleForKey(press(key), "global")).toBe(name);
    expect(indicatorToggleForKey(press(key), "chart")).toBe(name);
  });

  test("Shift+letter still toggles (Shift is folded into the key)", () => {
    expect(indicatorToggleForKey(press("E", { shiftKey: true }))).toBe("ema");
  });

  test("other keys are not toggles", () => {
    for (const key of ["1", "b", "s", "x", "+", "ArrowLeft", "Tab", "q", "p"]) {
      expect(indicatorToggleForKey(press(key))).toBeNull();
    }
  });

  test("ignored in text inputs, with modifiers, during IME, and when handled", () => {
    expect(indicatorToggleForKey(press("e", { target: { tagName: "INPUT" } }))).toBeNull();
    expect(indicatorToggleForKey(press("r", { target: { tagName: "DIV", isContentEditable: true } }))).toBeNull();
    expect(indicatorToggleForKey(press("e", { ctrlKey: true }))).toBeNull();
    expect(indicatorToggleForKey(press("w", { metaKey: true }))).toBeNull();
    expect(indicatorToggleForKey(press("t", { altKey: true }))).toBeNull();
    expect(indicatorToggleForKey(press("o", { isComposing: true }))).toBeNull();
    expect(indicatorToggleForKey(press("e", { defaultPrevented: true }))).toBeNull();
  });

  test("indicator keys are still not chart actions", () => {
    for (const key of ["e", "w", "o", "r", "t"]) expect(chartActionForKey(press(key))).toBeNull();
  });
});
