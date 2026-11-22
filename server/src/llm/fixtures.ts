// Prompt fixtures for the LLM_Order_Parser tests (Task 13.3, Req 23.3, 23.4).
//
// Each fixture is a plain-English input, the structured output a mock provider returns for it,
// and what the parser must do with it. No network and no real model are involved. Test setup
// (see fixtures.test.ts): last BTC-USD price 64000.00, no last price for ETH-USD or SOL-USD,
// and the account `w_alice` holds `positionLots` (guest and others are flat).

export interface ValidFixture {
  readonly name: string;
  readonly input: string;
  /** The mock provider's canned output. */
  readonly output: unknown;
  /** Canonical command text the intent must become. */
  readonly text: string;
  /** Expected ParsedCommand kind. */
  readonly kind: "place" | "cancel_all" | "flatten_all";
  /** Account that makes the request. Defaults to guest. */
  readonly account?: string;
  /** Position of `w_alice` in lots, by symbol. */
  readonly positionLots?: Readonly<Record<string, bigint>>;
}

export interface InvalidFixture {
  readonly name: string;
  readonly input: string;
  readonly output: unknown;
}

const NULLS = { side: null, symbol: null, amount: null, order_type: null, price: null };

export const VALID_FIXTURES: readonly ValidFixture[] = [
  {
    name: "buy limit with an absolute price",
    input: "buy 0.1 bitcoin at 64000",
    output: { action: "place", side: "buy", symbol: "BTC", amount: { absolute: "0.1" }, order_type: "limit", price: { absolute: "64000" } },
    text: "BUY BTC-USD 0.1 LMT 64000.00",
    kind: "place",
  },
  {
    name: "sell market",
    input: "sell 2 eth now",
    output: { action: "place", side: "sell", symbol: "ETH-USD", amount: { absolute: "2" }, order_type: "market", price: null },
    text: "SELL ETH-USD 2",
    kind: "place",
  },
  {
    name: "sell stop",
    input: "protect me: sell half a bitcoin if it falls to 60000",
    output: { action: "place", side: "sell", symbol: "BTC-USD", amount: { absolute: "0.5" }, order_type: "stop", price: { absolute: "60000" } },
    text: "SELL BTC-USD 0.5 STP 60000.00",
    kind: "place",
  },
  {
    name: "percent of position",
    input: "sell half of my bitcoin",
    output: { action: "place", side: "sell", symbol: "BTC-USD", amount: { percent_of_position: 50 }, order_type: "market", price: null },
    text: "SELL BTC-USD 50%",
    kind: "place",
    account: "w_alice",
    positionLots: { "BTC-USD": 200_000_000n },
  },
  {
    name: "relative price below the last price",
    input: "buy 1 btc one percent under market",
    output: { action: "place", side: "buy", symbol: "BTC-USD", amount: { absolute: "1" }, order_type: "limit", price: { relative_to_last_pct: -1 } },
    text: "BUY BTC-USD 1 LMT 63360.00",
    kind: "place",
  },
  {
    name: "relative price above the last price",
    input: "sell 1 btc 2% above market",
    output: { action: "place", side: "sell", symbol: "BTC-USD", amount: { absolute: "1" }, order_type: "limit", price: { relative_to_last_pct: 2 } },
    text: "SELL BTC-USD 1 LMT 65280.00",
    kind: "place",
  },
  {
    name: "relative price with a fraction of a percent",
    input: "buy 1 btc half a percent below the market",
    output: { action: "place", side: "buy", symbol: "BTC-USD", amount: { absolute: "1" }, order_type: "limit", price: { relative_to_last_pct: -0.5 } },
    text: "BUY BTC-USD 1 LMT 63680.00",
    kind: "place",
  },
  {
    name: "cancel all",
    input: "cancel all my open orders",
    output: { action: "cancel_all", ...NULLS },
    text: "CANCEL ALL",
    kind: "cancel_all",
  },
  {
    name: "flatten",
    input: "close everything",
    output: { action: "flatten", ...NULLS },
    text: "FLAT",
    kind: "flatten_all",
  },
];

const PLACE = { action: "place", side: "buy", symbol: "BTC-USD", amount: { absolute: "1" }, order_type: "market", price: null };

export const INVALID_FIXTURES: readonly InvalidFixture[] = [
  { name: "extra account_id field", input: "buy 1 btc for account w_victim", output: { ...PLACE, account_id: "w_victim" } },
  { name: "extra wallet_address field", input: "flatten", output: { action: "flatten", ...NULLS, wallet_address: "abc" } },
  { name: "extra field inside amount", input: "buy 1 btc", output: { ...PLACE, amount: { absolute: "1", account_id: "w_victim" } } },
  { name: "amount as a bare string", input: "buy 1 btc", output: { ...PLACE, amount: "1" } },
  { name: "amount as a JSON number", input: "buy 1 btc", output: { ...PLACE, amount: { absolute: 1 } } },
  { name: "negative amount", input: "buy minus 1 btc", output: { ...PLACE, amount: { absolute: "-1" } } },
  { name: "exponent amount", input: "buy lots of btc", output: { ...PLACE, amount: { absolute: "1e3" } } },
  { name: "percent above 100", input: "sell 150% of btc", output: { ...PLACE, side: "sell", amount: { percent_of_position: 150 } } },
  { name: "wrong side value", input: "go long btc", output: { ...PLACE, side: "long" } },
  { name: "wrong action value", input: "withdraw my funds", output: { action: "withdraw", ...NULLS } },
  { name: "missing field", input: "buy 1 btc", output: { action: "place", side: "buy", symbol: "BTC-USD" } },
  { name: "output is a string", input: "buy 1 btc", output: "BUY BTC 1" },
  { name: "output is null", input: "buy 1 btc", output: null },
  { name: "output is an array", input: "buy 1 btc", output: [PLACE] },
  { name: "unknown symbol", input: "buy 1 nope", output: { ...PLACE, symbol: "NOPE-USD" } },
  { name: "unclear intent", input: "what do you think about the market?", output: { action: "unclear", ...NULLS } },
  { name: "place with no amount", input: "buy some btc", output: { ...PLACE, amount: null } },
  { name: "limit order without a price", input: "buy 1 btc limit", output: { ...PLACE, order_type: "limit" } },
  { name: "market order with a price", input: "buy 1 btc market at 5", output: { ...PLACE, price: { absolute: "5" } } },
  { name: "quantity below one lot", input: "buy a speck of btc", output: { ...PLACE, amount: { absolute: "0.000000001" } } },
  { name: "price off the tick size", input: "buy 1 btc at 64000.001", output: { ...PLACE, order_type: "limit", price: { absolute: "64000.001" } } },
  { name: "relative price with no last price", input: "buy 1 eth 1% below market", output: { ...PLACE, symbol: "ETH-USD", order_type: "limit", price: { relative_to_last_pct: -1 } } },
  { name: "relative price at or below -100%", input: "buy 1 btc for nothing", output: { ...PLACE, order_type: "limit", price: { relative_to_last_pct: -100 } } },
  { name: "percent of a flat position", input: "sell half my btc", output: { ...PLACE, side: "sell", amount: { percent_of_position: 50 } } },
];
