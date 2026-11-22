# Oni

Oni is a crypto **paper-trading** terminal for fast order entry, built for the Kiroween 2026 hackathon (Frankenstein category). No real orders are placed and no real money is used.

- **Next.js web UI** and **Ratatui TUI** with the same panels: chart, order book, trades, order ticket, positions and orders, watchlist, news, and an AI Copilot.
- **Bun server**: WebSocket gateway, risk checks, the single order router, plain-English orders, AI analyst, MCP server.
- **Rust engine** (sidecar process): market data, order books, candles, indicators, paper matcher, P&L and paper balance.
- **No database.** Orders, fills, and rejections live in an in-memory Activity_Log. Every account resets when the engine restarts.

## Run locally (no Docker)

Works in Git Bash, PowerShell, and macOS/Linux shells.

```
bun install
bun run gen:protocol
bun run build:engine
bun run dev
```

Open http://localhost:3000. In a second terminal run `bun run dev:tui`. `bun run dev` starts the server (ws://localhost:8080/ws, `/health`) and the web dev server; `bun run dev:server` starts only the server. `server/.env` is optional, and replay mode needs no keys.

## Contents

- [Safety](#safety)
- [Features](#features)
- [Local models with Ollama](#local-models-with-ollama)
- [Accounts and sign-in](#accounts-and-sign-in)
- [MCP server](#mcp-server)
- [Keys](#keys)
- [Setup and commands](#setup-and-commands)
- [Configuration](#configuration)
- [Deploy on Render](#deploy-on-render)
- [Downloads (TUI)](#downloads-tui)
- [Recording fixtures](#recording-fixtures)
- [Repository layout](#repository-layout)

## Safety

- **Paper only.** The matcher fills paper orders against live public market data or replayed fixtures. No funds move, no wallet transaction is built or signed, no testnet.
- **Endpoint allowlist.** Market data is read-only and limited to public, unauthenticated Coinbase and Backpack endpoints, `GET api.jup.ag/price/v3`, and `GET api-v3.raydium.io/mint/price` and `/pools/info/mint`. The server also calls its news and LLM hosts, only through the allowlisted HTTP wrapper `server/src/net/http.ts` (Rust twin: `feed/allowlist.rs`). No authenticated, trading, swap, or transaction endpoint is ever called.
- **One order path.** Every order, from the web UI, TUI, plain-English parser, AI analyst, or MCP server, goes through `server/src/router.ts` and the Risk_Engine before the engine sees it.
- **Confirm before placing.** Command bar, plain-English, and AI orders produce a preview. The router accepts them only after the same client confirms it.
- **The LLM never trades.** LLM output is untrusted input. It is validated with Zod and parsed by the normal command parser, so it can only produce a preview.
- **Risk limits and kill switch.** Limits have no bypass. `KILL_SWITCH=true` rejects every new order on every account. An order the account cannot pay for is rejected with `insufficient_balance`.
- **Secrets** come only from environment variables. `.env` is gitignored. Never commit a real value.

## Features

**Symbols and timeframes.** Ten symbols: `BTC-USD`, `ETH-USD`, `SOL-USD`, `BNB-USD`, `XRP-USD`, `DOGE-USD`, `JUP-USD`, `WIF-USD`, `BONK-USD`, `PEPE-USD`. Six timeframes: `1m 5m 15m 1h 4h 1d`.

**Venues.**

| Venue | Kind | Data |
|---|---|---|
| Coinbase | CEX | Public WebSocket and REST market data |
| Backpack | CEX | Public WebSocket and REST market data (USDC pairs shown as USD) |
| Jupiter | DEX | Prices only. Paper orders fill against a Synthetic_Book built around the price |
| Raydium | DEX | Prices and pool TVL only. Same Synthetic_Book fills |

Binance and Bybit appear as disabled chips only. `DATA_MODE=replay` (recorded fixtures, no keys) is the default. With `DATA_MODE=live`, `LIVE_VENUES` (comma list of `coinbase,backpack,jupiter,raydium`, default all four) picks the feeds. `LIVE_VENUE` with one value still works as an alias.

**Paper balance.** Each account starts with `STARTING_BALANCE` USD (default 100000) and resets with the engine. There is no margin or borrowing.

**Command bar.** Keywords are case-insensitive; short symbols like `BTC` resolve to `BTC-USD`.

```
BUY|SELL <symbol> <quantity> [LMT <price> | STP <price>]
BUY|SELL <symbol> <percent>%
BUY|SELL <symbol> <quantity> TWAP <slices> <seconds>     e.g. BUY BTC-USD 1 TWAP 4 60
CANCEL ALL
FLAT
```

TWAP: you confirm one preview, then the router sends one market child order per slice, each through the risk checks. Remaining children are cancelled on disconnect, account change, engine restart, a rejected child, or cancel.

**Plain-English orders.** Start the command bar text with `?`, for example `? buy a little ETH at 3000`. The text goes to the LLM provider and returns a preview you confirm.

**AI Copilot and analyst.** Analyze, trade suggestions, strategies, and opportunity scans. It only suggests. A trade becomes a preview and you confirm it. Providers: OpenAI, Anthropic, NVIDIA NIM, and Ollama. `LLM_PROVIDER` sets the default; `AI_RATE_PER_MIN` and `AI_DAILY_CAP` limit use (Ollama is not counted against the cap). Headlines and other external text are untrusted data.

**News.** NewsAPI (local development only) and CryptoPanic (hosted). `NEWS_PROVIDER` is `newsapi`, `cryptopanic`, or `none`.

**Web pages:** `/dashboard`, `/trade`, `/markets`, `/portfolio`, `/backtest`, `/copilot`, `/logs`, `/settings`, `/pair`.

## Local models with Ollama

1. Install [Ollama](https://ollama.com) and start it.
2. Pull a model: `ollama pull gemma4` (or any other model).
3. Optionally set `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`; `localhost` can resolve to IPv6 on Windows and fail) and `OLLAMA_MODEL` (the default model, `gemma4`) in `server/.env`.

Oni lists the installed models from Ollama's `/api/tags` and re-checks every 30 seconds. Each entry shows family, parameter size, and size on disk. Pick a model in the web Copilot panel or on the Settings page (remembered per browser), or cycle with `M` in the TUI. Ollama shows as unavailable when no model is installed. A hosted server cannot reach your local Ollama.

## Accounts and sign-in

- **Guest.** Everyone without a valid session shares one `guest` account. No wallet or keys needed.
- **Wallet (web).** Sign in with **Phantom** or **Backpack** through Wallet Standard and Sign In With Solana. The wallet signs one thing, the sign-in message ("Sign in to Oni paper trading. This signature does not authorize any transaction."). It never signs or sends a transaction, and the server never contacts a Solana RPC. Your account is `w_<address>`. The session token lasts 24 hours.
- **TUI pairing.** Press `P` in the TUI. It shows an 8-character code and a link `<web url>/pair/?code=...` (valid 5 minutes). Open it, sign in, and confirm the code. The token is saved to `haunted-terminal/session.json` in the per-user config directory (mode 0600 on Unix).
- `oni-tui --guest` ignores the saved sign-in. `oni-tui --logout` revokes the token, deletes the file, and exits.

## MCP server

Registered in `.kiro/settings/mcp.json` as `oni-terminal`, started with `bun run server/src/mcp/main.ts`. It is a client of a running Oni server, so start the server first.

Tools: `get_quote`, `get_candles`, `get_positions`, `preview_order`, `place_paper_order`. Orders go through the same router and risk checks as every other order.

- `TERMINAL_URL` is the server address (default `http://localhost:8080`).
- Without `TERMINAL_TOKEN` the MCP server uses the guest account. To use a wallet account, set a session token in `TERMINAL_TOKEN` in the environment that launches Kiro. Never write it into `mcp.json`.

## Keys

The shared bindings are in `shared/keymap.json`. The mouse works on every panel.

| Key | Web | TUI |
|---|---|---|
| Timeframes | `1`–`6` (1m, 5m, 15m, 1h, 4h, 1d) | `<` / `>` previous / next |
| Pages | `Alt+1` … `Alt+8` | `[1]`–`[8]` |
| `V` | Next venue | Next venue |
| `G` | Next AI provider | Next AI provider |
| `M` | | Next model (Ollama) |
| `C` | Focus Copilot | Focus Copilot |
| `l` | | Chart type |
| `t` | | Ticket order type |
| `P` | | Pair with the web UI |
| `F1` | Help | Help |

## Setup and commands

Requirements: [Bun](https://bun.sh) 1.4.4, Rust 1.94 with `clippy` and `rustfmt`. On Windows the release builds use the MSVC toolchain.

```sh
bun install                                              # server, web, shared dependencies
bun run gen:protocol                                     # regenerate shared/protocol/*.ts from the Rust protocol crate
cargo build --manifest-path rust/Cargo.toml --release    # builds engine and tui
bun run check                                            # cargo fmt, clippy, cargo test, tsc, bun test
bun run --cwd web build                                  # static export of the web UI
bun run bench:latency                                    # server + engine in replay mode, prints p50 and p95
```

`bun run check` needs no database, API key, or network. Do not hand-edit `shared/protocol/`.

Run locally (replay mode, no keys), from the repository root:

```sh
cp server/.env.example server/.env              # optional; empty values select defaults
cd server && bun run start                      # server on http://localhost:8080 (spawns the engine)
bun run --cwd web dev                           # web UI on http://localhost:3000
./rust/target/release/tui --server ws://localhost:8080/ws   # TUI
```

- `ENGINE_PATH` defaults to `rust/target/release/engine` (`.exe` on Windows). For a debug build set it to `rust/target/debug/engine`.
- `REPLAY_SPEED` (1 to 50) speeds up replay.
- The web UI reads `NEXT_PUBLIC_WS_URL` (`ws://localhost:8080/ws`) and `NEXT_PUBLIC_API_URL` (`http://localhost:8080`). `ALLOWED_ORIGINS` must include the web origin.
- `GET /health` reports the engine state.

Regenerate the demo fixture:

```sh
cargo run --manifest-path rust/Cargo.toml -p engine -- synth --out fixtures/demo.jsonl
```

## Configuration

Names only; copy `server/.env.example` to `server/.env` (gitignored) and fill in values locally. Empty means default.

| Variable | Secret | Purpose |
|---|---|---|
| `PORT` | no | HTTP and WebSocket port (default 8080) |
| `ENGINE_PATH` | no | Path to the engine binary |
| `DATA_MODE` | no | `replay` (default) or `live` |
| `LIVE_VENUES` | no | Live feeds, default all four. `LIVE_VENUE` is a single-venue alias |
| `ALLOWED_ORIGINS` | no | Browser origins allowed to open `/ws` and the auth routes |
| `WEB_URL` | no | Web UI origin for pairing links. Must be in `ALLOWED_ORIGINS` |
| `KILL_SWITCH` | no | `true` rejects every new order |
| `SESSION_SECRET` | yes | HMAC key for session tokens, at least 32 bytes in production |
| `NODE_ENV` | no | `production` enables strict checks |
| `STARTING_BALANCE` | no | Starting paper balance in USD |
| `BALANCE_SLIPPAGE_BPS` | no | Slippage allowance for balance checks |
| `JUPITER_API_KEY` | yes | Optional. Raises the Jupiter price rate limit. Sent only to the Jupiter Price API |
| `DEX_*` | no | DEX poll and staleness tuning |
| `LLM_PROVIDER` | no | Default AI provider |
| `OPENAI_API_KEY` | yes | Enables OpenAI |
| `ANTHROPIC_API_KEY` | yes | Enables Anthropic |
| `NVIDIA_API_KEY` | yes | Enables NVIDIA NIM |
| `NVIDIA_BASE_URL` | yes | NVIDIA NIM base URL (a URL can carry credentials) |
| `OLLAMA_BASE_URL` | yes | Ollama base URL (default `http://127.0.0.1:11434`) |
| `OLLAMA_MODEL` | no | Default Ollama model (`gemma4`) |
| `AI_RATE_PER_MIN` | no | AI requests per connection per minute |
| `AI_DAILY_CAP` | no | AI provider calls per UTC day |
| `NEWS_PROVIDER` | no | `newsapi`, `cryptopanic`, or `none` |
| `NEWS_API_KEY` | yes | NewsAPI key (development only) |
| `CRYPTOPANIC_API_KEY` | yes | CryptoPanic token |
| `CRYPTOPANIC_PLAN` | no | CryptoPanic plan |
| `NEWS_TTL_SECONDS` | no | News cache time |
| `NEWS_ALLOW_NEWSAPI_IN_PRODUCTION` | no | Allow NewsAPI in production (terms may forbid it) |
| `TERMINAL_TOKEN` | yes | MCP process only: session token for a wallet account |

There is no `DATABASE_URL`. Model overrides (`OPENAI_MODEL`, `ANTHROPIC_MODEL`, `NVIDIA_MODEL`) are listed in `server/.env.example`.

## Deploy on Render

`render.yaml` defines two services:

| Service | Type | Runs |
|---|---|---|
| `oni-server` | Docker web service (free plan) | Bun server and Rust engine, built from `Dockerfile` |
| `oni-web` | Static site | Next.js static export from `web/` |

1. Push the repository to GitHub.
2. In Render choose **New > Blueprint**, select the repository, and apply `render.yaml`.
3. Enter the values marked `sync: false` in the dashboard (API keys, for example). `SESSION_SECRET` is generated by Render.

If a service name is taken, Render adds a suffix to the URL. Then update `ALLOWED_ORIGINS` and `WEB_URL` on `oni-server`, and `NEXT_PUBLIC_WS_URL` (`wss://<server-host>/ws`) and `NEXT_PUBLIC_API_URL` (`https://<server-host>`) on `oni-web`, and redeploy `oni-web`. The TUI defaults to `wss://oni-server.onrender.com/ws`; use `--server` for other hosts.

Free-plan limits: the server sleeps after 15 minutes without traffic and takes about a minute to wake. A restart resets the engine, so every paper account resets. There is no database service.

## Downloads (TUI)

Each tagged release (`v*`) has `oni-tui-windows-x64.zip`, `oni-tui-macos-universal.tar.gz`, and `SHA256SUMS.txt`. Each archive unpacks to `oni/` with `oni-tui`, `oni-engine`, `fixtures/`, `LICENSE`, and `README.md`. The binaries are not code-signed.

Verify: `Get-FileHash .\oni-tui-windows-x64.zip -Algorithm SHA256` (Windows) or `shasum -a 256 oni-tui-macos-universal.tar.gz` (macOS), and compare with `SHA256SUMS.txt`.

Run: `.\oni\oni-tui.exe` (Windows) or `./oni/oni-tui` (macOS).

| Flag | Meaning |
|---|---|
| `--server <URL>` | WebSocket URL of the Oni server (`ws://` or `wss://`). Default: the hosted server |
| `--guest` | Use the guest account and ignore any saved sign-in |
| `--logout` | Revoke the saved token, delete it, and exit |
| `--version` | Print the version |

- **macOS Gatekeeper** blocks unsigned downloads. Run `xattr -d com.apple.quarantine ./oni/oni-tui ./oni/oni-engine`, or right-click the file and choose **Open**.
- **Windows SmartScreen** may warn. Click **More info**, then **Run anyway**, or tick **Unblock** in the zip's Properties before extracting.

## Recording fixtures

`engine record` captures one venue's public feed into a fixture that replay mode plays back.

```sh
cargo run --manifest-path rust/Cargo.toml -p engine --release -- record \
  --venue backpack --symbols BTC-USD,ETH-USD,SOL-USD --out fixtures/backpack-live.jsonl
```

| Flag | Meaning |
|---|---|
| `--venue coinbase\|backpack` | Feed to record (default `backpack`) |
| `--symbols` | Comma-separated internal symbols |
| `--out <path>` | Required output file |
| `--duration <s>` | Stop after this many seconds (default 300, at most 86400) |
| `--max-messages <n>` | Stop after this many lines |
| `--force` | Replace an existing output or leftover `.partial` file |

Lines go to `<out>.partial` and are renamed when the run ends. Ctrl-C is not handled; use `--duration` or `--max-messages`.

## Repository layout

| Path | Contents |
|---|---|
| `rust/` | Cargo workspace: `protocol`, `engine`, `tui` |
| `server/` | Bun + Hono server |
| `web/` | Next.js web UI |
| `shared/` | Generated protocol types and `keymap.json` |
| `fixtures/` | Replay fixtures |
| `.kiro/` | Specs, steering, hooks, MCP settings |

## License

[MIT](LICENSE)
