"use client";

// Order ticket (Task 14.6, Req 24): Buy/Sell, Limit/Market/Stop/TWAP, price and amount inputs, a
// 0/25/50/75/100% slider from the free balance (buy) or the position (sell), and the USD total.
// Submit sends canonical command text only; the server answers with an Order_Preview and nothing
// is placed until the user confirms it. The venue is the connection's selected venue.

import { useEffect, useState } from "react";
import {
  DEFAULT_PRICE_DECIMALS,
  DEFAULT_QTY_DECIMALS,
  SLIDER_STEPS,
  TWAP_MAX_INTERVAL_S,
  TWAP_MAX_SLICES,
  TWAP_MIN_INTERVAL_S,
  TWAP_MIN_SLICES,
  buildTicketCommand,
  formatMoney,
  formatUnitsTrimmed,
  notionalMoney,
  parseDecimalUnits,
  sliderQty,
  type TicketKind,
} from "../lib/orderEntry";
import { pairKey, useTerminalStore } from "../lib/store";
import { useOrderActions } from "../lib/useOrderActions";

const KINDS: readonly { readonly kind: TicketKind; readonly label: string }[] = [
  { kind: "limit", label: "Limit" },
  { kind: "market", label: "Market" },
  { kind: "stop", label: "Stop" },
  { kind: "twap", label: "TWAP" },
];

