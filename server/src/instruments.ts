// Instrument_Table for the Server (Req 4.1). Mirrors `INSTRUMENTS` in
// rust/crates/protocol/src/instrument.rs, which is the source of truth; keep the two in step.
// The gateway sends it in `Hello` and uses it to reject subscriptions to unknown symbols.

import type { InstrumentInfo } from "./protocol.ts";

export const INSTRUMENTS: readonly InstrumentInfo[] = Object.freeze([
  Object.freeze({ symbol: "BTC-USD", short: "BTC", price_decimals: 2, qty_decimals: 8 }),
  Object.freeze({ symbol: "ETH-USD", short: "ETH", price_decimals: 2, qty_decimals: 8 }),
  Object.freeze({ symbol: "SOL-USD", short: "SOL", price_decimals: 2, qty_decimals: 8 }),
]);

/** Looks up an instrument by its full symbol, e.g. `BTC-USD`. Case-sensitive, like the engine. */
export function instrumentBySymbol(symbol: string): InstrumentInfo | undefined {
  return INSTRUMENTS.find((i) => i.symbol === symbol);
}
