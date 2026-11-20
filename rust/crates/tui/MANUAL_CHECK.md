# TUI manual check (Task 6.6)

Run this on each of: Windows Terminal, PowerShell (classic console host), Terminal.app, iTerm2.
Requirements 34.3, 34.4, 35, 36.3, 36.4.

## Setup

1. Build the engine and TUI: `cargo build --manifest-path rust/Cargo.toml --workspace`.
2. Start the server in replay mode (no API keys, no wallet), from the repo root:
   - `ENGINE_PATH=rust/target/debug/engine DATA_MODE=replay ALLOWED_ORIGINS=http://localhost:3000 bun --cwd server start`
   - PowerShell: set the three variables with `$env:NAME = "value"` first, and use `rust\target\debug\engine.exe`.
   - Wait for the server log to say it is listening (default `PORT` is in `server/.env.example`).
3. In another window of the terminal under test, run the TUI against it:
   - `cargo run --manifest-path rust/Cargo.toml -p tui -- --server ws://localhost:<PORT>/ws`

## Checklist (repeat per terminal)

- [ ] Colors: candles are green (up) and red (down); indicator lines and the status line are colored.
- [ ] Block and braille characters: candle bodies and wicks are solid with no gaps or `?` boxes. Indicator lines are smooth.
- [ ] Candles arrive and the chart updates continuously from the replay. The UI feels smooth with no flicker.
- [ ] History and indicators: after the replay warm-up, the chart opens with history candles (about 90 one-minute candles with the demo fixture), not a single candle. The EMA and VWAP lines are drawn across the history candles, not only over the newest one. Switch to another timeframe and back to 1m: no stale indicator segments remain (no leftover line pieces from the other timeframe, and no gaps or jumps in the lines).
- [ ] Mouse wheel up zooms in (fewer, wider candles). Wheel down zooms out.
- [ ] Left-button drag on the chart pans back and forward. Dragging right at the newest candle does not go past it.
- [ ] Hovering the chart shows the crosshair. Moving the mouse out of the chart clears it.
- [ ] Clicking each timeframe button (1m, 5m, 15m, 1h, 1d) switches the chart and highlights the selected one.
- [ ] Keyboard: the timeframe keys and the zoom and pan keys from `shared/keymap.json` work.
- [ ] Resize: drag the window larger and smaller, and maximize and restore. The layout redraws without leftover characters or a crash. A very small window does not panic.
- [ ] Redraw rate: while the replay runs, CPU use of the `tui` process stays low (a few percent), and the window stays still when the server is stopped.
- [ ] Reconnect: stop the server. The status line shows the reconnecting state. Start it again. The chart resumes.
- [ ] Quit with `q`: the shell prompt returns, with the normal screen, a visible cursor, no mouse reporting (moving or clicking the mouse prints nothing), and typed input echoed.
- [ ] Quit with Ctrl-C: same result as `q`.
- [ ] Panic restore: temporarily add `panic!("manual check");` at the top of `fn draw` in `rust/crates/tui/src/ui.rs`, run the TUI, and confirm the terminal is restored first and the panic message is readable on the normal screen. **Remove the line afterwards.**

## Order entry (Task 12.4)

Use a terminal at least 120 columns by 45 rows for the panel strip, and one 60 columns by 20 rows
for the narrow layout. Requirements 22, 28, 30, 31.

- [ ] `:` focuses the command bar; typing `q` or `p` types text instead of quitting or pairing; Esc leaves it.
- [ ] `BUY BTC 0.1 LMT 64000` then Enter shows the preview dialog with a countdown; Enter or Y confirms, Esc or N discards; the dialog closes by itself at 0 s.
- [ ] `BUY XYZ 1` then Enter keeps the text and shows a caret under `XYZ` with the message below.
- [ ] Up and Down in the command bar walk the history.
- [ ] Book: Down, Enter fills the limit price and focuses the ticket quantity; type `0.1`, then B sends a preview; Esc leaves the ticket. `M` makes it a market order.
- [ ] F and X open a yes/no dialog; only Enter or Y sends. Clicking Confirm and Cancel works too.
- [ ] Click the orders panel, use Up, Down, Delete; click ✕ on a row; an order the server rejects shows a red reason for 10 s.
- [ ] Switch accounts (pair a wallet, or sign out): positions, orders, and dialogs clear.

## Result log

| Terminal | OS and version | Pass or fail | Notes |
|---|---|---|---|
| Windows Terminal | | | |
| PowerShell (console host) | | | |
| Terminal.app | | | |
| iTerm2 | | | |

Open item: this check has not been run. The user runs it on all four terminals and records the result above.
