// Pure helpers for the indicator overlays and the RSI/ATR pane (Task 9.3, Req 26.1-26.4).
// No DOM and no chart library at runtime: only type imports, so tests need no browser.
//
// Units (engine/src/indicators.rs module header): EMA, SMA, VWAP, the Bollinger bands, and ATR
// arrive in TICKS as f64 numbers; RSI is a plain 0 to 100 number.
//
// DISPLAY BOUNDARY: `lineValueToDisplay` divides tick values by 10^priceDecimals so the lines sit
// on the same price scale as the candles (lib/chartData.ts draws prices the same way). This is
// display math only. Never use these numbers for order, risk, or P&L math.

import type { UTCTimestamp } from "lightweight-charts";
import type { Action } from "../../shared/keymap";
import type { IndicatorPoint } from "../../shared/protocol/index";

/** The toggles, in button order (Req 26.3). */
export const INDICATOR_NAMES = ["ema", "vwap", "bollinger", "rsi", "atr"] as const;
export type IndicatorName = (typeof INDICATOR_NAMES)[number];

export type IndicatorToggles = Readonly<Record<IndicatorName, boolean>>;

/** Defaults: EMA, VWAP, and RSI on; Bollinger and ATR off. */
export const DEFAULT_INDICATOR_TOGGLES: IndicatorToggles = {
  ema: true,
  vwap: true,
  bollinger: false,
  rsi: true,
  atr: false,
};

/** One Indicators event as kept by the store: the candle open time (ms) and its values. */
export type { IndicatorPoint };

/** Most indicator points kept per symbol and timeframe (same as candles, Req 8.7). */
export const MAX_INDICATOR_POINTS = 500;

/** One drawn line. Bollinger is three lines; SMA is not drawn. */
export type IndicatorLine = "ema" | "vwap" | "bb_upper" | "bb_mid" | "bb_lower" | "rsi" | "atr";

/** The lines each toggle shows, in drawing order. */
export const INDICATOR_LINES: Readonly<Record<IndicatorName, readonly IndicatorLine[]>> = {
  ema: ["ema"],
  vwap: ["vwap"],
  bollinger: ["bb_upper", "bb_mid", "bb_lower"],
  rsi: ["rsi"],
  atr: ["atr"],
};

/** Overlays share the candles' price scale in pane 0; RSI and ATR go in pane 1. */
export const OVERLAY_LINES: readonly IndicatorLine[] = ["ema", "vwap", "bb_upper", "bb_mid", "bb_lower"];
export const PANE_LINES: readonly IndicatorLine[] = ["rsi", "atr"];
export const ALL_LINES: readonly IndicatorLine[] = [...OVERLAY_LINES, ...PANE_LINES];

/** The chart pane of a line: 0 for the price overlays, 1 for the RSI/ATR sub-pane. */
export function paneOfLine(line: IndicatorLine): 0 | 1 {
  return line === "rsi" || line === "atr" ? 1 : 0;
}

/** RSI guide levels drawn in the sub-pane. */
export const RSI_GUIDES: readonly number[] = [70, 30];

/** Short labels for the toggle buttons. */
export const INDICATOR_LABELS: Readonly<Record<IndicatorName, string>> = {
  ema: "EMA",
  vwap: "VWAP",
  bollinger: "BB",
  rsi: "RSI",
  atr: "ATR",
};

/** The keys bound in shared/keymap.json, for button titles only (the keymap does the binding). */
export const INDICATOR_HOTKEYS: Readonly<Record<IndicatorName, string>> = {
  ema: "E",
  vwap: "W",
  bollinger: "O",
  rsi: "R",
  atr: "T",
};

/** Labels for the legend, one per line. */
export const LINE_LABELS: Readonly<Record<IndicatorLine, string>> = {
  ema: "EMA",
  vwap: "VWAP",
  bb_upper: "BB+",
  bb_mid: "BB",
  bb_lower: "BB-",
  rsi: "RSI",
  atr: "ATR",
};

/** Oni colours: EMA amber, VWAP cyan, Bollinger muted red, RSI magenta, ATR orange. */
export const LINE_COLORS: Readonly<Record<IndicatorLine, string>> = {
  ema: "#ffb000",
  vwap: "#33e6ff",
  bb_upper: "#a14048",
  bb_mid: "#6e2a30",
  bb_lower: "#a14048",
  rsi: "#ff4dff",
  atr: "#ff8c1a",
};

/** The keymap action for each toggle (shared/keymap.json: E, W, O, R, T). */
const ACTION_TO_TOGGLE: Readonly<Partial<Record<Action, IndicatorName>>> = {
  "indicator.ema": "ema",
  "indicator.vwap": "vwap",
  "indicator.bollinger": "bollinger",
  "indicator.rsi": "rsi",
  "indicator.atr": "atr",
};

/** Maps a keymap `indicator.*` action to its toggle name, or null for any other action. */
export function toggleFromAction(action: Action): IndicatorName | null {
  return ACTION_TO_TOGGLE[action] ?? null;
}

export function isIndicatorName(value: string): value is IndicatorName {
  return (INDICATOR_NAMES as readonly string[]).includes(value);
}

