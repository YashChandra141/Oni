// Decimal formatting for Price, Qty, and Money values (tech.md: they arrive as decimal strings
// of integer counts; convert with BigInt, never Number or parseFloat).

const INTEGER = /^-?\d+$/;

/**
 * Formats an integer count of 10^-decimals units as a fixed-point decimal string, e.g.
 * `formatUnits("6400012", 2)` → `"64000.12"`. Returns null when `raw` is not a decimal integer
 * string or `decimals` is not an integer from 0 to 18.
 */
export function formatUnits(raw: string, decimals: number): string | null {
  if (!INTEGER.test(raw)) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  const value = BigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = (abs / scale).toString();
  const sign = negative ? "-" : "";
  if (decimals === 0) return `${sign}${whole}`;
  const frac = (abs % scale).toString().padStart(decimals, "0");
  return `${sign}${whole}.${frac}`;
}

/**
 * Formats a delay in ms as seconds with at most one decimal, rounded up so a pending retry never
 * shows as "0s": `250` → `"0.3s"`, `500` → `"0.5s"`, `10000` → `"10s"`. Negative or non-finite
 * input counts as 0.
 */
export function formatDelaySeconds(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const tenths = Math.ceil(safe / 100);
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  return frac === 0 ? `${whole}s` : `${whole}.${frac}s`;
}

/** Formats a Price (Ticks) with the instrument's price decimals, or `"—"` when unknown. */
export function formatPrice(raw: string | undefined, priceDecimals: number | undefined): string {
  if (raw === undefined || priceDecimals === undefined) return "—";
  return formatUnits(raw, priceDecimals) ?? "—";
}

/** Formats a Qty (Lots) with the instrument's qty decimals, or `"—"` when unknown. */
export function formatQty(raw: string | undefined, qtyDecimals: number | undefined): string {
  if (raw === undefined || qtyDecimals === undefined) return "—";
  return formatUnits(raw, qtyDecimals) ?? "—";
}
