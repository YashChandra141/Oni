// Pure helpers for the chart (Task 5.4, Req 25.1-25.4). No DOM and no chart library at runtime:
// only a type import of `UTCTimestamp`, so these functions are tested without a browser.
//
// DISPLAY BOUNDARY: Price and Qty arrive as decimal strings of integer tick/lot counts
// (tech.md). The chart library only takes JS numbers, so `unitsToNumber` converts exactly with
// BigInt (via `formatUnits`) and then parses the exact decimal text into a double. The result
// is for drawing only. Never use these numbers for order, risk, or P&L math.

import type { UTCTimestamp } from "lightweight-charts";
import type { Bar, Timeframe } from "../../shared/protocol/index";
import { formatUnits } from "./format";

/** The timeframes in button order. Keys 1 to 5 select the entry at the same position (Req 25.3). */
export const timeframeLabels: readonly Timeframe[] = ["1m", "5m", "15m", "1h", "1d"];

export function isTimeframe(value: string): value is Timeframe {
  return (timeframeLabels as readonly string[]).includes(value);
}

/** Maps the key "1".."5" to its timeframe (`"1"` -> `"1m"`), or null for any other key. */
export function timeframeFromKey(key: string): Timeframe | null {
  if (key.length !== 1) return null;
  const index = key.charCodeAt(0) - "1".charCodeAt(0);
  if (index < 0 || index >= timeframeLabels.length) return null;
  return timeframeLabels[index] ?? null;
}

/** CRT colours, the same values as the theme tokens in app/globals.css. */
export const CHART_THEME = {
  background: "#000000",
  /** --color-phosphor-dim */
  text: "#1f9e40",
  /** --color-crt-line */
  grid: "#0f3d1c",
  /** --color-phosphor-dim */
  crosshair: "#1f9e40",
  /** --color-buy / --color-phosphor */
  up: "#33ff66",
  /** --color-sell */
  down: "#ff4d4d",
  volumeUp: "rgba(51, 255, 102, 0.35)",
  volumeDown: "rgba(255, 77, 77, 0.35)",
  fontFamily: 'ui-monospace, "Cascadia Mono", "Cascadia Code", Menlo, Consolas, monospace',
} as const;

/** Internal fixed decimals (tech.md), used until `hello` supplies the instrument table. */
export const DEFAULT_PRICE_DECIMALS = 2;
export const DEFAULT_QTY_DECIMALS = 8;

const INTEGER = /^-?\d+$/;

/**
 * Converts an integer count of 10^-decimals units (a decimal string) to a JS number for display.
 * The scaling is exact (BigInt); only the final parse can round to the nearest double.
 * Returns null for a malformed string or unsupported `decimals`.
 */
export function unitsToNumber(raw: string, decimals: number): number | null {
  const text = formatUnits(raw, decimals);
  if (text === null) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Whether a bar closed at or above its open, compared exactly as integers; null if malformed. */
function isUpBar(open: string, close: string): boolean | null {
  if (!INTEGER.test(open) || !INTEGER.test(close)) return null;
  return BigInt(close) >= BigInt(open);
}

/** Bar start time (ms) to chart time (whole UTC seconds), or null when not a valid time. */
function toChartTime(ms: number): UTCTimestamp | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 1000) as UTCTimestamp;
}

export interface CandlePoint {
  readonly time: UTCTimestamp;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface VolumePoint {
  readonly time: UTCTimestamp;
  readonly value: number;
  readonly color: string;
}

/** One bar as a candlestick point, or null if any field is malformed. */
export function barToCandle(bar: Bar, priceDecimals: number): CandlePoint | null {
  const time = toChartTime(bar.t);
  const open = unitsToNumber(bar.open, priceDecimals);
  const high = unitsToNumber(bar.high, priceDecimals);
  const low = unitsToNumber(bar.low, priceDecimals);
  const close = unitsToNumber(bar.close, priceDecimals);
  if (time === null || open === null || high === null || low === null || close === null) return null;
  return { time, open, high, low, close };
}

/** One bar as a volume point coloured by close vs open, or null if any field is malformed. */
export function barToVolume(bar: Bar, qtyDecimals: number): VolumePoint | null {
  const time = toChartTime(bar.t);
  const value = unitsToNumber(bar.volume, qtyDecimals);
  const up = isUpBar(bar.open, bar.close);
  if (time === null || value === null || up === null) return null;
  return { time, value, color: up ? CHART_THEME.volumeUp : CHART_THEME.volumeDown };
}

/** Sorts ascending by time and keeps the last item of any run with equal times. */
function sortAndDedupe<T extends { readonly time: number }>(items: readonly T[]): T[] {
  const sorted = items.slice().sort((a, b) => a.time - b.time);
  const out: T[] = [];
  for (const item of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && last.time === item.time) out[out.length - 1] = item;
    else out.push(item);
  }
  return out;
}

