// MCP tool definitions (design "MCP server (Req 24)", Task 14.1, Req 24.1-24.7).
//
// Five tools: get_quote, get_candles, get_positions, preview_order, place_paper_order. Each has
// - `inputShape`: the Zod raw shape advertised to MCP clients (plain types only, so the SDK can
//   turn it into JSON Schema), and
// - `run(args)`: validates `args` again with the stricter `parse` schema (short symbols resolved,
//   defaults applied) and calls the TerminalApi. It never throws.
//
// Results are one text content block with pretty JSON. Failures are `isError: true` results
// with a short message: invalid arguments name the field and the rule (Req 24.7), never echo
// the value; server errors, timeouts, and rejections say what happened. No stack traces, no
// tokens (trading-safety rule 6).
//
// Safety: everything is paper trading. place_paper_order sends command text plus a confirm over
// the server's WebSocket protocol, so the Router and Risk_Engine decide (trading-safety rules
// 2-4). No tool takes an account id (rule 10).

import { z } from "zod";
import { MAX_COMMAND_LENGTH, resolveSymbol } from "../commands/parser.ts";
import { INSTRUMENTS, instrumentBySymbol } from "../instruments.ts";
import { type OrderPreview, TimeframeSchema, formatDecimal } from "../protocol.ts";
import { MONEY_DECIMALS } from "../risk/limits.ts";
import type {
  CandlesResponse,
  FillSummary,
  PlaceOutcome,
  PositionsResponse,
  QuoteResponse,
  TerminalApi,
} from "./client.ts";
import { TerminalError } from "./client.ts";

/** The MCP CallToolResult subset these tools return. */
export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export interface ToolDef {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Advertised argument shape (Zod raw shape). */
  readonly inputShape: Record<string, z.ZodType>;
  /** Validates and runs. Never throws. */
  run(args: unknown): Promise<ToolResult>;
}

export const MAX_CANDLES = 500;
export const DEFAULT_CANDLES = 100;

const SYMBOL_LIST = INSTRUMENTS.map((i) => i.symbol).join(", ");
const SHORT_LIST = INSTRUMENTS.map((i) => i.short).join(", ");

// ---------------------------------------------------------------------------------------------
// Argument schemas
// ---------------------------------------------------------------------------------------------

const symbolAdvertised = z
  .string()
  .min(1)
  .max(16)
  .describe(`Instrument: ${SYMBOL_LIST}, or the short name ${SHORT_LIST}. Case-insensitive.`);

/** Accepts BTC, btc, BTC-USD, ... and yields the full symbol. */
const symbolParsed = z
  .string()
  .min(1)
  .max(16)
  .transform((value, ctx) => {
    const info = resolveSymbol(value.trim());
    if (info === undefined) {
      ctx.addIssue({ code: "custom", message: `unknown symbol; expected one of ${SYMBOL_LIST} (or ${SHORT_LIST})` });
      return z.NEVER;
    }
    return info.symbol;
  });

const timeframeAdvertised = TimeframeSchema.describe("Candle timeframe: 1m, 5m, 15m, 1h, or 1d.");
const limitAdvertised = z
  .number()
  .int()
  .min(1)
  .max(MAX_CANDLES)
  .optional()
  .describe(`Number of most recent candles, 1 to ${MAX_CANDLES}. Default ${DEFAULT_CANDLES}.`);

const COMMAND_HELP =
  "Order command in the terminal's command bar syntax: `BUY|SELL <symbol> <qty> [LMT <price> | STP <price>]`, " +
  "`BUY|SELL <symbol> <percent>%` (percent of the current position, market order), `CANCEL ALL`, or `FLAT` " +
  "(close all positions). Examples: `BUY BTC 0.01`, `SELL ETH 0.5 LMT 3500`, `BUY SOL 2 STP 180.25`, " +
  "`SELL BTC 50%`, `CANCEL ALL`, `FLAT`. Text starting with `?` is a plain-English order and needs the " +
  "server's OPENAI_API_KEY.";