export default function OrderTicket() {
  const actions = useOrderActions();
  const symbol = useTerminalStore((state) => state.selection.symbol);
  const venue = useTerminalStore((state) => state.selection.venue);
  const ticketPrice = useTerminalStore((state) => state.ticket.price);
  const priceDecimals =
    useTerminalStore((state) => state.instruments[symbol]?.price_decimals) ?? DEFAULT_PRICE_DECIMALS;
  const qtyDecimals =
    useTerminalStore((state) => state.instruments[symbol]?.qty_decimals) ?? DEFAULT_QTY_DECIMALS;
  const book = useTerminalStore((state) => state.book[pairKey(state.selection.venue, state.selection.symbol)]);
  const accountId = useTerminalStore((state) => state.session?.accountId ?? state.dataAccountId ?? "guest");
  const freeBalance = useTerminalStore((state) => state.balances[accountId]?.freeBalance);
  const position = useTerminalStore((state) => state.positions[symbol]?.qty);
  const setTicketQty = useTerminalStore((state) => state.setTicketQty);
  const setTicketPrice = useTerminalStore((state) => state.setTicketPrice);

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [kind, setKind] = useState<TicketKind>("limit");
  const [priceText, setPriceText] = useState("");
  const [qtyText, setQtyText] = useState("");
  const [percent, setPercent] = useState(0);
  const [slices, setSlices] = useState("4");
  const [intervalS, setIntervalS] = useState("60");

  const decimals = { priceDecimals, qtyDecimals };

  // A new symbol starts with empty fields.
  useEffect(() => {
    setPriceText("");
    setQtyText("");
    setPercent(0);
  }, [symbol]);

  // A click on a book price sets Limit and the price (Req 24.8).
  useEffect(() => {
    if (ticketPrice === null) return;
    const text = formatUnitsTrimmed(ticketPrice, priceDecimals);
    if (text === null) return;
    setKind("limit");
    setPriceText(text);
  }, [ticketPrice, priceDecimals]);

  const priceUnits = parseDecimalUnits(priceText, priceDecimals);
  const qtyUnits = parseDecimalUnits(qtyText, qtyDecimals);

  // Market totals use the best ask (buy) or best bid (sell) of the active venue (Req 24.4).
  const bestPrice = ((): string | null => {
    const levels = side === "buy" ? book?.asks : book?.bids;
    if (levels === undefined || levels.length === 0) return null;
    let best: bigint | null = null;
    for (const level of levels) {
      if (!/^\d+$/.test(level.price)) continue;
      const value = BigInt(level.price);
      if (best === null || (side === "buy" ? value < best : value > best)) best = value;
    }
    return best === null ? null : best.toString();
  })();
  const usesPrice = kind === "limit" || kind === "stop";
  const refPrice = usesPrice ? priceUnits : bestPrice;
  const total = notionalMoney(refPrice, qtyUnits, decimals);

  const syncStore = (nextKind: TicketKind, nextPrice: string | null, nextQty: string | null) => {
    setTicketPrice(nextKind === "limit" ? nextPrice : null);
    setTicketQty(nextQty);
  };

  const setQtyFromUnits = (units: string | null) => {
    const text = units === null || units === "0" ? "" : formatUnitsTrimmed(units, qtyDecimals) ?? "";
    setQtyText(text);
    syncStore(kind, priceUnits, units === "0" ? null : units);
  };

  const applyPercent = (p: number, nextSide = side, nextRef = refPrice) => {
    setPercent(p);
    setQtyFromUnits(sliderQty(nextSide, p, nextRef, freeBalance, position, decimals));
  };

  const command = buildTicketCommand(
    { symbol, side, kind, price: priceUnits, qty: qtyUnits, slices, intervalS },
    decimals,
  );
  const qtyInvalid = qtyText.trim().length > 0 && qtyUnits === null;
  const priceInvalid = priceText.trim().length > 0 && priceUnits === null;

  const inputClass = (invalid: boolean): string =>
    `w-28 border bg-transparent px-1 text-right outline-none ${
      invalid ? "border-sell text-sell" : "border-crt-line text-phosphor"
    }`;

  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex gap-1" role="group" aria-label="Side">
        {(["buy", "sell"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={side === value}
            onClick={() => {
              setSide(value);
              if (percent > 0) applyPercent(percent, value, usesPrice ? priceUnits : null);
            }}
            className={`crt-panel flex-1 px-2 py-1 ${value === "buy" ? "text-buy" : "text-sell"} ${
              side === value ? "font-bold underline" : "opacity-60"
            }`}
          >
            {value === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>
      <div className="flex gap-2" role="tablist" aria-label="Order type">
        {KINDS.map((entry) => (
          <button
            key={entry.kind}
            type="button"
            role="tab"
            aria-selected={kind === entry.kind}
            onClick={() => {
              setKind(entry.kind);
              setTicketPrice(entry.kind === "limit" ? priceUnits : null);
            }}
            className={kind === entry.kind ? "text-amber underline" : "text-phosphor-dim"}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="flex justify-between">
        <span className="text-phosphor-dim">SYMBOL</span>
        <span>
          {symbol} · {venue}
        </span>
      </div>
      <div className="flex justify-between text-phosphor-dim">
        <span>AVAILABLE</span>
        <span>${formatMoney(freeBalance)}</span>
      </div>
      <div className="flex justify-between text-phosphor-dim">
        <span>POSITION</span>
        <span>{position === undefined ? "0" : (formatUnitsTrimmed(position.replace("-", ""), qtyDecimals) ?? position)}</span>
      </div>
      {usesPrice ? (
        <label className="flex items-center justify-between gap-2">
          <span className="text-phosphor-dim">{kind === "stop" ? "STOP PRICE" : "PRICE"}</span>
          <input
            type="text"
            inputMode="decimal"
            aria-label="Order price"
            aria-invalid={priceInvalid}
            autoComplete="off"
            spellCheck={false}
            value={priceText}
            onChange={(event) => {
              const text = event.target.value;
              setPriceText(text);
              const units = parseDecimalUnits(text, priceDecimals);
              setTicketPrice(kind === "limit" ? units : null);
              if (percent > 0 && side === "buy") {
                setQtyFromUnits(sliderQty(side, percent, units, freeBalance, position, decimals));
              }
            }}
            className={inputClass(priceInvalid)}
          />
        </label>
      ) : (
        <div className="flex justify-between">
          <span className="text-phosphor-dim">PRICE</span>
          <span>{kind === "market" ? "MARKET" : "MARKET (per slice)"}</span>
        </div>
      )}
      <label className="flex items-center justify-between gap-2">
        <span className="text-phosphor-dim">AMOUNT</span>
        <input
          type="text"
          inputMode="decimal"
          aria-label="Order quantity"
          aria-invalid={qtyInvalid}
          autoComplete="off"
          spellCheck={false}
          value={qtyText}
          placeholder={`0.${"0".repeat(Math.min(qtyDecimals, 3))}`}
          onChange={(event) => {
            const text = event.target.value;
            setQtyText(text);
            setPercent(0);
            syncStore(kind, priceUnits, parseDecimalUnits(text, qtyDecimals));
          }}
          className={inputClass(qtyInvalid)}
        />
      </label>
      {qtyInvalid && (
        <div role="alert" className="text-sell">
          up to {qtyDecimals} decimals
        </div>
      )}
      {kind === "twap" && (
        <>
          <label className="flex items-center justify-between gap-2">
            <span className="text-phosphor-dim">SLICES</span>
            <input
              type="text"
              inputMode="numeric"
              aria-label="TWAP slices"
              title={`${TWAP_MIN_SLICES} to ${TWAP_MAX_SLICES}`}
              value={slices}
              onChange={(event) => {
                setSlices(event.target.value);
              }}
              className={inputClass(false)}
            />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span className="text-phosphor-dim">INTERVAL (s)</span>
            <input
              type="text"
              inputMode="numeric"
              aria-label="TWAP interval seconds"
              title={`${TWAP_MIN_INTERVAL_S} to ${TWAP_MAX_INTERVAL_S}`}
              value={intervalS}
              onChange={(event) => {
                setIntervalS(event.target.value);
              }}
              className={inputClass(false)}
            />
          </label>
        </>
      )}
      <div className="flex flex-col gap-0.5">
        <input
          type="range"
          aria-label="Percent of balance or position"
          min={0}
          max={100}
          step={25}
          value={percent}
          onChange={(event) => {
            applyPercent(Number(event.target.value));
          }}
        />
        <div className="flex justify-between text-phosphor-dim">
          {SLIDER_STEPS.map((step) => (
            <button
              key={step}
              type="button"
              onClick={() => {
                applyPercent(step);
              }}
              className={percent === step ? "text-amber" : ""}
            >
              {step}%
            </button>
          ))}
        </div>
      </div>
      <div className="flex justify-between">
        <span className="text-phosphor-dim">TOTAL</span>
        <span>{total === null ? "—" : `$${formatMoney(total.toString())}`}</span>
      </div>
      <button
        type="button"
        onClick={() => {
          if (!command.ok) {
            useTerminalStore.getState().addRejection(command.error);
            return;
          }
          actions.submitCommand(command.text);
        }}
        className={`crt-panel px-2 py-1 ${side === "buy" ? "text-buy" : "text-sell"}`}
      >
        {side === "buy" ? "Buy" : "Sell"} {symbol.split("-")[0]}
      </button>
    </div>
  );
}