/** Candlestick data: valid bars only, ascending by time, one point per time (last wins). */
export function barsToCandles(bars: readonly Bar[], priceDecimals: number): CandlePoint[] {
  const points: CandlePoint[] = [];
  for (const bar of bars) {
    const point = barToCandle(bar, priceDecimals);
    if (point !== null) points.push(point);
  }
  return sortAndDedupe(points);
}

/** Volume histogram data, ordered and de-duplicated the same way as `barsToCandles`. */
export function barsToVolume(bars: readonly Bar[], qtyDecimals: number): VolumePoint[] {
  const points: VolumePoint[] = [];
  for (const bar of bars) {
    const point = barToVolume(bar, qtyDecimals);
    if (point !== null) points.push(point);
  }
  return sortAndDedupe(points);
}

/** Price-scale format for an instrument's price decimals: `2` -> precision 2, minMove 0.01. */
export function priceFormatFor(decimals: number): {
  readonly type: "price";
  readonly precision: number;
  readonly minMove: number;
} {
  const valid = Number.isInteger(decimals) && decimals >= 0 && decimals <= 8;
  const precision = valid ? decimals : DEFAULT_PRICE_DECIMALS;
  const minMove = precision === 0 ? 1 : Number(`0.${"0".repeat(precision - 1)}1`);
  return { type: "price", precision, minMove };
}

/** `1700000000` -> `"2023-11-14 22:13 UTC"`. Chart times are UTC seconds. */
export function formatChartTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Fixed-decimals text for a display number (crosshair readout). */
export function formatDisplayNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return "—";
  const places = Number.isInteger(decimals) && decimals >= 0 && decimals <= 20 ? decimals : 2;
  return value.toFixed(places);
}

// ---------------------------------------------------------------------------------------------
// Deciding between `setData` and `update`

/** What was last given to the chart: enough to tell a live tick from a replaced list. */
export interface SeriesShape {
  readonly key: string;
  readonly count: number;
  readonly firstTime: number | null;
  readonly lastTime: number | null;
}

export function seriesShape(key: string, points: readonly { readonly time: number }[]): SeriesShape {
  const first = points[0];
  const last = points[points.length - 1];
  return {
    key,
    count: points.length,
    firstTime: first === undefined ? null : first.time,
    lastTime: last === undefined ? null : last.time,
  };
}

export type SeriesPlan = "set" | "update";

/**
 * `set` (replace the whole array) unless `next` differs from `prev` only in the last bar: same
 * key, same count, same first time, same last time, and at least one bar. Then `update` on the
 * last bar is enough. A change to a bar in the middle of the list is not detected here (the
 * store only changes the last bar, or the list length, apart from late revisions).
 */
export function planSeriesUpdate(prev: SeriesShape | null, next: SeriesShape): SeriesPlan {
  if (prev === null) return "set";
  if (next.count === 0) return "set";
  if (prev.key !== next.key) return "set";
  if (prev.count !== next.count) return "set";
  if (prev.firstTime !== next.firstTime) return "set";
  if (prev.lastTime !== next.lastTime) return "set";
  return "update";
}

// ---------------------------------------------------------------------------------------------
// Reading crosshair data

export interface Ohlc {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

/** Reads `open/high/low/close` numbers from an untyped series data item, or null. */
export function readOhlc(data: unknown): Ohlc | null {
  if (typeof data !== "object" || data === null) return null;
  const item = data as Record<string, unknown>;
  const { open, high, low, close } = item;
  if (
    typeof open !== "number" ||
    typeof high !== "number" ||
    typeof low !== "number" ||
    typeof close !== "number"
  ) {
    return null;
  }
  return { open, high, low, close };
}

/** Reads the `value` number from an untyped series data item (histogram point), or null. */
export function readValue(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const { value } = data as Record<string, unknown>;
  return typeof value === "number" ? value : null;
}
