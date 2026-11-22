// Heikin-Ashi bars (Task 14.4, Req 23). Computed in BigInt ticks from the stored bars, so the
// result is exact integer math (division truncates toward zero); the caller converts to display
// numbers afterwards. Malformed bars (non-integer fields) are skipped.

import type { Bar } from "../../shared/protocol/index";

const INTEGER = /^-?\d+$/;

function max(...values: bigint[]): bigint {
  return values.reduce((a, b) => (b > a ? b : a));
}

function min(...values: bigint[]): bigint {
  return values.reduce((a, b) => (b < a ? b : a));
}

/** Heikin-Ashi bars for `bars` (ascending by `t`). Volume and time are carried over unchanged. */
export function toHeikinAshi(bars: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  let prevOpen: bigint | null = null;
  let prevClose: bigint | null = null;
  for (const bar of bars) {
    if (
      !INTEGER.test(bar.open) ||
      !INTEGER.test(bar.high) ||
      !INTEGER.test(bar.low) ||
      !INTEGER.test(bar.close)
    ) {
      continue;
    }
    const o = BigInt(bar.open);
    const h = BigInt(bar.high);
    const l = BigInt(bar.low);
    const c = BigInt(bar.close);
    const haClose = (o + h + l + c) / 4n;
    const haOpen: bigint = prevOpen === null || prevClose === null ? (o + c) / 2n : (prevOpen + prevClose) / 2n;
    out.push({
      ...bar,
      open: haOpen.toString(),
      high: max(h, haOpen, haClose).toString(),
      low: min(l, haOpen, haClose).toString(),
      close: haClose.toString(),
    });
    prevOpen = haOpen;
    prevClose = haClose;
  }
  return out;
}
