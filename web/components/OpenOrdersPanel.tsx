"use client";

// Open orders (Task 12.3, Req 28.2, 30.3): side, symbol, type, price, filled, and remaining
// quantity. ✕ on a row, or Del on the selected row, sends a cancel request. While the pointer is
// over the panel or it has focus, Up and Down move the selection (shared keymap context `orders`).

import { useEffect, useRef, useState } from "react";
import { formatPrice, formatQty } from "../lib/format";
import {
  DEFAULT_PRICE_DECIMALS,
  DEFAULT_QTY_DECIMALS,
  orderKindLabel,
} from "../lib/orderEntry";
import { orderActionForKey } from "../lib/orderKeys";
import { useTerminalStore } from "../lib/store";
import { useOrderActions } from "../lib/useOrderActions";

export default function OpenOrdersPanel() {
  const actions = useOrderActions();
  const openOrders = useTerminalStore((state) => state.openOrders);
  const instruments = useTerminalStore((state) => state.instruments);
  const rows = Object.values(openOrders);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeRef = useRef({ hover: false, focus: false });
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { hover, focus } = activeRef.current;
      if (!hover && !focus) return;
      const state = useTerminalStore.getState();
      if (state.preview !== null || state.confirmAction !== null) return;
      const action = orderActionForKey(event, "orders");
      if (action !== "orders_up" && action !== "orders_down" && action !== "cancel_order") return;
      const ids = Object.keys(state.openOrders);
      if (ids.length === 0) return;
      event.preventDefault();
      const current = selectedRef.current;
      const at = current === null ? -1 : ids.indexOf(current);
      if (action === "cancel_order") {
        const id = ids[at];
        if (id !== undefined) actions.cancelOrder(id);
        return;
      }
      const next = action === "orders_up" ? (at < 0 ? ids.length - 1 : at - 1) : at + 1;
      setSelectedId(ids[Math.min(ids.length - 1, Math.max(0, next))] ?? null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [actions]);

  return (
    <div
      role="group"
      aria-label="Open orders"
      tabIndex={0}
      className="min-h-0 overflow-auto outline-none focus-visible:outline-1 focus-visible:outline-amber"
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
      <div className="grid grid-cols-[2.5rem_1fr_3rem_1fr_1fr_1fr_1.5rem] gap-2 text-phosphor-dim">
        <span>SIDE</span>
        <span>SYMBOL</span>
        <span>TYPE</span>
        <span className="text-right">PRICE</span>
        <span className="text-right">FILLED</span>
        <span className="text-right">LEFT</span>
        <span />
      </div>
      {rows.length === 0 ? (
        <div className="text-phosphor-faint">no open orders</div>
      ) : (
        rows.map((row) => {
          const info = row.symbol === null ? undefined : instruments[row.symbol];
          const qtyDecimals = info?.qty_decimals ?? DEFAULT_QTY_DECIMALS;
          const selected = row.orderId === selectedId;
          return (
            <div
              key={row.orderId}
              data-selected={selected}
              onClick={() => {
                setSelectedId(row.orderId);
              }}
              className={`grid grid-cols-[2.5rem_1fr_3rem_1fr_1fr_1fr_1.5rem] gap-2 ${
                selected ? "outline outline-1 outline-amber" : ""
              }`}
            >
              <span className={row.side === "sell" ? "text-sell" : "text-buy"}>
                {row.side === null ? "—" : row.side.toUpperCase()}
              </span>
              <span>{row.symbol ?? "—"}</span>
              <span>{orderKindLabel(row.kind)}</span>
              <span className="text-right">
                {row.price === null
                  ? "—"
                  : formatPrice(row.price, info?.price_decimals ?? DEFAULT_PRICE_DECIMALS)}
              </span>
              <span className="text-right">{formatQty(row.filled, qtyDecimals)}</span>
              <span className="text-right">{formatQty(row.remaining, qtyDecimals)}</span>
              <button
                type="button"
                aria-label={`Cancel order ${row.orderId}`}
                title="Cancel order"
                onClick={(event) => {
                  event.stopPropagation();
                  actions.cancelOrder(row.orderId);
                }}
                className="text-sell"
              >
                ✕
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}
