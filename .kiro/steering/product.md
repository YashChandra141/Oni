# Product: Oni

Oni is a crypto **paper-trading** terminal for fast order entry, built for the Kiroween 2026 hackathon (Frankenstein category). Deadline: Dec 4, 2026, 2:00 PM PT. Internal target: Dec 3.

## What it is
- Two clients with the same panels and actions: a Next.js web UI and a Ratatui terminal UI (TUI) for Windows and macOS. Both show a chart, order book, trades, an order ticket, positions and orders, a watchlist, news, and an AI Copilot panel.
- One Bun server that both clients connect to over WebSocket.
- One native Rust engine, run by the server as a sidecar process, that owns market data, the order books, candles, indicators, the paper matcher, and P&L and paper balance for every paper account.
- Extra order sources that go through the same path: plain-English orders (LLM), the AI analyst, and an MCP server for agents such as Kiro. The AI analyst suggests a trade as a preview that the user must confirm. No AI component places an order.
- Pluggable AI providers: OpenAI, Anthropic, NVIDIA NIM, and Ollama.
- Crypto news from NewsAPI (local development) and CryptoPanic (hosted).
- Wallet sign-in (Phantom, Backpack) in the web UI through Wallet Standard and Sign In With Solana. The TUI signs in by pairing with the web UI through a short code.
- No database. Orders, fills, and rejections live in memory for the current engine run only.

## Users
- Traders practising quick order entry with mouse and keyboard.
- Solana users who sign in with their wallet to get their own paper account.
- Hackathon judges who open the hosted web UI or download the TUI. Replay mode and the guest account must work with no API keys and no wallet.

## Scope rules
- **Paper only.** The matcher fills paper orders against live public market data or replayed fixtures. No real funds, no wallet transactions, no testnet, no authenticated exchange endpoints. Jupiter and Raydium are price-only: the system builds, signs, and sends no transaction.
- Market: crypto only, ten symbols (BTC-USD, ETH-USD, SOL-USD, BNB-USD, XRP-USD, DOGE-USD, JUP-USD, WIF-USD, BONK-USD, PEPE-USD). Live data comes from four venues chosen by `LIVE_VENUES` (default all four): Coinbase and Backpack public feeds, and Jupiter and Raydium public prices. Backpack's USDC pairs are shown as USD. Binance and Bybit appear in the web UI as disabled chips only. Replay of recorded fixtures is the default data mode.
- Accounts: each signed-in wallet gets its own paper account, keyed by its address (`w_<address>`). Everyone without a valid session shares one `guest` account, with no login needed. Every account resets when the engine restarts; nothing is stored or restored. An order that the account cannot pay for is rejected with `insufficient_balance`.
- Wallets sign only the sign-in message, never a transaction.
- Input: mouse and keyboard only. No gamepad, MIDI, or other hardware.
- No WASM.
- Hosting: Render (Docker web service + static site) via `render.yaml`. No database service.

## Source of truth
The spec in `.kiro/specs/oni-terminal-v2/` (requirements, design, tasks) defines behaviour for version 2. It extends `.kiro/specs/haunted-terminal/`, which still defines everything that version 2 does not change or supersede. Reference requirement IDs (e.g. "Req 19.6") in code comments and tests where a rule is enforced.

#[[file:.kiro/specs/haunted-terminal/requirements.md]]

#[[file:.kiro/specs/oni-terminal-v2/requirements.md]]
