// Incremental JSON-lines splitter for engine stdout (design §3 Engine_Supervisor).
//
// Pure and synchronous: feed it stdout chunks with `push`, get back complete lines, and call
// `flush` at end of stream. It mirrors the engine's own stdin reader
// (rust/crates/engine/src/lines.rs):
//
// - Lines end at `\n`. One `\r` before the `\n` is stripped, so `\r\n` works too.
// - The limit is in bytes, not counting the terminator: `MAX_LINE_BYTES` (64 KiB), the same
//   value as the Rust `protocol::MAX_LINE_BYTES`. A longer line is dropped, reported through
//   `onOversized` with its length in bytes, and splitting continues with the next line. Once a
//   line passes the limit, its bytes are counted but no longer buffered.
// - Empty lines (including a bare `\r\n`) are skipped. The engine never writes them, and an
//   empty line carries no Event, so passing it on would only produce a parse-error log line.
//
// UTF-8: the splitter works on bytes and decodes each complete line on its own. 0x0A never
// occurs inside a multi-byte UTF-8 sequence, so a character split across chunks is rejoined
// before decoding. This gives the same text as a streaming TextDecoder while keeping the limit
// in bytes, as Rust counts it. Invalid UTF-8 decodes to U+FFFD; the JSON/Zod step then rejects
// or carries it like any other text.

/** Longest accepted line in bytes, without its terminator. Matches Rust `MAX_LINE_BYTES`. */
export const MAX_LINE_BYTES = 64 * 1024;

/**
 * Longest accepted engine stdout (Event) line in bytes, without its terminator. Matches the
 * Rust `protocol::MAX_EVENT_LINE_BYTES`. Larger than `MAX_LINE_BYTES` because a Candle snapshot
 * of 500 bars plus 500 indicator points can exceed 64 KiB (Reqs 1.5, 2.6). Engine stdin keeps
 * the 64 KiB `MAX_LINE_BYTES` limit.
 */
export const MAX_EVENT_LINE_BYTES = 512 * 1024;

const LF = 0x0a;
const CR = 0x0d;

export interface LineSplitterOptions {
  /** Longest accepted line in bytes, without its terminator. Defaults to `MAX_LINE_BYTES`. */
  readonly maxBytes?: number;
  /** Called once per dropped line with its length in bytes, without its terminator. */
  readonly onOversized?: (bytes: number) => void;
}

export class LineSplitter {
  readonly #max: number;
  readonly #onOversized: (bytes: number) => void;
  readonly #decoder = new TextDecoder("utf-8");
  /** Buffered bytes of the current line. Empty while discarding. */
  #parts: Uint8Array[] = [];
  /** Bytes seen so far of the current line, buffered or discarded. */
  #seen = 0;
  #discarding = false;
  /** Whether the last byte seen of the current line is `\r`. */
  #endsCr = false;

  constructor(options: LineSplitterOptions = {}) {
    const max = options.maxBytes ?? MAX_LINE_BYTES;
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError("maxBytes must be a positive integer");
    this.#max = max;
    this.#onOversized = options.onOversized ?? (() => {});
  }

  /** Bytes currently held for the unfinished line. Stays at most `maxBytes + 1`. */
  get bufferedBytes(): number {
    return this.#discarding ? 0 : this.#seen;
  }

  /** Adds a chunk and returns every line it completes, in order. */
  push(chunk: Uint8Array): string[] {
    const out: string[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(LF, start);
      const end = nl === -1 ? chunk.length : nl;
      if (end > start) this.#append(chunk.subarray(start, end));
      if (nl === -1) break;
      this.#finishLine(out);
      start = nl + 1;
    }
    return out;
  }

  /** Ends the stream: returns the final unterminated line, if any, and resets the splitter. */
  flush(): string[] {
    const out: string[] = [];
    if (this.#seen > 0) this.#finishLine(out);
    return out;
  }

  #append(part: Uint8Array): void {
    this.#endsCr = part[part.length - 1] === CR;
    this.#seen += part.length;
    if (this.#discarding) return;
    // One byte past the limit is allowed so a trailing `\r` does not count against it.
    if (this.#seen > this.#max + 1) {
      this.#discarding = true;
      this.#parts = [];
      return;
    }
    // Copy: the caller may reuse the chunk's buffer after `push` returns.
    this.#parts.push(part.slice());
  }

  #finishLine(out: string[]): void {
    const len = this.#seen - (this.#endsCr ? 1 : 0);
    const parts = this.#parts;
    const discarding = this.#discarding;
    this.#parts = [];
    this.#seen = 0;
    this.#discarding = false;
    this.#endsCr = false;

    if (discarding || len > this.#max) {
      this.#onOversized(len);
      return;
    }
    if (len === 0) return; // empty line: skipped (see header)
    out.push(this.#decoder.decode(concat(parts).subarray(0, len)));
  }
}

/**
 * The splitter for engine stdout, used by supervisor.ts and its tests so both share one
 * construction. Uses the `MAX_EVENT_LINE_BYTES` limit.
 */
export function createEngineStdoutSplitter(onOversized: (bytes: number) => void): LineSplitter {
  return new LineSplitter({ maxBytes: MAX_EVENT_LINE_BYTES, onOversized });
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const [first] = parts;
  if (parts.length === 1 && first !== undefined) return first;
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
