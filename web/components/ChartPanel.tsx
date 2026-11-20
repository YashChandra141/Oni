"use client";

// Candlestick chart with volume (Task 5.4, Req 25, 29), built on TradingView Lightweight Charts
// 5.x. Load it through ChartPanelLoader (next/dynamic, ssr: false): this module touches the DOM
// only inside effects, but the library itself needs a browser.
//
// - Wheel zoom and drag pan come from the library (`handleScale` and `handleScroll`).
// - `+`, `-`, left, and right call `timeScale().setVisibleLogicalRange` with the math in
//   lib/chartRange.ts. Digits 1 to 5 call the store's `selectTimeframe`. Keys go through the
//   shared keymap (lib/chartKeys.ts); `+`, `-`, and the arrows apply only while the pointer is
//   over the chart or it has focus, so they never fight other panels.
// - The crosshair is the library's own (price and time labels on the axes) plus a readout that
//   shows time, cursor price, OHLC, and volume. Pointer only; there is no keyboard cursor.
// - Chart numbers are display-only conversions of the decimal strings (see lib/chartData.ts).
// - Indicators (Task 9.3, Req 26): EMA, VWAP, and the Bollinger lines are line series on the
//   candles' price scale in pane 0; RSI (fixed 0..100, 30/70 guides) and ATR (own left scale)
//   are line series in pane 1. A toggle that is off has no series, so its data never goes stale
//   and the sub-pane disappears when both RSI and ATR are off. Toggles: the buttons, or E, W,
//   O, R, T through the shared keymap. The legend shows the latest value of each enabled line
//   (lib/indicatorData.ts, display-only tick-to-price conversion).

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineSeriesPartialOptions,
  type MouseEventParams,
  type Time,
  type TickMarkType,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { Bar } from "../../shared/protocol/index";
import {
  CHART_THEME,
  DEFAULT_PRICE_DECIMALS,
  DEFAULT_QTY_DECIMALS,
  barsToCandles,
  barsToVolume,
  formatDisplayNumber,
  chartSyncState,
  planChartSync,
  shouldReposition,
  priceFormatFor,
  readOhlc,
  readValue,
  timeframeLabels,
  type ChartSyncState,
} from "../lib/chartData";
import { chartActionForKey, indicatorToggleForKey } from "../lib/chartKeys";
import {
  ALL_LINES,
  INDICATOR_HOTKEYS,
  INDICATOR_LABELS,
  INDICATOR_NAMES,
  LINE_COLORS,
  RSI_GUIDES,
  indicatorLineData,
  indicatorLineUpdates,
  legendEntries,
  paneOfLine,
  toggleOfLine,
  type IndicatorLine,
  type IndicatorPoint,
} from "../lib/indicatorData";
import {
  PAN_FRACTION,
  ZOOM_IN_FACTOR,
  ZOOM_OUT_FACTOR,
  initialVisibleRange,
  panRange,
  zoomRange,
} from "../lib/chartRange";
import { candleKey, useTerminalStore } from "../lib/store";
import { TIME_PLACEHOLDER, formatChartTime, tickMarkLabel } from "../lib/timeFormat";

const NO_BARS: readonly Bar[] = [];
const NO_INDICATORS: readonly IndicatorPoint[] = [];
/** Height of the RSI/ATR pane relative to the price pane (stretch factor 1). */
const SUB_PANE_STRETCH = 0.35;
const RSI_PRICE_FORMAT = { type: "price", precision: 2, minMove: 0.01 } as const;

/** Thin-line options for one indicator line (Req 26.1, 26.2). */
function lineOptions(line: IndicatorLine, priceDecimals: number): LineSeriesPartialOptions {
  const inPane = paneOfLine(line) === 1;
  const options: LineSeriesPartialOptions = {
    color: LINE_COLORS[line],
    lineWidth: 1,
    lineStyle: line === "bb_mid" ? LineStyle.Dotted : LineStyle.Solid,
    priceLineVisible: false,
    lastValueVisible: inPane,
    crosshairMarkerVisible: false,
    priceFormat: line === "rsi" ? RSI_PRICE_FORMAT : priceFormatFor(priceDecimals),
  };
  if (line === "rsi") {
    // RSI is fixed to 0..100 on the sub-pane's right scale.
    return {
      ...options,
      priceScaleId: "right",
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
    };
  }
  // ATR auto-scales on the sub-pane's left scale, so it never shares RSI's 0..100 range.
  if (line === "atr") return { ...options, priceScaleId: "left" };
  return options;
}

interface Readout {
  readonly time: string;
  readonly price: string;
  readonly ohlc: {
    readonly open: string;
    readonly high: string;
    readonly low: string;
    readonly close: string;
  } | null;
  readonly volume: string | null;
}

