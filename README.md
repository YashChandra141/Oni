# Haunted Terminal

A keyboard-and-mouse crypto **paper-trading** terminal with a web UI and a terminal UI, built for the Kiroween 2026 hackathon (Frankenstein category).

- **Rust engine** (sidecar process): market data, order book, candles, indicators, paper matcher, P&L
- **Bun server**: WebSocket gateway, risk checks, order router, journal, plain-English orders, MCP server
- **Next.js web UI** and **Ratatui TUI** with the same charts and panels, on Windows and macOS

All trading is simulated. No real orders are placed and no real money is used.

> Status: under construction. Setup, deploy, and download instructions are added as each part lands.

## Repository layout

| Path | Contents |
|---|---|
| `rust/` | Cargo workspace: `protocol`, `engine`, `tui` crates |
| `server/` | Bun + Hono server |
| `web/` | Next.js web UI |
| `shared/` | Generated protocol types and the shared keymap |
| `.kiro/` | Kiro specs, steering docs, and hooks |

## Development

Requirements: [Bun](https://bun.sh) 1.4.4 and Rust 1.94 with `clippy` and `rustfmt`.

```sh
bun install
bun run check   # Rust fmt + clippy + tests, TypeScript typecheck + tests
```

### Run the server locally

The server spawns the Rust engine as a child process, so build the engine first. Replay mode is
the default and needs no API keys: the engine plays the recorded `fixtures/demo.jsonl`.

```sh
# 1. Build the engine (from the repository root).
cargo build --manifest-path rust/Cargo.toml -p engine --release

# 2. Optional: copy the example config. Empty values select the defaults.
cp server/.env.example server/.env

# 3. Start the server (from server/). It listens on PORT (default 8080).
cd server
bun run start
```

- `ENGINE_PATH` defaults to `rust/target/release/engine` (`engine.exe` on Windows), resolved
  from the repository root. For a debug build, set `ENGINE_PATH=rust/target/debug/engine`
  (`.exe` on Windows) in `server/.env`.
- `REPLAY_SPEED` (1 to 50, default 1) speeds up the replay. `REPLAY_SPEED=50` plays the 2-hour
  demo fixture in about 2.5 minutes.
- Check it: `GET http://localhost:8080/health` reports the engine state. A WebSocket client on
  `ws://localhost:8080/ws` that sends `{"type":"subscribe","symbol":"BTC-USD","timeframe":"1m"}`
  gets a candle snapshot, then live candles and BTC-USD trades.
- The integration tests in `server/src/integration/` use the debug engine binary
  (`cargo build --manifest-path rust/Cargo.toml -p engine`) and are skipped when it is missing.

### Recording fixtures

`engine record` captures the public feed of one venue into a fixture file. It reads public
market data only (no keys), and writes normalized `{"recv", "msg"}` lines that replay mode plays
back.

```sh
cargo run --manifest-path rust/Cargo.toml -p engine --release -- record \
  --venue backpack --symbols BTC-USD,ETH-USD,SOL-USD --out fixtures/backpack-live.jsonl
```

| Flag | Meaning |
|---|---|
| `--venue coinbase\|backpack` | Feed to record (default `backpack`). |
| `--symbols` | Comma-separated internal symbols (default `BTC-USD,ETH-USD,SOL-USD`). |
| `--out <path>` | Required. Put captures in `fixtures/`; missing directories are created. |
| `--duration <s>` | Stop after this many seconds (default 300, at most 86400). |
| `--max-messages <n>` | Stop after this many lines. |
| `--force` | Replace an existing output file or a leftover `.partial` file. |

Lines are written to `<out>.partial` and renamed to `<out>` when the run ends, so a fixture under
its final name is always complete. The command refuses to overwrite without `--force`, logs to
stderr, and reads the finished file back to check it. Ctrl-C is not handled (the engine's tokio
build has no `signal` feature); use `--duration` or `--max-messages`. After a kill, only the
`.partial` file exists and its last line may be cut short.

The parsers were written from the venue docs and the hand-written samples in
`rust/crates/engine/tests/data/`. Replace those samples with real captures, and use them to
confirm the open `TODO(Task 7.7)` items:

- `feed/coinbase_parse.rs`: the trade `side` mapping (maker side vs taker side). Flip it if the
  capture shows the opposite.
- `feed/backpack_parse.rs`: the short WebSocket field names (`p q m T E` for trades,
  `a b U u T E` for depth), and the kline `interval` names.
- `feed/backpack.rs`: the kline request limit (`MAX_KLINES`).

## License

[MIT](LICENSE)
