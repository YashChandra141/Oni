// Decimal strings are converted with BigInt, never Number (tech.md).
import { describe, expect, test } from "bun:test";
import { formatDelaySeconds, formatPrice, formatQty, formatUnits } from "./format";

describe("formatUnits", () => {
  test.each([
    ["6400012", 2, "64000.12"],
    ["5", 2, "0.05"],
    ["0", 2, "0.00"],
    ["100", 0, "100"],
    ["007", 2, "0.07"],
    ["-5", 2, "-0.05"],
    ["-6400012", 2, "-64000.12"],
    ["-0", 2, "0.00"],
    ["12345678", 8, "0.12345678"],
    ["150000000", 8, "1.50000000"],
  ] as const)("formatUnits(%p, %p) = %p", (raw, decimals, expected) => {
    expect(formatUnits(raw, decimals)).toBe(expected);
  });

  test("keeps precision above 2^53", () => {
    expect(formatUnits("9007199254740993", 2)).toBe("90071992547409.93");
    expect(formatUnits("123456789012345678901234567890", 8)).toBe("1234567890123456789012.34567890");
  });

  test.each(["", "abc", "1.5", "+5", " 5", "5 ", "1e3", "--5"])("rejects the raw value %p", (raw) => {
    expect(formatUnits(raw, 2)).toBeNull();
  });

  test.each([-1, 19, 1.5, Number.NaN])("rejects the decimals value %p", (decimals) => {
    expect(formatUnits("100", decimals)).toBeNull();
  });
});

describe("formatPrice and formatQty", () => {
  test("format with the instrument decimals", () => {
    expect(formatPrice("6400012", 2)).toBe("64000.12");
    expect(formatQty("150000000", 8)).toBe("1.50000000");
  });

  test("show a dash when the value or the decimals are unknown or invalid", () => {
    expect(formatPrice(undefined, 2)).toBe("—");
    expect(formatPrice("6400012", undefined)).toBe("—");
    expect(formatPrice("not a number", 2)).toBe("—");
    expect(formatQty(undefined, 8)).toBe("—");
    expect(formatQty("1", undefined)).toBe("—");
  });
});

describe("formatDelaySeconds", () => {
  test.each([
    [0, "0s"],
    [1, "0.1s"],
    [100, "0.1s"],
    [250, "0.3s"],
    [500, "0.5s"],
    [1000, "1s"],
    [1500, "1.5s"],
    [8000, "8s"],
    [10_000, "10s"],
  ] as const)("%p ms -> %p", (ms, expected) => {
    expect(formatDelaySeconds(ms)).toBe(expected);
  });

  test("treats negative and non-finite input as 0", () => {
    expect(formatDelaySeconds(-5)).toBe("0s");
    expect(formatDelaySeconds(Number.NaN)).toBe("0s");
    expect(formatDelaySeconds(Number.POSITIVE_INFINITY)).toBe("0s");
  });
});
