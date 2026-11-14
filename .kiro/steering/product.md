# Product: Oni

Oni is a crypto **paper-trading** terminal for fast order entry, built for the Kiroween 2026 hackathon (Frankenstein category). Deadline: Dec 4, 2026, 2:00 PM PT. Internal target: Dec 3.

## What it is
- Two clients with the same panels and actions: a Next.js web UI and a Ratatui terminal UI (TUI) for Windows and macOS.
- One Bun server that both clients connect to over WebSocket.
- One native Rust engine, run by the server as a sidecar process, that owns market data, the order book, candles, indicators, the paper matcher, and P&L for every paper account.
- Extra order sources that go through the same path: plain-English orders (LLM) and an MCP server for agents such as Kiro.
- Wallet sign-in (Phantom, Backpack) in the web UI through Wallet Standard and Sign In With Solana. The TUI signs in by pairing with the web UI through a short code.

## Users
- Traders practising quick order entry with mouse and keyboard.
- Solana users who sign in with their wallet to get their own paper account.
- Hackathon judges who open the hosted web UI or download the TUI. Replay mode and the guest account must work with no API keys and no wallet.

## Scope rules
- **Paper only.** The matcher fills paper orders against live public market data or replayed fixtures. No real funds, no wallet transactions, no testnet, no authenticated exchange endpoints.
- Market: crypto only (BTC-USD, ETH-USD, SOL-USD). Live data comes from the Coinbase or Backpack public feed, chosen by `LIVE_VENUE` (default `backpack`; Backpack's USDC pairs are shown as USD). Replay of recorded fixtures is the default data mode.
- Accounts: each signed-in wallet gets its own paper account, keyed by its address (`w_<address>`). Everyone without a valid session shares one `guest` account, with no login needed. Every account resets when the engine restarts; nothing is restored from the journal.
- Wallets sign only the sign-in message, never a transaction.
- Input: mouse and keyboard only. No gamepad, MIDI, or other hardware.
- No WASM.
- Hosting: Render (Docker web service + static site) via `render.yaml`.

## Source of truth
The spec in `.kiro/specs/haunted-terminal/` (requirements, design, tasks) defines behaviour. Reference requirement IDs (e.g. "Req 19.6") in code comments and tests where a rule is enforced.

#[[file:.kiro/specs/haunted-terminal/requirements.md]]
