// Watchlist logic (Req 27.3, 27.4): the symbol list, Tab / Shift+Tab cycling through the shared
// keymap, and price direction for coloring. Pure: tests pass plain objects.

import { forClient, keyFromEvent, keymap, resolve, type Keymap } from "../../shared/keymap";
import { isEditableTarget, type ChartKeyEvent } from "./chartKeys";

export const DEFAULT_WATCHLIST: readonly string[] = ["BTC-USD", "ETH-USD", "SOL-USD"];

/** The watchlist symbols: the instrument table's symbols when present, else the defaults. */
export function watchlistSymbols(instruments: Readonly<Record<string, unknown>>): readonly string[] {
  const symbols = Object.keys(instruments);
  return symbols.length > 0 ? symbols : DEFAULT_WATCHLIST;
}

/** The symbol after `current`, wrapping. An unknown `current` gives the first symbol. */
export function nextSymbol(current: string, list: readonly string[]): string {
  if (list.length === 0) return current;
  const index = list.indexOf(current);
  return list[(index + 1) % list.length] ?? current;
}

/** The symbol before `current`, wrapping. An unknown `current` gives the last symbol. */
export function prevSymbol(current: string, list: readonly string[]): string {
  if (list.length === 0) return current;
  const index = list.indexOf(current);
  return list[(index <= 0 ? list.length : index) - 1] ?? current;
}

const WEB_KEYMAP: Keymap = forClient(keymap, "web");

/**
 * The symbol a key event switches to (`symbol.next` / `symbol.prev`), or null when the event is
 * not one of those keys, has Ctrl/Alt/Meta held, targets a text input, is an IME composition, or
 * was already handled.
 */
export function symbolForKey(
  event: ChartKeyEvent,
  current: string,
  list: readonly string[],
  map: Keymap = WEB_KEYMAP,
): string | null {
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return null;
  if (event.isComposing === true || event.defaultPrevented === true) return null;
  if (isEditableTarget(event.target)) return null;
  const key = keyFromEvent(event);
  if (key === null) return null;
  const action = resolve(map, "global", key);
  if (action === "symbol.next") return nextSymbol(current, list);
  if (action === "symbol.prev") return prevSymbol(current, list);
  return null;
}

export type PriceChange = "up" | "down" | "flat";

/** Direction from `prev` to `last` (decimal integer strings, BigInt compare). */
export function changeIndicator(prev: string | undefined, last: string | undefined): PriceChange {
  if (prev === undefined || last === undefined) return "flat";
  try {
    const a = BigInt(prev);
    const b = BigInt(last);
    return b > a ? "up" : b < a ? "down" : "flat";
  } catch {
    return "flat";
  }
}
