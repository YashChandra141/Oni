"use client";

// Order book panel (Task 8.3, Req 27.1, 30.1): asks above, spread and imbalance in the middle,
// bids below, each row with a depth bar proportional to its quantity. A click on a row, or
// Up/Down plus Enter while the panel is hovered or focused (shared keymap context `book`),
// prefills the limit ticket with that price. The full order form is Task 12.3.

import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type { Level } from "../../shared/protocol/index";
import { bookKeyAction, depthFractions, layoutBook, levelAtCursor } from "../lib/bookView";
import { isEditableTarget } from "../lib/chartKeys";
import { formatPrice, formatQty } from "../lib/format";
import { pairKey, useTerminalStore } from "../lib/store";

const DEFAULT_PRICE_DECIMALS = 2;
const DEFAULT_QTY_DECIMALS = 8;

interface RowsProps {
  readonly levels: readonly Level[];
  readonly side: "ask" | "bid";
  readonly cursorIndex: number | null;
  readonly priceDecimals: number;
  readonly qtyDecimals: number;
  readonly onPick: (price: string) => void;
}

interface BookRowProps {
  readonly price: string;
  readonly qty: string;
  readonly fraction: number;
  readonly side: "ask" | "bid";
  readonly active: boolean;
  readonly priceDecimals: number;
  readonly qtyDecimals: number;
  readonly onPick: (price: string) => void;
}

const BookRow = memo(function BookRow({
  price,
  qty,
  fraction,
  side,
  active,
  priceDecimals,
  qtyDecimals,
  onPick,
}: BookRowProps) {
  const text = side === "ask" ? "text-sell" : "text-buy";
  const bar = side === "ask" ? "bg-sell" : "bg-buy";
  return (
    <li>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`${side} ${formatPrice(price, priceDecimals)}`}
        onClick={() => {
          onPick(price);
        }}
        className={`relative flex w-full justify-between px-1 text-left ${text} ${
          active ? "outline outline-1 outline-amber" : ""
        }`}
      >
        <span
          aria-hidden="true"
          data-testid="depth-bar"
          className={`absolute inset-y-0 right-0 opacity-25 ${bar}`}
          style={{ width: `${fraction / 10}%` }}
        />
        <span className="relative">{formatPrice(price, priceDecimals)}</span>
        <span className="relative">{formatQty(qty, qtyDecimals)}</span>
      </button>
    </li>
  );
});

function Rows({ levels, side, cursorIndex, priceDecimals, qtyDecimals, onPick }: RowsProps) {
  const fractions = useMemo(() => depthFractions(levels), [levels]);
  return (
    <ul>
      {levels.map((level, index) => (
        <BookRow
          key={level.price}
          price={level.price}
          qty={level.qty}
          fraction={fractions[index] ?? 0}
          side={side}
          active={cursorIndex === index}
          priceDecimals={priceDecimals}
          qtyDecimals={qtyDecimals}
          onPick={onPick}
        />
      ))}
    </ul>
  );
}

export default function OrderBookPanel() {
  const symbol = useTerminalStore((state) => state.selection.symbol);
  const venue = useTerminalStore((state) => state.selection.venue);
  const book = useTerminalStore((state) => state.book[pairKey(state.selection.venue, symbol)]);
  const cursor = useTerminalStore((state) => state.bookCursor);
  const ticketPrice = useTerminalStore((state) => state.ticket.price);
  const ticketSymbol = useTerminalStore((state) => state.ticket.symbol);
  const prefillLimit = useTerminalStore((state) => state.prefillLimit);
  const priceDecimals =
    useTerminalStore((state) => state.instruments[symbol]?.price_decimals) ?? DEFAULT_PRICE_DECIMALS;
  const qtyDecimals =
    useTerminalStore((state) => state.instruments[symbol]?.qty_decimals) ?? DEFAULT_QTY_DECIMALS;
  const ticketDecimals =
    useTerminalStore((state) => state.instruments[ticketSymbol]?.price_decimals) ??
    DEFAULT_PRICE_DECIMALS;

  const layout = useMemo(() => layoutBook(book), [book]);
  const activeRef = useRef({ hover: false, focus: false });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { hover, focus } = activeRef.current;
      if (!hover && !focus) return;
      if (event.defaultPrevented) return;
      const action = bookKeyAction(event, isEditableTarget(event.target));
      if (action === null) return;
      const state = useTerminalStore.getState();
      event.preventDefault();
      if (action === "prefill") {
        const current = state.book[pairKey(state.selection.venue, state.selection.symbol)];
        const level = levelAtCursor(layoutBook(current), state.bookCursor);
        if (level !== null) state.prefillLimit(state.selection.symbol, level.price);
        return;
      }
      state.moveBookCursor(action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const pick = useCallback(
    (price: string) => {
      prefillLimit(symbol, price);
    },
    [prefillLimit, symbol],
  );

  const spread =
    book === undefined || book.spread === null ? "—" : formatPrice(book.spread, priceDecimals);
  const imbalance =
    book === undefined ? "—" : `${(book.imbalanceBps / 100).toFixed(1)}%`;
  const askCursor = cursor?.side === "ask" ? cursor.index : null;
  const bidCursor = cursor?.side === "bid" ? cursor.index : null;

  return (
    <div
      role="group"
      aria-label={`${symbol} order book`}
      tabIndex={0}
      className="flex h-full min-h-0 flex-col text-xs outline-none focus-visible:outline-1 focus-visible:outline-amber"
      onPointerEnter={() => {
        activeRef.current.hover = true;
      }}
      onPointerLeave={() => {
        activeRef.current.hover = false;
      }}
      onFocus={() => {
        activeRef.current.focus = true;
      }}
      onBlur={() => {
        activeRef.current.focus = false;
      }}
    >
      {venue === "jupiter" || venue === "raydium" ? (
        <div className="text-amber" aria-label="Simulated depth">
          simulated depth
        </div>
      ) : null}
      {book === undefined ? (
        <div className="text-phosphor-faint">waiting for book…</div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-hidden">
            <Rows
              levels={layout.asks}
              side="ask"
              cursorIndex={askCursor}
              priceDecimals={priceDecimals}
              qtyDecimals={qtyDecimals}
              onPick={pick}
            />
          </div>
          <div className="flex justify-between border-y border-crt-line px-1 py-0.5 text-amber">
            <span>spread {spread}</span>
            <span>imb {imbalance}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <Rows
              levels={layout.bids}
              side="bid"
              cursorIndex={bidCursor}
              priceDecimals={priceDecimals}
              qtyDecimals={qtyDecimals}
              onPick={pick}
            />
          </div>
        </>
      )}
      <div className="mt-1 text-phosphor-dim">
        TICKET: LMT {ticketPrice === null ? "—" : `${ticketSymbol} ${formatPrice(ticketPrice, ticketDecimals)}`}
      </div>
    </div>
  );
}
