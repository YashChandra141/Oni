// Pure zoom and pan math on the chart's visible logical range (Req 29.1, 29.2). A logical range
// counts bars: bar `i` of the series is at logical index `i`. Wheel zoom and drag pan come from
// the chart library itself; these functions serve the `+`, `-`, left, and right keys.

export interface LogicalRangeLike {
  readonly from: number;
  readonly to: number;
}

/** Fewest bars the keyboard can zoom in to. */
export const MIN_VISIBLE_BARS = 5;
/** Most bars the keyboard can zoom out to. */
export const MAX_VISIBLE_BARS = 2000;
/** One `+` press shows 1/1.25 of the current width. */
export const ZOOM_IN_FACTOR = 1.25;
/** One `-` press shows 1.25 times the current width. */
export const ZOOM_OUT_FACTOR = 1 / ZOOM_IN_FACTOR;
/** One arrow press moves the view by this fraction of its width. */
export const PAN_FRACTION = 0.2;
/** Bars shown after a symbol or timeframe switch, when there are more bars than this. */
export const INITIAL_VISIBLE_BARS = 120;
/** Empty bars kept to the right of the last bar after the initial view is set. */
export const RIGHT_PADDING_BARS = 3;

function isUsable(range: LogicalRangeLike): boolean {
  return Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from;
}

/**
 * Zooms around the centre of `range`. The new width is `width / factor`, so a factor above 1
 * zooms in and a factor below 1 zooms out. Zooming in never goes below `MIN_VISIBLE_BARS` and
 * zooming out never goes above `MAX_VISIBLE_BARS`; a range already beyond a limit does not move
 * further toward it. An unusable range or a non-positive factor returns `range` unchanged.
 */
export function zoomRange(range: LogicalRangeLike, factor: number): LogicalRangeLike {
  if (!isUsable(range) || !Number.isFinite(factor) || factor <= 0) return range;
  const width = range.to - range.from;
  let next = width / factor;
  if (factor > 1) next = Math.max(next, Math.min(width, MIN_VISIBLE_BARS));
  else if (factor < 1) next = Math.min(next, Math.max(width, MAX_VISIBLE_BARS));
  const center = range.from + width / 2;
  return { from: center - next / 2, to: center + next / 2 };
}

/**
 * Shifts `range` by `fraction` of its width: negative moves back in time (left), positive
 * moves forward (right). The width stays the same. An unusable range or a non-finite fraction
 * returns `range` unchanged.
 */
export function panRange(range: LogicalRangeLike, fraction: number): LogicalRangeLike {
  if (!isUsable(range) || !Number.isFinite(fraction)) return range;
  const delta = (range.to - range.from) * fraction;
  return { from: range.from + delta, to: range.to + delta };
}

/**
 * The view to show after new data replaces the chart's data: the last `visible` bars plus a
 * little empty space on the right. Returns null when all bars fit (use `fitContent`).
 */
export function initialVisibleRange(
  count: number,
  visible: number = INITIAL_VISIBLE_BARS,
): LogicalRangeLike | null {
  if (!Number.isInteger(count) || count <= visible) return null;
  return { from: count - visible, to: count - 1 + RIGHT_PADDING_BARS };
}
