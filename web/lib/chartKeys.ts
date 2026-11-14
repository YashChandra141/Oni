// Maps a keyboard event to a chart action through the shared keymap (design §4 and §5, Req 25.3,
// 29.1, 29.2, 32). Pure: no DOM access, so tests pass plain objects.
//
// Focus context: "chart" when the pointer or keyboard focus is on the chart panel, so `+`, `-`,
// and the arrows apply; "global" otherwise, where only the global bindings (digits 1 to 5)
// apply. Anything else the keymap binds (B, S, Tab, ...) is not a chart action and returns null.
// The indicator toggles (E, W, O, R, T: global `indicator.*` actions, Req 26.3) resolve through
// `indicatorToggleForKey`, with the same guards.

import { forClient, keyFromEvent, keymap, resolve, type Action, type Keymap } from "../../shared/keymap";
import type { Timeframe } from "../../shared/protocol/index";
import { isTimeframe } from "./chartData";
import { toggleFromAction, type IndicatorName } from "./indicatorData";

export type ChartFocus = "chart" | "global";

export type ChartAction =
  | { readonly kind: "timeframe"; readonly timeframe: Timeframe }
  | { readonly kind: "zoom_in" }
  | { readonly kind: "zoom_out" }
  | { readonly kind: "pan_back" }
  | { readonly kind: "pan_forward" };

/** The parts of a `KeyboardEvent` this module reads. A real `KeyboardEvent` fits. */
export interface ChartKeyEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly metaKey?: boolean;
  readonly isComposing?: boolean;
  readonly defaultPrevented?: boolean;
  readonly target?: unknown;
}

const WEB_KEYMAP: Keymap = forClient(keymap, "web");

/** True for text inputs, textareas, selects, and contenteditable elements (the command bar). */
export function isEditableTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  if (element.isContentEditable === true) return true;
  if (typeof element.tagName !== "string") return false;
  const tag = element.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Converts a keymap action name to a chart action, or null for a non-chart action. */
export function chartActionFromName(action: Action): ChartAction | null {
  switch (action) {
    case "chart.zoom_in":
      return { kind: "zoom_in" };
    case "chart.zoom_out":
      return { kind: "zoom_out" };
    case "chart.pan_back":
      return { kind: "pan_back" };
    case "chart.pan_forward":
      return { kind: "pan_forward" };
    default: {
      const prefix = "timeframe.";
      if (action.startsWith(prefix)) {
        const timeframe = action.slice(prefix.length);
        if (isTimeframe(timeframe)) return { kind: "timeframe", timeframe };
      }
      return null;
    }
  }
}

/**
 * The chart action for a key event, or null. Returns null when Ctrl, Alt, or Meta is held (so
 * browser shortcuts such as Ctrl+- keep working), while the target is a text input or textarea
 * (the command bar), during IME composition, or when the event was already handled. Shift is
 * allowed because `+` needs it on many layouts.
 */
export function chartActionForKey(
  event: ChartKeyEvent,
  focus: ChartFocus = "chart",
  map: Keymap = WEB_KEYMAP,
): ChartAction | null {
  const action = keymapActionForKey(event, focus, map);
  return action === null ? null : chartActionFromName(action);
}

/**
 * The indicator toggle for a key event (Req 26.3: E, W, O, R, T as global actions), or null.
 * The same events are ignored as in `chartActionForKey` (modifiers, text inputs, IME, handled).
 */
export function indicatorToggleForKey(
  event: ChartKeyEvent,
  focus: ChartFocus = "global",
  map: Keymap = WEB_KEYMAP,
): IndicatorName | null {
  const action = keymapActionForKey(event, focus, map);
  return action === null ? null : toggleFromAction(action);
}

/** The keymap action for a key event after the shared guards, or null. */
function keymapActionForKey(event: ChartKeyEvent, focus: ChartFocus, map: Keymap): Action | null {
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return null;
  if (event.isComposing === true || event.defaultPrevented === true) return null;
  if (isEditableTarget(event.target)) return null;
  const key = keyFromEvent(event);
  if (key === null) return null;
  return resolve(map, focus, key);
}
