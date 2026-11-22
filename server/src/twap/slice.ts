// TWAP slicing (Req 17.11, 17.13). Pure, BigInt only.

export const TWAP_MIN_SLICES = 2;
export const TWAP_MAX_SLICES = 20;

/**
 * Splits `totalQtyLots` into `slices` whole-lot quantities. Every slice is
 * floor(total / slices); the remainder goes into the last slice. The sum
 * equals the total and each slice is at least one lot.
 */
export function sliceQty(totalQtyLots: bigint, slices: number): bigint[] {
  if (!Number.isInteger(slices) || slices < 1) {
    throw new RangeError("slices must be a positive integer");
  }
  const n = BigInt(slices);
  if (totalQtyLots < n) {
    throw new RangeError("total quantity must be at least one lot per slice");
  }
  const base = totalQtyLots / n;
  const rem = totalQtyLots % n;
  const out: bigint[] = new Array<bigint>(slices).fill(base);
  out[slices - 1] = base + rem;
  return out;
}

/** Schedule times in ms: slice i at t0 + i * intervalS * 1000 (first at t0). */
export function sliceSchedule(t0Ms: number, slices: number, intervalS: number): number[] {
  if (!Number.isInteger(slices) || slices < 1) {
    throw new RangeError("slices must be a positive integer");
  }
  const out: number[] = [];
  for (let i = 0; i < slices; i++) out.push(t0Ms + i * intervalS * 1000);
  return out;
}
