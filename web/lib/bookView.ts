// Pure helpers for the order book panel and the trades tape (Task 8.3, Req 27.1, 27.2, 30.1).
// No DOM access, so tests pass plain objects. Quantities are BigInt-parsed decimal strings.

import { forClient, keyFromEvent, keymap, type Keymap } from "../../shared/keymap";
import type { Level } from "../../shared/protocol/index";
import type { BookCursor, BookState, TapeEntry } from "./store";

/** Most levels shown per side. */
export const BOOK_LEVELS = 12;
/** Most trades rendered in the tape. */
export const TAPE_ROWS = 50;

/** The tape rows to render for `symbol`: the first `TAPE_ROWS` matches of a newest-first tape. */
export function tapeRows(tape: readonly TapeEntry[], symbol: string): TapeEntry[] {
  return tape.filter((entry) => entry.symbol === symbol).slice(0, TAPE_ROWS);
}

const UNSIGNED = /^\d+$/;

function parseQty(raw: string): bigint {
  return UNSIGNED.test(raw) ? BigInt(raw) : 0n;
}

/**
 * Depth bar width of each level as an integer permille (0..1000) of the largest quantity in
 * `levels`. Uses BigInt; a level with zero or invalid quantity gets 0.
 */
export function depthFractions(levels: readonly Level[]): number[] {
  const quantities = levels.map((level) => parseQty(level.qty));
  let max = 0n;
  for (const qty of quantities) if (qty > max) max = qty;
  if (max === 0n) return quantities.map(() => 0);
  return quantities.map((qty) => Number((qty * 1000n) / max));
}

export interface BookLayout {
  /** Top to bottom: farthest ask first, best ask last (nearest the middle). */
  readonly asks: readonly Level[];
  /** Top to bottom: best bid first. */
  readonly bids: readonly Level[];
}

/**
 * Display order. The engine sends each side best first; this keeps the best `maxLevels` of each
 * side and reverses the asks so the best ask sits next to the spread.
 */
export function layoutBook(
  book: Pick<BookState, "bids" | "asks"> | undefined,
  maxLevels: number = BOOK_LEVELS,
): BookLayout {
  if (book === undefined) return { asks: [], bids: [] };
  const limit = Math.max(0, Math.floor(maxLevels));
  return { asks: book.asks.slice(0, limit).reverse(), bids: book.bids.slice(0, limit) };
}

export type CursorDirection = "up" | "down";

/**
 * Moves the cursor over the displayed rows: asks top to bottom, then bids top to bottom. Clamps
 * at both ends. With no cursor, Up starts at the best ask and Down at the best bid (or the best
 * ask when there are no bids). Returns null when there are no rows, and the same object when
 * nothing changes.
 */
export function moveBookCursor(
  cursor: BookCursor | null,
  askCount: number,
  bidCount: number,
  direction: CursorDirection,
): BookCursor | null {
  const total = askCount + bidCount;
  if (total === 0) return null;
  let position: number;
  if (cursor === null) {
    position = direction === "up" ? askCount - 1 : askCount;
  } else {
    const current = cursor.side === "ask" ? cursor.index : askCount + cursor.index;
    position = direction === "up" ? current - 1 : current + 1;
  }
  position = Math.min(total - 1, Math.max(0, position));
  const next: BookCursor =
    position < askCount
      ? { side: "ask", index: position }
      : { side: "bid", index: position - askCount };
  if (cursor !== null && cursor.side === next.side && cursor.index === next.index) return cursor;
  return next;
}

/** The level under the cursor in the displayed layout, or null when out of range. */
export function levelAtCursor(layout: BookLayout, cursor: BookCursor | null): Level | null {
  if (cursor === null) return null;
  const rows = cursor.side === "ask" ? layout.asks : layout.bids;
  return rows[cursor.index] ?? null;
}

export type BookKeyAction = "up" | "down" | "prefill";

/** The parts of a `KeyboardEvent` this module reads. */
export interface BookKeyEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly metaKey?: boolean;
  readonly isComposing?: boolean;
}

const WEB_KEYMAP: Keymap = forClient(keymap, "web");

/**
 * The book action for a key press through the shared keymap context `book`, or null. Returns
 * null while a text input has focus, with Ctrl, Alt, or Meta held, or during IME composition.
 */
export function bookKeyAction(
  event: BookKeyEvent,
  focusInInput: boolean,
  map: Keymap = WEB_KEYMAP,
): BookKeyAction | null {
  if (focusInInput) return null;
  if (event.ctrlKey === true || event.altKey === true || event.metaKey === true) return null;
  if (event.isComposing === true) return null;
  const key = keyFromEvent(event);
  if (key === null) return null;
  // Only the book context: global bindings such as Tab are not book actions.
  const action = map.contexts.book.get(key) ?? null;
  
  switch (action) {
    case "book.up":
      return "up";
    case "book.down":
      return "down";
    case "book.prefill":
      return "prefill";
    default:
      return null;
  }
}

/** HH:MM:SS in UTC for a time in ms since the epoch, or "--:--:--" when invalid. */
export function formatTimeUtc(ms: number): string {
  if (!Number.isFinite(ms)) return "--:--:--";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toISOString().slice(11, 19);
}
