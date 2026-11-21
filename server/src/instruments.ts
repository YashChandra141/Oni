// Instrument_Table for the Server (Req 8.1, 15.1). A thin loader of
// shared/protocol/instruments.json, which the protocol crate writes from `INSTRUMENTS` in
// rust/crates/protocol/src/instrument.rs (the source of truth; design Decision D14).
// The gateway sends it in `Hello` and uses it to reject subscriptions to unknown symbols.
//
// Regenerate the file with `bun run gen:protocol`. The file is read synchronously at import
// time and validated with Zod, so a missing or malformed file stops the Server at start.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { InstrumentInfoSchema, type InstrumentInfo } from "./protocol.ts";

const INSTRUMENTS_JSON = new URL("../../shared/protocol/instruments.json", import.meta.url);

function loadInstruments(): readonly InstrumentInfo[] {
  let text: string;
  try {
    text = readFileSync(INSTRUMENTS_JSON, "utf8");
  } catch {
    throw new Error(
      "shared/protocol/instruments.json is missing or unreadable. " +
        "Run `bun run gen:protocol` to generate it from the protocol crate.",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("shared/protocol/instruments.json is not valid JSON. Run `bun run gen:protocol`.");
  }
  const parsed = z.array(InstrumentInfoSchema).min(1).safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      "shared/protocol/instruments.json does not match the InstrumentInfo list. " +
        "Run `bun run gen:protocol`.",
    );
  }
  return Object.freeze(parsed.data.map((info) => Object.freeze(info)));
}

export const INSTRUMENTS: readonly InstrumentInfo[] = loadInstruments();

/** Looks up an instrument by its full symbol, e.g. `BTC-USD`. Case-sensitive, like the engine. */
export function instrumentBySymbol(symbol: string): InstrumentInfo | undefined {
  return INSTRUMENTS.find((i) => i.symbol === symbol);
}