/** The toggle that controls a line. */
export function toggleOfLine(line: IndicatorLine): IndicatorName {
  switch (line) {
    case "ema":
      return "ema";
    case "vwap":
      return "vwap";
    case "bb_upper":
    case "bb_mid":
    case "bb_lower":
      return "bollinger";
    case "rsi":
      return "rsi";
    case "atr":
      return "atr";
  }
}

/** Valid price decimals are integers 0 to 8; anything else falls back to 2 (tech.md). */
function validDecimals(decimals: number): number {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 8 ? decimals : 2;
}

/**
 * Converts one raw indicator value to a display number: RSI passes through, every other line is
 * ticks divided by 10^priceDecimals. Null, NaN, and infinities give null. Display math only.
 */
export function lineValueToDisplay(
  line: IndicatorLine,
  raw: number | null | undefined,
  priceDecimals: number,
): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (line === "rsi") return raw;
  const value = raw / 10 ** validDecimals(priceDecimals);
  return Number.isFinite(value) ? value : null;
}

export interface IndicatorLinePoint {
  readonly time: UTCTimestamp;
  readonly value: number;
}

/**
 * Line-series data for one line: points with a value only (nulls skipped), ascending by time,
 * one point per chart time (the last wins). Times are whole UTC seconds.
 */
export function indicatorLineData(
  points: readonly IndicatorPoint[],
  line: IndicatorLine,
  priceDecimals: number,
  candleTimesMs?: ReadonlySet<number>,
): IndicatorLinePoint[] {
  const out: IndicatorLinePoint[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.t) || point.t < 0) continue;
    if (candleTimesMs !== undefined && !candleTimesMs.has(point.t)) continue;
    const value = lineValueToDisplay(line, point.values[line], priceDecimals);
    if (value === null) continue;
    out.push({ time: Math.floor(point.t / 1000) as UTCTimestamp, value });
  }
  out.sort((a, b) => a.time - b.time);
  const deduped: IndicatorLinePoint[] = [];
  for (const item of out) {
    const last = deduped[deduped.length - 1];
    if (last !== undefined && last.time === item.time) deduped[deduped.length - 1] = item;
    else deduped.push(item);
  }
  return deduped;
}

/** A chart time with no value: `series.update` of it clears the point at that time. */
export interface IndicatorLineGap {
  readonly time: UTCTimestamp;
}

/**
 * Incremental updates for one line (Req 2.8): like `indicatorLineData`, plus a gap item for each
 * stored point whose value is now null and whose time has no value point. Without it a value that
 * turns null would stay on the chart, where a full `setData` would drop it.
 */
export function indicatorLineUpdates(
  points: readonly IndicatorPoint[],
  line: IndicatorLine,
  priceDecimals: number,
  candleTimesMs?: ReadonlySet<number>,
): (IndicatorLinePoint | IndicatorLineGap)[] {
  const values = indicatorLineData(points, line, priceDecimals, candleTimesMs);
  const valued = new Set<number>(values.map((v) => v.time));
  const gaps = new Map<number, IndicatorLineGap>();
  for (const point of points) {
    if (!Number.isFinite(point.t) || point.t < 0) continue;
    if (candleTimesMs !== undefined && !candleTimesMs.has(point.t)) continue;
    const time = Math.floor(point.t / 1000) as UTCTimestamp;
    if (!valued.has(time)) gaps.set(time, { time });
  }
  const out: (IndicatorLinePoint | IndicatorLineGap)[] = [...values, ...gaps.values()];
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** The newest non-null display value of a line, or null when there is none. */
export function latestLineValue(
  points: readonly IndicatorPoint[],
  line: IndicatorLine,
  priceDecimals: number,
): number | null {
  let bestT = -Infinity;
  let best: number | null = null;
  for (const point of points) {
    const value = lineValueToDisplay(line, point.values[line], priceDecimals);
    if (value !== null && point.t >= bestT) {
      bestT = point.t;
      best = value;
    }
  }
  return best;
}

/** Legend text for a value: RSI with 2 decimals, price-like lines with the price decimals. */
export function formatIndicatorValue(
  line: IndicatorLine,
  value: number | null,
  priceDecimals: number,
): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(line === "rsi" ? 2 : validDecimals(priceDecimals));
}

export interface LegendEntry {
  readonly line: IndicatorLine;
  readonly label: string;
  readonly color: string;
  readonly text: string;
}

/** One legend entry per line of every enabled toggle, in button order (Req 26.4). */
export function legendEntries(
  points: readonly IndicatorPoint[],
  toggles: IndicatorToggles,
  priceDecimals: number,
): LegendEntry[] {
  const entries: LegendEntry[] = [];
  for (const name of INDICATOR_NAMES) {
    if (!toggles[name]) continue;
    for (const line of INDICATOR_LINES[name]) {
      entries.push({
        line,
        label: LINE_LABELS[line],
        color: LINE_COLORS[line],
        text: formatIndicatorValue(line, latestLineValue(points, line, priceDecimals), priceDecimals),
      });
    }
  }
  return entries;
}