const commandAdvertised = z.string().min(1).max(MAX_COMMAND_LENGTH).describe(COMMAND_HELP);
const commandParsed = z
  .string()
  .max(MAX_COMMAND_LENGTH)
  .refine((s) => s.trim().length > 0, "command must not be empty");

const QuoteArgs = z.object({ symbol: symbolParsed });
const CandlesArgs = z.object({
  symbol: symbolParsed,
  timeframe: TimeframeSchema,
  limit: z.number().int().min(1).max(MAX_CANDLES).default(DEFAULT_CANDLES),
});
const NoArgs = z.object({});
const CommandArgs = z.object({ command: commandParsed });

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

export function okResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(message: string, data?: unknown): ToolResult {
  const text = data === undefined ? message : `${message}\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: "text", text }], isError: true };
}

/** "symbol: unknown symbol; …" for the first few issues. Paths and rules only, never values. */
export function describeArgIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.map(String).join(".");
    return path === "" ? issue.message : `${path}: ${issue.message}`;
  });
  return `Invalid arguments: ${parts.join("; ")}`;
}

/** Maps any thrown value to a safe error result. Only TerminalError messages are shown. */
export function failureResult(err: unknown): ToolResult {
  if (err instanceof TerminalError) {
    if (err.kind === "http" && err.code === "no_data") {
      return errorResult(
        "No market data cached for this symbol and timeframe yet. Open it in the web UI or TUI so the server subscribes, then retry.",
      );
    }
    if (err.kind === "unauthorized") {
      // Req 24.11: static text only, never the token value.
      return errorResult(
        "Error (unauthorized): terminal token rejected. Check TERMINAL_TOKEN (it may have expired or been signed out) or unset it to use the guest account.",
      );
    }
    return errorResult(`Error (${err.kind}): ${err.message}`);
  }
  return errorResult("Error (internal): the MCP tool failed unexpectedly");
}

// Display helpers: protocol integers → exact decimal strings (never Number).

function priceText(symbol: string, ticks: string): string {
  const info = instrumentBySymbol(symbol);
  return info === undefined ? ticks : formatDecimal(ticks, info.price_decimals);
}

function qtyText(symbol: string, lots: string): string {
  const info = instrumentBySymbol(symbol);
  return info === undefined ? lots : formatDecimal(lots, info.qty_decimals);
}

function moneyText(money: string): string {
  return formatDecimal(money, MONEY_DECIMALS);
}

export function formatQuote(q: QuoteResponse) {
  const s = q.symbol;
  const level = (l: { price: string; qty: string } | null) =>
    l === null ? null : { price: priceText(s, l.price), qty: qtyText(s, l.qty) };
  return {
    symbol: s,
    best_bid: q.book === null ? null : level(q.book.bid),
    best_ask: q.book === null ? null : level(q.book.ask),
    spread: q.book === null || q.book.spread === null ? null : priceText(s, q.book.spread),
    last:
      q.last === null
        ? null
        : {
            price: priceText(s, q.last.price),
            qty: qtyText(s, q.last.qty),
            side: q.last.side,
            time: new Date(q.last.ts).toISOString(),
          },
  };
}

export function formatCandles(c: CandlesResponse) {
  const s = c.symbol;
  return {
    symbol: s,
    timeframe: c.timeframe,
    count: c.bars.length,
    bars: c.bars.map((b) => ({
      time: new Date(b.t).toISOString(),
      open: priceText(s, b.open),
      high: priceText(s, b.high),
      low: priceText(s, b.low),
      close: priceText(s, b.close),
      volume: qtyText(s, b.volume),
    })),
  };
}

export function formatPositions(rows: PositionsResponse) {
  return {
    paper: true,
    positions: rows.map((p) => ({
      symbol: p.symbol,
      qty: qtyText(p.symbol, p.qty),
      avg_entry: p.avg_entry === null ? null : priceText(p.symbol, p.avg_entry),
      realized_pnl_usd: moneyText(p.realized),
      unrealized_pnl_usd: moneyText(p.unrealized),
    })),
  };
}

export function formatPreview(p: OrderPreview) {
  const a = p.action;
  const order =
    a.type === "place"
      ? {
          type: a.kind.type,
          side: a.side,
          symbol: a.symbol,
          qty: qtyText(a.symbol, a.qty),
          ...(a.kind.type === "limit" ? { limit_price: priceText(a.symbol, a.kind.price) } : {}),
          ...(a.kind.type === "stop" ? { stop_price: priceText(a.symbol, a.kind.stop_price) } : {}),
        }
      : { type: a.type };
  return {
    paper: true,
    placed: false,
    preview: p.text,
    order,
    note: "Preview only; nothing was placed. Call place_paper_order with the same command to place this paper order.",
  };
}

function formatFill(f: FillSummary) {
  return {
    order_id: f.order_id,
    side: f.side,
    price: priceText(f.symbol, f.price),
    qty: qtyText(f.symbol, f.qty),
    fee_usd: moneyText(f.fee),
    remaining: qtyText(f.symbol, f.remaining),
    time: new Date(f.ts).toISOString(),
  };
}

export function formatOutcome(o: PlaceOutcome) {
  return {
    paper: true,
    command: o.command,
    action: o.action,
    status: o.status,
    order_id: o.order_id,
    reason: o.reason,
    fills: o.fills.map(formatFill),
    acks: o.acks,
    rejections: o.rejections,
  };
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

function tool<S extends z.ZodType>(
  def: Omit<ToolDef, "run">,
  schema: S,
  handler: (args: z.output<S>) => Promise<ToolResult>,
): ToolDef {
  return {
    ...def,
    async run(args: unknown): Promise<ToolResult> {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) return errorResult(describeArgIssues(parsed.error));
      try {
        return await handler(parsed.data);
      } catch (err) {
        return failureResult(err);
      }
    },
  };
}

const PAPER = "Oni is a PAPER-trading terminal: simulated accounts only, no real funds, no real orders.";

/** The five MCP tools (Req 24.1), bound to one TerminalApi. */
export function createTools(api: TerminalApi): ToolDef[] {
  return [
    tool(
      {
        name: "get_quote",
        title: "Get quote",
        description: `${PAPER} Returns the best bid, best ask, spread, and last trade price for a symbol from the terminal's market data.`,
        inputShape: { symbol: symbolAdvertised },
      },
      QuoteArgs,
      async ({ symbol }) => okResult(formatQuote(await api.quote(symbol))),
    ),
    tool(
      {
        name: "get_candles",
        title: "Get candles",
        description: `${PAPER} Returns recent OHLCV candles (oldest first) for a symbol and timeframe.`,
        inputShape: { symbol: symbolAdvertised, timeframe: timeframeAdvertised, limit: limitAdvertised },
      },
      CandlesArgs,
      async ({ symbol, timeframe, limit }) => okResult(formatCandles(await api.candles(symbol, timeframe, limit))),
    ),
    tool(
      {
        name: "get_positions",
        title: "Get paper positions",
        description: `${PAPER} Returns the positions and P&L of this MCP connection's paper account.`,
        inputShape: {},
      },
      NoArgs,
      async () => okResult(formatPositions(await api.positions())),
    ),
    tool(
      {
        name: "preview_order",
        title: "Preview paper order",
        description: `${PAPER} Parses an order command on the server and returns its preview. Places nothing.`,
        inputShape: { command: commandAdvertised },
      },
      CommandArgs,
      async ({ command }) => okResult(formatPreview(await api.preview(command))),
    ),
    tool(
      {
        name: "place_paper_order",
        title: "Place paper order",
        description:
          `${PAPER} Places a PAPER order: the server previews the command, this tool confirms it, and the ` +
          "server's risk checks (order value, position, open orders, price band, rate limit, kill switch) " +
          "approve or reject it before the paper matcher fills it. Returns the status, fills, or rejection reason.",
        inputShape: { command: commandAdvertised },
      },
      CommandArgs,
      async ({ command }) => {
        const outcome = await api.place(command);
        const view = formatOutcome(outcome);
        if (outcome.status === "rejected") {
          return errorResult(`Paper order rejected: ${outcome.reason ?? "unknown reason"}`, view);
        }
        return okResult(view);
      },
    ),
  ];
}
