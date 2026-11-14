// Property tests for the engine stdout line splitter (design §3 Engine_Supervisor). They
// strengthen the fixed-input cases in lines.test.ts with arbitrary text, terminators, and
// chunk boundaries.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { LineSplitter, MAX_LINE_BYTES } from "./lines.ts";

const NUM_RUNS = 200;
const enc = new TextEncoder();

/**
 * Unicode text without line terminators. `binary` produces any code point except lone
 * surrogates, so each string encodes to UTF-8 and decodes back unchanged. `\n` and `\r` are
 * replaced, not filtered, so no generated value is thrown away.
 */
const textArb = (minLength: number, maxLength: number) =>
  fc.string({ unit: "binary", minLength, maxLength }).map((s) => s.replace(/[\r\n]/g, "x"));

const terminatorArb = fc.constantFrom("\n", "\r\n");

/** Lines, each with its own terminator, and whether the last line is left unterminated. */
const streamArb = <T extends string>(lineArb: fc.Arbitrary<T>, maxLines: number) =>
  fc.record({
    lines: fc.array(fc.tuple(lineArb, terminatorArb), { maxLength: maxLines }),
    unterminatedLast: fc.boolean(),
    cuts: fc.array(fc.nat(), { maxLength: 40 }),
  });

type Stream = { lines: [string, string][]; unterminatedLast: boolean; cuts: number[] };

function encodeStream({ lines, unterminatedLast }: Stream): Uint8Array {
  const text = lines
    .map(([line, term], i) => (unterminatedLast && i === lines.length - 1 ? line : line + term))
    .join("");
  return enc.encode(text);
}

/** Splits `bytes` at the cut positions (taken modulo the length + 1) into chunks. */
function chunk(bytes: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
  const chunks: Uint8Array[] = [];
  let prev = 0;
  for (const p of [...points, bytes.length]) {
    chunks.push(bytes.subarray(prev, p)); // empty chunks are allowed and must be harmless
    prev = p;
  }
  return chunks;
}

interface SplitResult {
  lines: string[];
  oversized: number[];
  maxBuffered: number;
}

function run(stream: Stream, maxBytes?: number): SplitResult {
  const oversized: number[] = [];
  const splitter = new LineSplitter({ maxBytes, onOversized: (n) => oversized.push(n) });
  const lines: string[] = [];
  let maxBuffered = 0;
  for (const c of chunk(encodeStream(stream), stream.cuts)) {
    lines.push(...splitter.push(c));
    maxBuffered = Math.max(maxBuffered, splitter.bufferedBytes);
  }
  lines.push(...splitter.flush());
  return { lines, oversized, maxBuffered };
}

/** Reference model: what the splitter must return for `stream` with limit `max`. */
function expected(stream: Stream, max: number): { lines: string[]; oversized: number[] } {
  const lines: string[] = [];
  const oversized: number[] = [];
  for (const [line] of stream.lines) {
    const bytes = enc.encode(line).length;
    if (bytes > max) oversized.push(bytes);
    else if (bytes > 0) lines.push(line);
  }
  return { lines, oversized };
}

describe("LineSplitter properties", () => {
  test("non-empty unicode lines with LF or CRLF come back unchanged at any chunk boundaries", () => {
    fc.assert(
      fc.property(streamArb(textArb(1, 40), 20), (stream) => {
        const { lines, oversized } = run(stream);
        expect(lines).toEqual(stream.lines.map(([line]) => line));
        expect(oversized).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("with a small limit, lines over it are dropped and reported by byte length, and the rest pass", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 32 }), streamArb(textArb(0, 24), 20), (max, stream) => {
        const { lines, oversized, maxBuffered } = run(stream, max);
        expect({ lines, oversized }).toEqual(expected(stream, max));
        expect(maxBuffered).toBeLessThanOrEqual(max + 1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("at the real 64 KiB limit, lines over MAX_LINE_BYTES are dropped and reported", () => {
    // Lines just under, at, and over the limit, with a unicode tail so multi-byte characters
    // straddle the boundary, mixed with short lines.
    const nearLimit = fc
      .tuple(fc.integer({ min: MAX_LINE_BYTES - 12, max: MAX_LINE_BYTES + 4 }), textArb(0, 3))
      .map(([n, tail]) => "x".repeat(n) + tail);
    const lineArb = fc.oneof(nearLimit, textArb(0, 8));
    fc.assert(
      fc.property(streamArb(lineArb, 5), (stream) => {
        const { lines, oversized, maxBuffered } = run(stream);
        expect({ lines, oversized }).toEqual(expected(stream, MAX_LINE_BYTES));
        expect(maxBuffered).toBeLessThanOrEqual(MAX_LINE_BYTES + 1);
      }),
      { numRuns: 100 },
    );
  });
});
