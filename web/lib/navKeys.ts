// Maps keyboard events to navigation actions through the shared keymap's web view (Task 14.12,
// Req 18.5, 30.4): pages (Alt+1..8), timeframe prev/next, venue and provider cycling, Copilot
// focus, and the help overlay. Pure: no DOM access, so tests pass plain objects.
// Unlike chartKeys, Alt is allowed here because the page keys use it.

import { forClient, keyFromEvent, keymap, resolve, type Action, type Keymap } from "../../shared/keymap";
import { isEditableTarget, type ChartKeyEvent } from "./chartKeys";

export type NavKeyAction =
  | { readonly kind: "page"; readonly page: number }
  | { readonly kind: "timeframe_prev" }
  | { readonly kind: "timeframe_next" }
  | { readonly kind: "venue_next" }
  | { readonly kind: "provider_next" }
  | { readonly kind: "copilot_focus" }
  | { readonly kind: "help" };

const WEB_KEYMAP: Keymap = forClient(keymap, "web");

/** Converts a keymap action to a navigation action, or null for any other action. */
export function navActionFromName(action: Action): NavKeyAction | null {
  switch (action) {
    case "page.1":
    case "page.2":
    case "page.3":
    case "page.4":
    case "page.5":
    case "page.6":
    case "page.7":
    case "page.8":
      return { kind: "page", page: Number(action.slice(5)) };
    case "timeframe.prev":
      return { kind: "timeframe_prev" };
    case "timeframe.next":
      return { kind: "timeframe_next" };
    case "venue.next":
      return { kind: "venue_next" };
    case "provider.next":
      return { kind: "provider_next" };
    case "copilot.focus":
      return { kind: "copilot_focus" };
    case "help":
      return { kind: "help" };
    default:
      return null;
  }
}

/**
 * The navigation action for a key event, or null. Returns null while a text input has focus
 * (except F1 and Alt+digit pages, which carry a modifier or are not printable), with Ctrl or
 * Meta held, or during IME composition.
 */
export function navActionForKey(
  event: ChartKeyEvent,
  map: Keymap = WEB_KEYMAP,
): NavKeyAction | null {
  if (event.ctrlKey === true || event.metaKey === true) return null;
  if (event.isComposing === true || event.defaultPrevented === true) return null;
  const key = keyFromEvent(event);
  if (key === null) return null;
  const action = resolve(map, "global", key);
  if (action === null) return null;
  const nav = navActionFromName(action);
  if (nav === null) return null;
  const typing = isEditableTarget(event.target ?? null);
  if (typing && event.altKey !== true && key !== "F1") return null;
  return nav;
}
