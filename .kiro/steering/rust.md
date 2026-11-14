---
inclusion: fileMatch
fileMatchPattern: 'rust/**'
---

# Rust Rules

## Numbers
- Prices are `Price(i64)` ticks, quantities are `Qty(i64)` lots, money is `Money(i64)` at 10⁻¹⁰ USD. Floats (`f64`) are allowed only for indicator values.
- Multiply in `i128` and convert back with checked conversion. Overflow is an error, never a wrap.
- On the wire, the i64 newtypes serialize as JSON strings (JavaScript loses precision above 2⁵³).

## Errors
- No `unwrap()` or `expect()` outside tests. Clippy denies both (`rust/Cargo.toml` workspace lints; tests are exempt via `rust/clippy.toml`).
- Use `thiserror` enums for library errors. Bad input becomes an `Event::Error`, never a panic.
- `unsafe` is forbidden workspace-wide.

## Engine
- The engine core (`core.rs` and the modules it calls) is pure: no I/O, no wall-clock reads. "Now" is the latest market-data timestamp. This keeps replay deterministic.
- stdout carries only protocol events, one JSON line each. All logs go to stderr through `tracing`.
- TLS uses `rustls` with the `ring` crypto provider. Do not enable `aws-lc-rs` (it needs CMake/NASM on the local `x86_64-pc-windows-gnu` toolchain).

## TUI
- Always restore the terminal (raw mode, alternate screen, mouse capture) on exit and in the panic hook.
- Redraw at most 30 times per second, and only when state changed.
- Rebuild the hit map on every frame during draw.

## Protocol crate
- It is the single source of truth for message types. ts-rs exports TypeScript to `shared/protocol/`. Regenerate after any change to message types.

## Checks
`cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace` must pass (all run by `bun run check`). Run commands with `--manifest-path rust/Cargo.toml` from the repo root.
