// Tests for the engine stdout line splitter (design §3 Engine_Supervisor).
import { describe, expect, test } from "bun:test";
import { LineSplitter, MAX_LINE_BYTES } from "./lines.ts";

const enc = new TextEncoder();

/** Feeds `input` to a splitter `size` bytes at a time, then flushes. */
function splitAll(input: Uint8Array, size: number, maxBytes?: number): { lines: string[]; oversized: number[] } {
  const oversized: number[] = [];
  const splitter = new LineSplitter({ maxBytes, onOversized: (n) => oversized.push(n) });
  const lines: string[] = [];
  for (let i = 0; i < input.length; i += size) lines.push(...splitter.push(input.subarray(i, i + size)));
  lines.push(...splitter.flush());
  return { lines, oversized };
}

const CHUNK_SIZES = [1, 2, 3, 5, 7, 64, 1 << 20];

describe("LineSplitter", () => {
  test("uses the Rust MAX_LINE_BYTES of 64 KiB", () => {
    expect(MAX_LINE_BYTES).toBe(65_536);
  });

  test("splits LF and CRLF lines at every chunk boundary", () => {
    const input = enc.encode('{"a":1}\r\n{"b":2}\n{"c":3}\r\n');
    for (const size of CHUNK_SIZES) {
      expect(splitAll(input, size).lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    }
  });

  test("rejoins multi-byte UTF-8 characters split across chunks", () => {
    // 2-, 3-, and 4-byte sequences: é, €, 👻.
    const text = '{"m":"é€👻"}\n{"m":"👻👻"}\r\n';
    const input = enc.encode(text);
    for (const size of CHUNK_SIZES) {
      expect(splitAll(input, size).lines).toEqual(['{"m":"é€👻"}', '{"m":"👻👻"}']);
    }
  });

  test("skips empty lines, including a bare CRLF", () => {
    const input = enc.encode("\n\r\na\n\n\r\nb\n");
    for (const size of CHUNK_SIZES) expect(splitAll(input, size).lines).toEqual(["a", "b"]);
  });

  test("strips only one CR before LF", () => {
    expect(splitAll(enc.encode("a\r\r\n"), 1).lines).toEqual(["a\r"]);
  });

  test("returns lines as soon as their LF arrives", () => {
    const splitter = new LineSplitter();
    expect(splitter.push(enc.encode("ab"))).toEqual([]);
    expect(splitter.push(enc.encode("c\nde"))).toEqual(["abc"]);
    expect(splitter.push(enc.encode("\r"))).toEqual([]);
    expect(splitter.push(enc.encode("\n"))).toEqual(["de"]);
    expect(splitter.flush()).toEqual([]);
  });

  test("flush returns a final line without a terminator, then resets", () => {
    const splitter = new LineSplitter();
    expect(splitter.push(enc.encode("x\nlast"))).toEqual(["x"]);
    expect(splitter.flush()).toEqual(["last"]);
    expect(splitter.flush()).toEqual([]);
    expect(splitter.push(enc.encode("again\n"))).toEqual(["again"]);
  });

  test("flush strips a trailing CR, as the Rust reader does at EOF", () => {
    const splitter = new LineSplitter();
    splitter.push(enc.encode("tail\r"));
    expect(splitter.flush()).toEqual(["tail"]);
  });

  test("drops an oversized line, reports its byte length, and recovers", () => {
    // Same cases as rust/crates/engine/src/lines.rs with a limit of 8.
    const input = enc.encode("12345678\n123456789\r\n0123456789abcdef\nok\r\n12345678\r\n");
    for (const size of CHUNK_SIZES) {
      const { lines, oversized } = splitAll(input, size, 8);
      expect(lines).toEqual(["12345678", "ok", "12345678"]);
      expect(oversized).toEqual([9, 16]);
    }
  });

  test("the limit counts bytes, not characters", () => {
    // "€€€" is 3 characters but 9 bytes.
    const { lines, oversized } = splitAll(enc.encode("€€€\n€€\n"), 2, 8);
    expect(lines).toEqual(["€€"]);
    expect(oversized).toEqual([9]);
  });

  test("an oversized final line without a terminator is reported by flush", () => {
    const { lines, oversized } = splitAll(enc.encode("ok\n0123456789"), 4, 8);
    expect(lines).toEqual(["ok"]);
    expect(oversized).toEqual([10]);
  });

  test("a full 64 KiB line passes and one byte more is dropped", () => {
    const max = "x".repeat(MAX_LINE_BYTES);
    const input = enc.encode(`${max}\r\n${max}y\nnext\n`);
    const { lines, oversized } = splitAll(input, 4096);
    expect(lines.map((l) => l.length)).toEqual([MAX_LINE_BYTES, 4]);
    expect(lines[1]).toBe("next");
    expect(oversized).toEqual([MAX_LINE_BYTES + 1]);
  });

  test("does not buffer a line once it passes the limit", () => {
    const splitter = new LineSplitter({ maxBytes: 8 });
    for (let i = 0; i < 100; i++) {
      splitter.push(enc.encode("x".repeat(1000)));
      expect(splitter.bufferedBytes).toBeLessThanOrEqual(9);
    }
  });

  test("copies retained bytes, so the caller may reuse its chunk buffer", () => {
    const splitter = new LineSplitter();
    const buf = enc.encode("abc");
    splitter.push(buf);
    buf.set(enc.encode("zzz"));
    expect(splitter.push(enc.encode("\n"))).toEqual(["abc"]);
  });

  test("rejects a non-positive maxBytes", () => {
    expect(() => new LineSplitter({ maxBytes: 0 })).toThrow(RangeError);
  });
});

// Bug condition exploration, chart-and-tape-fix Task 1.9 (Property 4, cause 8).
// Reqs 1.5, 2.6: the worst-case snapshot line (500 bars + 500 indicator points) must reach the
// server intact. The limit is whatever the engine-stdout reader in supervisor.ts uses: today the
// splitter default (MAX_LINE_BYTES), after fix task 5.1 `MAX_EVENT_LINE_BYTES`.
import * as linesModule from "./lines.ts";

describe("engine stdout worst-case Candle snapshot line (Property 4)", () => {
  test("a 500-bar snapshot with 500 indicator points is delivered intact", () => {
    const I64_MAX = "9223372036854775807";
    const I64_MIN = "-9223372036854775808";
    const F = -1.7976931348623157e308;
    const bars = Array.from({ length: 500 }, (_, i) => ({
      t: 9007199254740000 + i,
      open: I64_MIN,
      high: I64_MAX,
      low: I64_MIN,
      close: I64_MAX,
      volume: I64_MAX,
    }));
    const indicators = bars.map((b) => ({
      t: b.t,
      values: { ema: F, sma: F, vwap: F, bb_upper: F, bb_mid: F, bb_lower: F, rsi: F, atr: F },
    }));
    const line = JSON.stringify({
      type: "candle",
      symbol: "BTC-USD",
      timeframe: "1m",
      snapshot: true,
      bars,
      indicators,
    });
    const bytes = enc.encode(`${line}\n`);
    const lineBytes = bytes.length - 1;

    // Same limit as supervisor.ts's engine-stdout splitter.
    const exported = linesModule as Record<string, unknown>;
    const limit =
      typeof exported.MAX_EVENT_LINE_BYTES === "number" ? exported.MAX_EVENT_LINE_BYTES : MAX_LINE_BYTES;
    const oversized: number[] = [];
    const splitter = new LineSplitter({ maxBytes: limit, onOversized: (n) => oversized.push(n) });
    const out = splitter.push(bytes);

    console.log(`worst-case snapshot line: ${lineBytes} bytes, limit in force: ${limit} bytes`);
    expect({ oversized, delivered: out.length }).toEqual({ oversized: [], delivered: 1 });
    expect(out[0]).toBe(line);
  });
});