export default function ChartPanel() {
  const symbol = useTerminalStore((state) => state.selection.symbol);
  const timeframe = useTerminalStore((state) => state.selection.timeframe);
  const selectTimeframe = useTerminalStore((state) => state.selectTimeframe);
  const storedBars = useTerminalStore((state) => state.candles[candleKey(symbol, timeframe)]);
  const bars = storedBars ?? NO_BARS;
  const snapshotCount =
    useTerminalStore((state) => state.seriesVersion[candleKey(symbol, timeframe)]?.snapshot) ?? 0;
  const rewriteCount =
    useTerminalStore((state) => state.seriesVersion[candleKey(symbol, timeframe)]?.rewrite) ?? 0;
  const priceDecimals =
    useTerminalStore((state) => state.instruments[symbol]?.price_decimals) ?? DEFAULT_PRICE_DECIMALS;
  const qtyDecimals =
    useTerminalStore((state) => state.instruments[symbol]?.qty_decimals) ?? DEFAULT_QTY_DECIMALS;
  const storedIndicators = useTerminalStore(
    (state) => state.indicators[candleKey(symbol, timeframe)],
  );
  const indicatorPoints = storedIndicators ?? NO_INDICATORS;
  const toggles = useTerminalStore((state) => state.indicatorToggles);
  const toggleIndicator = useTerminalStore((state) => state.toggleIndicator);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  /** What the series currently holds; null before the first data and after a chart rebuild. */
  const appliedRef = useRef<ChartSyncState | null>(null);
  /** The symbol and timeframe the view was last positioned for. */
  const viewKeyRef = useRef<string | null>(null);
  /** True until the first non-empty data for the current view has set the visible range. */
  const needsFitRef = useRef(true);
  const decimalsRef = useRef({ price: priceDecimals, qty: qtyDecimals });
  const activeRef = useRef({ hover: false, focus: false });
  /** The indicator line series that exist now; a line toggled off has its series removed. */
  const linesRef = useRef<Partial<Record<IndicatorLine, ISeriesApi<"Line">>>>({});
  /** What the line series group currently holds (one state for all lines, as for the candles). */
  const lineSyncRef = useRef<ChartSyncState | null>(null);
  const [readout, setReadout] = useState<Readout | null>(null);

  useEffect(() => {
    decimalsRef.current = { price: priceDecimals, qty: qtyDecimals };
  }, [priceDecimals, qtyDecimals]);

  // Create the chart once. Declared before the data effect so the series exist when it runs.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const chart = createChart(container, {
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight),
      layout: {
        background: { type: ColorType.Solid, color: CHART_THEME.background },
        textColor: CHART_THEME.text,
        fontFamily: CHART_THEME.fontFamily,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: CHART_THEME.grid },
        horzLines: { color: CHART_THEME.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: CHART_THEME.crosshair,
          style: LineStyle.Dashed,
          labelBackgroundColor: CHART_THEME.label,
        },
        horzLine: {
          color: CHART_THEME.crosshair,
          style: LineStyle.Dashed,
          labelBackgroundColor: CHART_THEME.label,
        },
      },
      rightPriceScale: { borderColor: CHART_THEME.grid },
      // Series times stay UTC seconds; only the labels use the viewer's local zone (design D7).
      localization: {
        timeFormatter: (time: Time) =>
          typeof time === "number" ? formatChartTime(time) : TIME_PLACEHOLDER,
      },
      timeScale: {
        borderColor: CHART_THEME.grid,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time, tickType: TickMarkType) =>
          typeof time === "number" ? tickMarkLabel(time, tickType) : null,
      },
      // Wheel zooms and drag pans (Req 29.1, 29.2). Wheel scrolling is off so the wheel has one
      // meaning; touch and drag keep the library defaults.
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
        axisDoubleClickReset: true,
      },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: CHART_THEME.up,
      downColor: CHART_THEME.down,
      wickUpColor: CHART_THEME.up,
      wickDownColor: CHART_THEME.down,
      borderVisible: false,
      priceFormat: priceFormatFor(decimalsRef.current.price),
    });
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.08, bottom: 0.25 } });

    // Volume on its own overlay price scale (id ""), in the bottom fifth of the pane.
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    const onCrosshairMove = (param: MouseEventParams<Time>) => {
      const point = param.point;
      if (point === undefined || typeof param.time !== "number") {
        setReadout(null);
        return;
      }
      const { price: priceDigits, qty: qtyDigits } = decimalsRef.current;
      const cursorPrice = candles.coordinateToPrice(point.y);
      const ohlc = readOhlc(param.seriesData.get(candles));
      const volumeValue = readValue(param.seriesData.get(volume));
      setReadout({
        time: formatChartTime(param.time),
        price: cursorPrice === null ? "—" : formatDisplayNumber(cursorPrice, priceDigits),
        ohlc:
          ohlc === null
            ? null
            : {
                open: formatDisplayNumber(ohlc.open, priceDigits),
                high: formatDisplayNumber(ohlc.high, priceDigits),
                low: formatDisplayNumber(ohlc.low, priceDigits),
                close: formatDisplayNumber(ohlc.close, priceDigits),
              },
        volume: volumeValue === null ? null : formatDisplayNumber(volumeValue, qtyDigits),
      });
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      chart.resize(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
    });
    observer.observe(container);

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;
    appliedRef.current = null;
    viewKeyRef.current = null;
    needsFitRef.current = true;
    linesRef.current = {};
    lineSyncRef.current = null;

    return () => {
      observer.disconnect();
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      appliedRef.current = null;
      linesRef.current = {};
      lineSyncRef.current = null;
    };
  }, []);

  // Price format follows the instrument's decimals once `hello` arrives.
  useEffect(() => {
    candleRef.current?.applyOptions({ priceFormat: priceFormatFor(priceDecimals) });
  }, [priceDecimals]);

  // Feed bars to the chart: replace everything, or update the last bar for a live tick.
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleRef.current;
    const volumeSeries = volumeRef.current;
    if (chart === null || candleSeries === null || volumeSeries === null) return;

    const viewKey = `${symbol}|${timeframe}`;
    if (viewKeyRef.current !== viewKey) {
      viewKeyRef.current = viewKey;
      needsFitRef.current = true;
    }

    const input = {
      key: `${viewKey}|${priceDecimals}|${qtyDecimals}`,
      snapshot: snapshotCount,
      rewrite: rewriteCount,
      bars,
    };
    const prev = appliedRef.current;
    const plan = planChartSync(prev, input);

    if (plan.kind === "update") {
      // Only the bars at or after the previous newest bar; ascending order is guaranteed.
      for (const point of barsToCandles(plan.bars, priceDecimals)) candleSeries.update(point);
      for (const point of barsToVolume(plan.bars, qtyDecimals)) volumeSeries.update(point);
    } else {
      // Every snapshot (also a fresh one on the same key) repositions the view (Req 2.8).
      if (shouldReposition(prev, input)) needsFitRef.current = true;
      const candles = barsToCandles(bars, priceDecimals);
      candleSeries.setData(candles);
      volumeSeries.setData(barsToVolume(bars, qtyDecimals));
      if (needsFitRef.current && candles.length > 0) {
        const range = initialVisibleRange(candles.length);
        if (range === null) chart.timeScale().fitContent();
        else chart.timeScale().setVisibleLogicalRange(range);
        needsFitRef.current = false;
      }
    }
    appliedRef.current = chartSyncState(input);
  }, [bars, snapshotCount, rewriteCount, symbol, timeframe, priceDecimals, qtyDecimals]);

  // Indicator lines (Req 26.1-26.4): a toggled-off line has no series (removed, so no stale data
  // and no empty sub-pane); a toggled-on line gets a series and is fed like the candles.
  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    const lines = linesRef.current;
    const input = {
      key: `${symbol}|${timeframe}|${priceDecimals}`,
      snapshot: snapshotCount,
      rewrite: rewriteCount,
      bars,
    };
    const plan = planChartSync(lineSyncRef.current, input);
    // Points without a stored candle time would add time-axis slots, so they are dropped.
    const setTimes = new Set<number>(bars.map((b) => b.t));
    const updateTimes =
      plan.kind === "update" ? new Set<number>(plan.bars.map((b) => b.t)) : setTimes;
    const updatePoints =
      plan.kind === "update"
        ? indicatorPoints.filter((p) => updateTimes.has(p.t))
        : indicatorPoints;

    for (const line of ALL_LINES) {
      const enabled = toggles[toggleOfLine(line)];
      let series = lines[line];
      if (!enabled) {
        if (series !== undefined) {
          chart.removeSeries(series);
          delete lines[line];
        }
        continue;
      }
      let created = false;
      if (series === undefined) {
        created = true;
        const pane = paneOfLine(line);
        series = chart.addSeries(LineSeries, lineOptions(line, priceDecimals), pane);
        if (line === "rsi") {
          for (const level of RSI_GUIDES) {
            series.createPriceLine({
              price: level,
              color: CHART_THEME.grid,
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: false,
              title: "",
            });
          }
        }
        if (line === "atr") {
          series.priceScale().applyOptions({ visible: true, borderColor: CHART_THEME.grid });
        }
        if (pane === 1) series.getPane().setStretchFactor(SUB_PANE_STRETCH);
        lines[line] = series;
      }

      if (plan.kind === "update" && !created) {
        for (const point of indicatorLineUpdates(updatePoints, line, priceDecimals, updateTimes)) {
          series.update(point);
        }
      } else {
        // A full replace also follows a change of price decimals (part of the sync key).
        series.applyOptions({ priceFormat: lineOptions(line, priceDecimals).priceFormat });
        series.setData(indicatorLineData(indicatorPoints, line, priceDecimals, setTimes));
      }
    }
    lineSyncRef.current = chartSyncState(input);
  }, [indicatorPoints, bars, toggles, snapshotCount, rewriteCount, symbol, timeframe, priceDecimals]);

  // Keyboard: timeframe digits always (outside text inputs); zoom and pan while the chart is
  // hovered or focused.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { hover, focus } = activeRef.current;
      const context = hover || focus ? "chart" : "global";
      // Req 26.3: E, W, O, R, T toggle indicators from anywhere outside text inputs.
      const toggle = indicatorToggleForKey(event, context);
      if (toggle !== null) {
        event.preventDefault();
        if (!event.repeat) toggleIndicator(toggle);
        return;
      }
      const action = chartActionForKey(event, context);
      if (action === null) return;
      if (action.kind === "timeframe") {
        event.preventDefault();
        selectTimeframe(action.timeframe);
        return;
      }
      const chart = chartRef.current;
      if (chart === null) return;
      event.preventDefault();
      const scale = chart.timeScale();
      const range = scale.getVisibleLogicalRange();
      if (range === null) return;
      switch (action.kind) {
        case "zoom_in":
          scale.setVisibleLogicalRange(zoomRange(range, ZOOM_IN_FACTOR));
          break;
        case "zoom_out":
          scale.setVisibleLogicalRange(zoomRange(range, ZOOM_OUT_FACTOR));
          break;
        case "pan_back":
          scale.setVisibleLogicalRange(panRange(range, -PAN_FRACTION));
          break;
        case "pan_forward":
          scale.setVisibleLogicalRange(panRange(range, PAN_FRACTION));
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [selectTimeframe, toggleIndicator]);

  const legend = legendEntries(indicatorPoints, toggles, priceDecimals);

  return (
    <div
      role="group"
      aria-label={`${symbol} chart`}
      tabIndex={0}
      className="flex h-full min-h-0 flex-col outline-none focus-visible:outline-1 focus-visible:outline-amber"
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
      <div role="group" aria-label="Timeframe" className="mb-1 flex items-center gap-1 text-xs">
        {timeframeLabels.map((tf, index) => (
          <button
            key={tf}
            type="button"
            aria-pressed={tf === timeframe}
            title={`Timeframe ${tf} (key ${index + 1})`}
            onClick={() => {
              selectTimeframe(tf);
            }}
            className={`border px-2 py-0.5 ${
              tf === timeframe
                ? "border-amber text-amber"
                : "border-crt-line text-phosphor-dim hover:text-phosphor"
            }`}
          >
            {tf}
          </button>
        ))}
        <span className="ml-auto text-phosphor-dim">{symbol}</span>
      </div>
      <div className="mb-1 flex flex-wrap items-center gap-1 text-xs">
        <div role="group" aria-label="Indicators" className="flex items-center gap-1">
          {INDICATOR_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={toggles[name]}
              title={`${INDICATOR_LABELS[name]} on/off (key ${INDICATOR_HOTKEYS[name]})`}
              onClick={() => {
                toggleIndicator(name);
              }}
              className={`border px-2 py-0.5 ${
                toggles[name]
                  ? "border-amber text-amber"
                  : "border-crt-line text-phosphor-dim hover:text-phosphor"
              }`}
            >
              {INDICATOR_LABELS[name]}
            </button>
          ))}
        </div>
        {legend.length > 0 && (
          <div aria-label="Indicator values" className="ml-2 flex flex-wrap gap-x-2">
            {legend.map((entry) => (
              <span key={entry.line} style={{ color: entry.color }}>
                {entry.label} {entry.text}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {readout !== null && (
          <div className="pointer-events-none absolute left-2 top-1 z-10 text-xs text-phosphor">
            <span>{readout.time}</span> <span className="text-amber">@ {readout.price}</span>
            {readout.ohlc !== null && (
              <span className="text-phosphor-dim">
                {" "}
                O {readout.ohlc.open} H {readout.ohlc.high} L {readout.ohlc.low} C {readout.ohlc.close}
              </span>
            )}
            {readout.volume !== null && <span className="text-phosphor-dim"> V {readout.volume}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
