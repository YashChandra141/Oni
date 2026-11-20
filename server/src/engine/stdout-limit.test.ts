// Engine stdout line limit (chart-and-tape-fix Task 5.1, Req 2.6). Uses the same splitter
// factory as supervisor.ts's stdout reader.
import { describe, expect, test } from "bun:test";
import { createEngineStdoutSplitter, MAX_EVENT_LINE_BYTES, MAX_LINE_BYTES } from "./lines.ts";

const enc = new TextEncoder();

describe("engine stdout splitter limit", () => {
  test("MAX_EVENT_LINE_BYTES is 512 KiB and the default stays 64 KiB", () => {
    expect(MAX_EVENT_LINE_BYTES).toBe(512 * 1024);
    expect(MAX_LINE_BYTES).toBe(64 * 1024);
  });

  test("accepts a 300 KB line", () => {
    const oversized: number[] = [];
    const splitter = createEngineStdoutSplitter((n) => oversized.push(n));
    const line = "x".repeat(300_000);
    expect(splitter.push(enc.encode(`${line}\nnext\n`))).toEqual([line, "next"]);
    expect(oversized).toEqual([]);
  });

  test("drops a line over 512 KiB and recovers on the next line", () => {
    const oversized: number[] = [];
    const splitter = createEngineStdoutSplitter((n) => oversized.push(n));
    const exact = "y".repeat(MAX_EVENT_LINE_BYTES);
    const over = "z".repeat(MAX_EVENT_LINE_BYTES + 1);
    expect(splitter.push(enc.encode(`${exact}\n${over}\nok\n`))).toEqual([exact, "ok"]);
    expect(oversized).toEqual([MAX_EVENT_LINE_BYTES + 1]);
  });
});
