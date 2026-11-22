// Pure helpers for the resizable Split component. Sizes are percentages that sum to 100.

const TOTAL = 100;

/** Clamp each size to its minimum, then rescale the others so the sizes sum to 100. */
export function clampSizes(sizes: readonly number[], min: readonly number[]): number[] {
  const out = sizes.map((s, i) => Math.max(Number.isFinite(s) ? s : 0, min[i] ?? 0));
  for (let pass = 0; pass < 8; pass++) {
    const diff = TOTAL - out.reduce((a, b) => a + b, 0);
    if (Math.abs(diff) < 1e-9) break;
    if (diff < 0) {
      const slack = out.map((s, i) => Math.max(0, s - (min[i] ?? 0)));
      const room = slack.reduce((a, b) => a + b, 0);
      if (room <= 0) break;
      out.forEach((s, i) => {
        out[i] = s + (diff * (slack[i] ?? 0)) / room;
      });
    } else {
      const sum = out.reduce((a, b) => a + b, 0);
      out.forEach((s, i) => {
        out[i] = s + (diff * s) / sum;
      });
    }
  }
  return out;
}

/**
 * Move the gutter between pane `index` and `index + 1` by `deltaPct`. Only those two panes change,
 * and neither goes below its minimum. Returns the input unchanged when the move is impossible.
 */
export function applyDrag(
  sizes: readonly number[],
  index: number,
  deltaPct: number,
  min: readonly number[],
): number[] {
  const a = sizes[index];
  const b = sizes[index + 1];
  if (a === undefined || b === undefined || !Number.isFinite(deltaPct)) return [...sizes];
  const minA = min[index] ?? 0;
  const minB = min[index + 1] ?? 0;
  const total = a + b;
  if (minA + minB > total) return [...sizes];
  const nextA = Math.min(Math.max(a + deltaPct, minA), total - minB);
  const out = [...sizes];
  out[index] = nextA;
  out[index + 1] = total - nextA;
  return out;
}

/** Parse a stored value: an array of `length` finite positive numbers summing to about 100, else null. */
export function parseStored(raw: string | null, length: number): number[] | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== length) return null;
  if (!value.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)) return null;
  const nums = value as number[];
  const sum = nums.reduce((a, b) => a + b, 0);
  return Math.abs(sum - TOTAL) <= 1 ? nums : null;
}
