"use client";

// Order ticket (Task 12.3, Req 30.1, 30.2): the selected symbol, the limit price a click on the
// order book prefilled (or MARKET), and a quantity input checked against the instrument's qty
// decimals. Buy and Sell, like the B and S keys, send the ticket as command text; the server
// answers with an Order_Preview and nothing is placed until the user confirms it.

import { useEffect, useState } from "react";
import { formatPrice } from "../lib/format";
import {
  DEFAULT_PRICE_DECIMALS,
  DEFAULT_QTY_DECIMALS,
  parseDecimalUnits,
} from "../lib/orderEntry";
import { useTerminalStore } from "../lib/store";
import { useOrderActions } from "../lib/useOrderActions";

export default function OrderTicket() {
  const actions = useOrderActions();
  const symbol = useTerminalStore((state) => state.selection.symbol);
  const price = useTerminalStore((state) => state.ticket.price);
  const priceDecimals =
    useTerminalStore((state) => state.instruments[symbol]?.price_decimals) ?? DEFAULT_PRICE_DECIMALS;
  const qtyDecimals =
    useTerminalStore((state) => state.instruments[symbol]?.qty_decimals) ?? DEFAULT_QTY_DECIMALS;
  const setTicketQty = useTerminalStore((state) => state.setTicketQty);
  const setTicketPrice = useTerminalStore((state) => state.setTicketPrice);
  const [qtyText, setQtyText] = useState("");

  // A new symbol starts with an empty quantity (the store clears the ticket's).
  useEffect(() => {
    setQtyText("");
  }, [symbol]);

  const parsed = parseDecimalUnits(qtyText, qtyDecimals);
  const invalid = qtyText.trim().length > 0 && parsed === null;

  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex justify-between">
        <span className="text-phosphor-dim">SYMBOL</span>
        <span>{symbol}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-phosphor-dim">PRICE</span>
        <span className="flex items-center gap-1">
          <span>{price === null ? "MARKET" : `LMT ${formatPrice(price, priceDecimals)}`}</span>
          {price !== null && (
            <button
              type="button"
              aria-label="Use market price"
              title="Use a market order"
              onClick={() => {
                setTicketPrice(null);
              }}
              className="text-amber"
            >
              ✕
            </button>
          )}
        </span>
      </div>
      <label className="flex items-center justify-between gap-2">
        <span className="text-phosphor-dim">QTY</span>
        <input
          type="text"
          inputMode="decimal"
          aria-label="Order quantity"
          aria-invalid={invalid}
          autoComplete="off"
          spellCheck={false}
          value={qtyText}
          placeholder={`0.${"0".repeat(Math.min(qtyDecimals, 3))}`}
          onChange={(event) => {
            const text = event.target.value;
            setQtyText(text);
            setTicketQty(parseDecimalUnits(text, qtyDecimals));
          }}
          className={`w-24 border bg-transparent px-1 text-right outline-none ${
            invalid ? "border-sell text-sell" : "border-crt-line text-phosphor"
          }`}
        />
      </label>
      {invalid && (
        <div role="alert" className="text-sell">
          up to {qtyDecimals} decimals
        </div>
      )}
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          onClick={() => {
            actions.submitTicket("buy");
          }}
          className="crt-panel flex-1 px-2 py-1 text-buy"
        >
          Buy [B]
        </button>
        <button
          type="button"
          onClick={() => {
            actions.submitTicket("sell");
          }}
          className="crt-panel flex-1 px-2 py-1 text-sell"
        >
          Sell [S]
        </button>
      </div>
    </div>
  );
}
