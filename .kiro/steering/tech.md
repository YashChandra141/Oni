# Tech Stack and Conventions

## Standing rule: ask before every command
The user must approve every shell or terminal command (cargo, bun, git, rustup, docker, npm, etc.) before it runs. State the exact command, the working directory, and why it's needed, then wait. Creating and editing files does not need approval. Never run destructive commands. Never commit secrets.

## Stack
| Part | Choice |
|---|---|
| Rust | Cargo workspace in `rust/` (crates `protocol`, `engine`, `tui`), Rust 1.94, edition 2024 |
| Server | Bun 1.4.4, Hono, `Bun.serve` WebSockets, `Bun.spawn`, Zod, Prisma ORM 7 (@prisma/adapter-neon; @prisma/adapter-pg for plain Postgres) on Neon Postgres for the journal, `bun test` + fast-check |
| Web | Next.js 16 App Router as a static export (`output: 'export'`), TypeScript, Tailwind, zustand, TradingView Lightweight Charts |
| Auth | Sign In With Solana (SIWS) messages; Ed25519 verification with WebCrypto (`crypto.subtle`, Ed25519) in Bun, falling back to exact-pinned `@noble/curves` only if Bun's WebCrypto lacks Ed25519; base58 with `@scure/base`; stateless HMAC-SHA256 Session_Tokens signed with `SESSION_SECRET` (24 h, jti, in-memory logout denylist) |
| Wallets (web) | `@wallet-standard/app` (`getWallets()`) with `@wallet-standard/features` and `@solana/wallet-standard-features`, not `@solana/wallet-adapter-react`: no transactions are ever sent, so no `@solana/web3.js` connection is needed. Phantom and Backpack only |
| TUI auth | Device-code pairing over `POST /auth/pair` and `/auth/pair/poll`; `reqwest` (rustls, ring); token file in `dirs::config_dir()/haunted-terminal/session.json`, mode 0600 on Unix |
| Agents | `@modelcontextprotocol/sdk` (MCP), OpenAI structured output for plain-English orders |
| Deploy | Render Blueprint (`render.yaml`), Dockerfile `rust:1.94-bookworm` → `oven/bun:1.4.4-debian` |

## Layout
```
rust/crates/{protocol,engine,tui}   server/   web/   shared/{protocol,keymap.json}   fixtures/
```
Root `package.json` declares Bun workspaces `server`, `web`, `shared`.

## Commands
- `bun run check`: everything (cargo fmt check, clippy `-D warnings`, cargo test, tsc, bun test). Must pass before a task is marked done.
- `bun run gen:protocol`: regenerate `shared/protocol/*.ts` from the Rust protocol crate (added in Task 2).
- `bun run db:generate`: run `prisma generate` to build the Prisma Client into `server/src/generated/prisma/` (needs no database). `bun run check` runs it before `tsc`.
- `bunx prisma migrate dev` (in `server/`): create and apply a new Migration against a development database through `DIRECT_URL`. Development only, and the user approves each run.

## TypeScript conventions
- Prefer Bun APIs (`Bun.serve`, `Bun.spawn`, `Bun.file`, `bun:test`) over Node equivalents.
- Validate every external input with Zod at the boundary: env vars, WebSocket messages, engine stdout lines, LLM output, MCP tool arguments, REST params.
- Protocol types come from `shared/protocol/` (generated). Never hand-edit those files.
- `Price`, `Qty`, and `Money` arrive as decimal strings. Convert with `BigInt`, never `Number` or `parseFloat`.
- Pin exact dependency versions (`bun add --exact`). Commit `bun.lock`.
- Pin all Prisma packages (`prisma`, `@prisma/client`, `@prisma/adapter-neon`, `@prisma/adapter-pg`) to the same exact 7.x version. npm `latest` points at a Prisma 8 prerelease. Run `bun run db:generate` after schema changes; never hand-edit `server/src/generated/`.
- Strict TS (`strict`, `noUncheckedIndexedAccess`). No `any` except at a validated boundary.

## Wire protocol
- Engine ↔ server: one JSON object per line on stdin/stdout. Engine logs go to stderr only.
- Client ↔ server: JSON messages over WebSocket at `/ws`, typed by `ClientMessage` / `ServerMessage`.
- Messages are internally tagged with a snake_case `type` field.
- Protocol v2: order Commands (`PlaceOrder`, `Cancel`, `CancelAll`, `ResetAccount`) and account Events (`OrderAck`, `OrderRejected`, `Fill`, `Position`) carry `account_id` (`guest` or `w_<base58 address>`, 1..=64 chars of `[A-Za-z0-9_]`). Clients authenticate with `ClientMessage::Authenticate { token }` after connect, since browsers can't set WebSocket headers; the server answers `ServerMessage::Session { account_id, address }`. REST calls use `Authorization: Bearer <token>`.
- Account events go to the Bun topic `account:<account_id>`; notices go to `notices`.

## Market data endpoints (public only)
- Coinbase: public market-data WebSocket and REST (exact endpoints confirmed in Task 7.1).
- Backpack: WebSocket `wss://ws.backpack.exchange`, subscribe with `{"method":"SUBSCRIBE","params":["trade.SOL_USDC","depth.SOL_USDC"]}`, messages arrive as `{"stream": "...", "data": {...}}`. REST under `https://api.backpack.exchange` (markets, depth, klines, trades). Field names and the kline endpoint are verified against https://docs.backpack.exchange/ in Task 7.1.
- Internal symbols stay `BTC-USD`, `ETH-USD`, `SOL-USD`; `feed/venue.rs` maps them to venue symbols. Internal decimals are fixed (2 price, 8 qty); venue values that don't fit exactly are dropped and counted, never rounded.

## Testing
- Property-based tests for every "FOR ALL" acceptance criterion: proptest in Rust, fast-check in TS. The property table is in `design.md`.
- Keep the engine core and the server's risk/parser modules pure so they can be tested without I/O.
- Journal tests use the in-memory `JournalStore`. Postgres tests run only when `TEST_DATABASE_URL` is set, so `bun run check` needs no database.
- Auth stores (nonces, tokens, pairings, rate limits) are pure with an injectable clock. Tests use generated keypairs, a fake Wallet Standard wallet, and mock WS/HTTP servers; they never contact Backpack, Coinbase, a Solana RPC, or a real wallet.
