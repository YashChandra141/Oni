# Oni

A keyboard-and-mouse crypto **paper-trading** terminal with a web UI and a terminal UI, built for the Kiroween 2026 hackathon (Frankenstein category).

- **Rust engine** (sidecar process): market data, order book, candles, indicators, paper matcher, P&L
- **Bun server**: WebSocket gateway, risk checks, order router, plain-English orders, MCP server
- **Next.js web UI** and **Ratatui TUI** with the same charts and panels, on Windows and macOS

All trading is simulated. No real orders are placed and no real money is used.

## Contents

- [Repository layout](#repository-layout)
- [Deploy on Render](#deploy-on-render)
- [Free-plan limits](#free-plan-limits)
- [Accounts, wallets, pairing, and data venues](#accounts-wallets-pairing-and-data-venues)
  - [Guest and wallet accounts](#guest-and-wallet-accounts)
  - [Sign in with a wallet (web UI)](#sign-in-with-a-wallet-web-ui)
  - [Sign in from the TUI (pairing)](#sign-in-from-the-tui-pairing)
  - [MCP server for Kiro and other agents](#mcp-server-for-kiro-and-other-agents)
  - [Live market data and venues](#live-market-data-and-venues)
  - [Local `.env` for sign-in](#local-env-for-sign-in)
- [Downloads (terminal UI)](#downloads-terminal-ui)
- [Build from source](#build-from-source)
- [Development](#development)

## Repository layout

| Path | Contents |
|---|---|
| `rust/` | Cargo workspace: `protocol`, `engine`, `tui` crates |
| `server/` | Bun + Hono server |
| `web/` | Next.js web UI |
| `shared/` | Generated protocol types and the shared keymap |
| `.kiro/` | Kiro specs, steering docs, and hooks |

## Deploy on Render

The repository contains a Render Blueprint, `render.yaml`, that defines two services:

| Service | Type | What it runs |
|---|---|---|
| `oni-server` | Docker web service (free plan) | The Bun server and the Rust engine, built from `Dockerfile` |
| `oni-web` | Static site | The Next.js static export from `web/` |

1. Push the repository to GitHub (or fork it).
2. In the Render dashboard choose **New > Blueprint**, select the repository, and apply `render.yaml`.
3. When Render asks for the values marked `sync: false`, enter them. Never put them in the repository.

| Variable | Where it comes from |
|---|---|
| `OPENAI_API_KEY` | You set it in the dashboard. Optional. Without it, plain-English orders (`?` prefix) are disabled. |
| `SESSION_SECRET` | Render generates it (`generateValue: true`). Do not set it yourself. |

The Blueprint sets everything else (`NODE_ENV=production`, `DATA_MODE=replay`, `LIVE_VENUE=backpack`,
`KILL_SWITCH=false`, `PORT=10000`, `ENGINE_PATH`).

The services get these URLs if the names are free:

- Web UI: `https://oni-web.onrender.com`
- Server: `https://oni-server.onrender.com` (WebSocket at `wss://oni-server.onrender.com/ws`)

Render service names are global. If `oni-web` or `oni-server` is taken, Render adds a suffix to the
URL. Rename the services in `render.yaml` or accept the new URLs, then update every place that holds
a URL:

| Setting | Service | Value |
|---|---|---|
| `ALLOWED_ORIGINS` | `oni-server` | The web UI origin, for example `https://oni-web.onrender.com` |
| `WEB_URL` | `oni-server` | The same web UI origin. It must be listed in `ALLOWED_ORIGINS` or the server refuses to start. |
| `NEXT_PUBLIC_WS_URL` | `oni-web` | `wss://<your-server-host>/ws` |
| `NEXT_PUBLIC_API_URL` | `oni-web` | `https://<your-server-host>` |

`NEXT_PUBLIC_*` values are baked in at build time, so redeploy `oni-web` after changing them. The TUI
defaults to `wss://oni-server.onrender.com/ws`; with other names, pass `--server` (see below).

There is no database service and no migration step. Orders, fills, and rejections live in memory
for the current engine run only; they reset when the engine restarts.

## Free-plan limits

The hosted demo runs on Render's free plan:

- The server **sleeps after 15 minutes without traffic**. The first request after that takes about
  **1 minute** to wake it. Open the web UI early, or wait for the connection to come back.
- When the server sleeps and restarts, the engine restarts too, so **every paper account resets**
  (positions and open orders go back to flat).
- Orders, fills, and rejections live in memory for the current engine run only; they reset when the
  engine restarts.

## Accounts, wallets, pairing, and data venues

### Guest and wallet accounts

Everyone without a valid session trades on one shared **guest** account (`guest`). It needs no
wallet and no keys, so the web UI, the TUI, and the MCP server work out of the box.

Signing in with a wallet gives you your own paper account, keyed by your address (`w_<address>`).
Your orders and positions are separate from every other account.

Every account resets when the engine restarts (including a Render wake-up). Positions and open
orders go back to flat, and nothing is stored or restored.

### Sign in with a wallet (web UI)

Click the sign-in button in the web UI and pick **Phantom** or **Backpack**. The wallet is asked to
sign exactly one thing, a Sign In With Solana message with this statement:

> Sign in to Oni paper trading. This signature does not authorize any transaction.

The wallet never signs or sends a transaction, and the server never contacts a Solana RPC endpoint.
The session token lasts 24 hours. Signing out is best effort: the server keeps the list of signed-out
tokens in memory only, so after a server restart a token you signed out of is accepted again until
it expires.

### Sign in from the TUI (pairing)

The TUI cannot talk to a wallet, so it pairs with the web UI:

1. In the TUI press `P`. It shows an 8-character code and a link of the form
   `<web url>/pair/?code=ABCD2345`. The code expires after 5 minutes.
2. Open the link in a browser and sign in with your wallet if you are not signed in yet.
3. Confirm the code on that page. The TUI picks up the session within a few seconds.

The TUI saves the token for that server in `haunted-terminal/session.json` inside the per-user
config directory:

| OS | File |
|---|---|
| Windows | `%APPDATA%\haunted-terminal\session.json` |
| macOS | `~/Library/Application Support/haunted-terminal/session.json` |
| Other Unix | `$XDG_CONFIG_HOME/haunted-terminal/session.json`, or `~/.config/haunted-terminal/session.json` |

On Unix the file mode is 0600. The token is used only for the server it was issued by.

- `oni-tui --guest` ignores any saved sign-in and uses the guest account. It does not read or change
  the file.
- `oni-tui --logout` revokes the saved token on the server, deletes the file, and exits.

### MCP server for Kiro and other agents

The MCP server exposes `get_quote`, `get_candles`, `get_positions`, `preview_order`, and
`place_paper_order`. It is a client of a running Oni server, so start the server first. Register it
in `.kiro/settings/mcp.json` as `oni-terminal`, started with `bun run server/src/mcp/main.ts`:

```json
{
  "mcpServers": {
    "oni-terminal": {
      "command": "bun",
      "args": ["run", "server/src/mcp/main.ts"],
      "env": {
        "TERMINAL_URL": "http://localhost:8080",
        "TERMINAL_TOKEN": "${TERMINAL_TOKEN}"
      }
    }
  }
}
```

- `TERMINAL_URL` is the HTTP(S) address of the Oni server. It defaults to `http://localhost:8080`.
- Without `TERMINAL_TOKEN` the MCP server uses the guest account. An unset, empty, or unexpanded
  `${TERMINAL_TOKEN}` counts as unset.
- To trade on a wallet account, put a session token in `TERMINAL_TOKEN`. Set it in the environment
  that launches Kiro, because Kiro expands `${VAR}` only for approved environment variables. Never
  write the token into `mcp.json` or commit it. It expires after 24 hours.
- Orders from MCP tools go through the same router and risk checks as every other order.

### Live market data and venues

Replay is the default. The engine plays recorded fixtures and needs no keys. For live public
market data, set these in `server/.env`:

```sh
DATA_MODE=live
LIVE_VENUE=backpack   # default; or coinbase
```

`backpack` is the default venue. Its USDC pairs (`BTC_USDC`, `ETH_USDC`, `SOL_USDC`) are shown as
USD. `coinbase` uses BTC-USD, ETH-USD, and SOL-USD. Only public, unauthenticated market-data
endpoints are used. To capture a fixture from a venue, see
[Recording fixtures](#recording-fixtures) (`engine record --venue coinbase|backpack`).

### Local `.env` for sign-in

Copy `server/.env.example` to `server/.env` (gitignored). For wallet sign-in:

- `SESSION_SECRET`: at least 32 bytes of random data. It is required in production. Outside
  production the server generates one per run, so sessions do not survive a restart. On Render it is
  generated for you.
- `WEB_URL`: the web UI origin, for example `http://localhost:3000`. It must also be listed in
  `ALLOWED_ORIGINS`, or the server refuses to start. The pairing link is built from it.

Never commit `.env` or paste a real secret or token into the repository.

## Downloads (terminal UI)

Each tagged release (`v*`) on the GitHub Releases page has these files:

| File | Platform |
|---|---|
| `oni-tui-windows-x64.zip` | Windows x64 |
| `oni-tui-macos-universal.tar.gz` | macOS, Apple Silicon and Intel |
| `SHA256SUMS.txt` | SHA-256 checksums for both archives |

Each archive unpacks to an `oni/` folder with `oni-tui` (the terminal client), `oni-engine` (the
engine, needed only to run your own server), `fixtures/`, `LICENSE`, and `README.md`. The binaries are
not code-signed.

### Verify the download

Compare the hash of the file with the line for that file in `SHA256SUMS.txt`.

Windows (PowerShell):

```powershell
Get-FileHash .\oni-tui-windows-x64.zip -Algorithm SHA256
```

macOS:

```sh
shasum -a 256 oni-tui-macos-universal.tar.gz
```

Do not run the archive if the hashes differ.

### Run the TUI

Windows (PowerShell):

```powershell
Expand-Archive .\oni-tui-windows-x64.zip -DestinationPath .
.\oni\oni-tui.exe
```

macOS:

```sh
tar -xzf oni-tui-macos-universal.tar.gz
./oni/oni-tui
```

With no arguments the TUI connects to the hosted server, `wss://oni-server.onrender.com/ws`. The
hosted server may need about a minute to wake (see [Free-plan limits](#free-plan-limits)).

| Flag | Meaning |
|---|---|
| `--server <URL>` | WebSocket URL of the Oni server (`ws://` or `wss://`). Default: the hosted server. |
| `--guest` | Use the shared guest account and ignore any saved sign-in. |
| `--logout` | Sign out: revoke the saved token on the server, delete it, and exit. |
| `--version` | Print the version. |

To use a server on your own machine (see [Build from source](#build-from-source)):

```sh
./oni/oni-tui --server ws://localhost:8080/ws
```

### macOS Gatekeeper

The macOS binaries are unsigned, so Gatekeeper blocks them after a browser download with a message
that the developer cannot be verified. Either remove the quarantine flag:

```sh
xattr -d com.apple.quarantine ./oni/oni-tui ./oni/oni-engine
```

or in Finder right-click (Control-click) the file, choose **Open**, and confirm **Open** in the
dialog. You only need to do this once per file. Files downloaded with `curl` carry no quarantine
flag and run without this step.

### Windows SmartScreen

The Windows binaries are unsigned, so SmartScreen may show "Windows protected your PC". Click
**More info**, then **Run anyway**. If you run `oni-tui.exe` from a terminal, SmartScreen may not
prompt at all. If the zip is marked as downloaded from the internet, you can also right-click it,
open **Properties**, and tick **Unblock** before extracting.

## Build from source

Prerequisites:

- Rust 1.94 with `clippy` and `rustfmt` (edition 2024). On Windows the release builds use the MSVC
  toolchain.
- [Bun](https://bun.sh) 1.4.4.

```sh
bun install                 # JavaScript dependencies for server, web, and shared
cargo build --release --manifest-path rust/Cargo.toml   # builds tui and engine
bun run check               # fmt, clippy, Rust tests, typecheck, bun tests
```

The release binaries are `rust/target/release/tui` and `rust/target/release/engine` (`.exe` on
Windows). The release workflow renames them to `oni-tui` and `oni-engine`.

Run everything locally, in three terminals from the repository root:

```sh
# 1. Server on http://localhost:8080 (replay mode, no keys needed)
cd server && bun run start

# 2. Web UI on http://localhost:3000
bun run --cwd web dev

# 3. Terminal UI
./rust/target/release/tui --server ws://localhost:8080/ws
```

The web UI reads the server addresses from `NEXT_PUBLIC_WS_URL` and `NEXT_PUBLIC_API_URL`. Set them
to `ws://localhost:8080/ws` and `http://localhost:8080` for local use if they are not already. For
the browser to connect, `ALLOWED_ORIGINS` on the server must include the web origin, for example
`http://localhost:3000`. See `server/.env.example`, and
[Run the server locally](#run-the-server-locally) for engine and replay options.

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
