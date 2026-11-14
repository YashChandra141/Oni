# Requirements Document

## Introduction

Haunted Terminal is a crypto paper-trading terminal for fast order entry, built for the Kiroween 2026 hackathon (Frankenstein category). The submission deadline is December 4, 2026, 2:00 PM PT, with an internal target of December 3, 2026.

The system has four parts:

- A Rust Cargo workspace under `rust/crates/` with three crates: `protocol` (shared Command and Event message types, with TypeScript types generated into `shared/protocol/`), `engine` (a native sidecar process that handles market data, the order book, candles, indicators, the paper matcher, and P&L), and `tui` (a Ratatui terminal client).
- A Bun server under `server/` that supervises the engine, exposes WebSocket and REST endpoints, and owns order routing, risk checks, the journal, the command parser, the plain-English order parser, and the MCP server.
- A Next.js static-export web UI under `web/`.
- Deployment, release, CI, and repository assets for Render, GitHub Actions, and the hackathon submission.

The Server stores its journal of orders, fills, and rejections in a Postgres database hosted on Neon, accessed through Prisma ORM 7.

All trading is paper trading against simulated accounts. The Matcher fills paper orders against live public market data (Coinbase or Backpack) or replayed Fixtures. The system places no real orders, handles no real money, requests no wallet transactions, and calls no authenticated exchange endpoint. Input in both user interfaces is mouse and keyboard only. The system uses no WASM and no gamepad or MIDI input.

Scope change (approved): each user who signs in with a Solana wallet (Phantom or Backpack, through Wallet Standard and Sign In With Solana) gets a separate Paper_Account keyed by the wallet address. Users without a wallet trade on one shared Guest_Account. The TUI signs in by pairing with the Web_UI through a short code. Live market data comes from either Coinbase or Backpack, chosen by LIVE_VENUE. Replay stays the default data mode. Requirements 43 to 49 hold the new behaviour, and Requirements 1, 5, 7, 14, 15, 16, 17, 18, 19, 20, 24, 33, 38, and 42 are amended for it.

## Glossary

- **Haunted_Terminal**: The complete system described in this document.
- **Protocol_Crate**: The Rust `protocol` crate that defines Command and Event message types and generates TypeScript types into `shared/protocol/`.
- **Command**: A message sent to the Engine. The Command variants are Subscribe, Unsubscribe, PlaceOrder, Cancel, CancelAll, StartReplay, ResetAccount, and Ping.
- **Event**: A message emitted by the Engine. The Event variants are Candle, Trade, Book, Indicators, OrderAck, OrderRejected, Fill, Position, Heartbeat, Error, and Pong.
- **Engine**: The Rust `engine` sidecar process spawned by the Server. The Engine reads Commands as JSON lines on stdin, writes Events as JSON lines on stdout, and writes logs to stderr.
- **Market_Feed**: The Engine component that receives market data, either from the public WebSocket feed and REST backfill of the Live_Venue (live mode) or from Fixture files (replay mode).
- **Recorder**: The `engine record` subcommand that captures live market data from a chosen Venue into Fixture files.
- **Venue**: A source of live public market data. The Venues are Coinbase and Backpack (Backpack Exchange).
- **Live_Venue**: The Venue that the Market_Feed uses in live mode, set by the LIVE_VENUE environment variable to `coinbase` or `backpack`, with `backpack` when LIVE_VENUE is unset.
- **Coinbase_Adapter**: The Market_Feed component that connects to the Coinbase public WebSocket and REST endpoints and normalizes their messages into market data messages.
- **Backpack_Adapter**: The Market_Feed component that connects to the Backpack public WebSocket at `wss://ws.backpack.exchange` and the Backpack public REST API at `https://api.backpack.exchange` and normalizes their messages into market data messages.
- **Venue_Symbol_Map**: The table that maps each internal symbol to the symbol of each Venue: BTC-USD, ETH-USD, and SOL-USD on Coinbase, and BTC_USDC, ETH_USDC, and SOL_USDC on Backpack, where USDC is treated as USD.
- **Fixture**: A JSON Lines file under `fixtures/*.jsonl` that holds recorded market data messages.
- **Instrument_Table**: The per-symbol definition of tick size and lot size for BTC-USD, ETH-USD, and SOL-USD.
- **Tick**: The smallest price increment of a symbol. Prices are stored as signed 64-bit integer counts of ticks.
- **Lot**: The smallest quantity increment of a symbol. Quantities are stored as signed 64-bit integer counts of lots.
- **Timeframe**: A candle interval. The supported Timeframes are 1m, 5m, 15m, 1h, and 1d, aligned to UTC boundaries.
- **Candle_Builder**: The Engine component that builds 1m candles from trades and aggregates them into higher Timeframes.
- **Order_Book**: The Engine component that maintains bid and ask price levels per symbol from snapshots and deltas.
- **Indicator_Engine**: The Engine component that computes EMA, SMA, VWAP, Bollinger Bands, RSI, and ATR incrementally.
- **Matcher**: The Engine component that simulates execution of market, limit, and stop orders against market data.
- **Paper_Account**: A simulated trading account in Engine memory, identified by an Account_Id. Each Paper_Account has its own open orders and Positions.
- **Account_Id**: The identifier of a Paper_Account: `guest` for the Guest_Account, or `w_` followed by the base58 Wallet_Address for a Wallet_Account. An Account_Id is 1 to 64 characters from the set A–Z, a–z, 0–9, and underscore.
- **Guest_Account**: The Paper_Account with Account_Id `guest`, shared by every connection and caller that has no valid Session_Token.
- **Wallet_Account**: The Paper_Account of one signed-in wallet, with Account_Id `w_<Wallet_Address>`.
- **Position**: The signed quantity, average entry price, realized P&L, and unrealized P&L of one Paper_Account for one symbol.
- **Server**: The Bun 1.4.4 server under `server/` that uses Hono and Bun.serve.
- **Engine_Supervisor**: The Server component that spawns the Engine with Bun.spawn and restarts the Engine after an exit.
- **Router**: The Server component that receives every order request from every source and is the only path through which order Commands reach the Engine.
- **Risk_Engine**: The Server component that approves or rejects each order request against the configured risk limits.
- **Risk_Limits**: The configured values for maximum order value, maximum position per symbol, maximum open orders, price band width around the last trade price, and per-client order rate.
- **Kill_Switch**: The Server setting, controlled by the KILL_SWITCH environment variable, that makes the Risk_Engine reject every order request.
- **Journal**: The Postgres database at DATABASE_URL, hosted on Neon Postgres in production and accessed by the Server through the Prisma_Client (Prisma ORM 7), that stores orders, fills, and rejections.
- **Prisma_Client**: The Prisma ORM 7 database client that `prisma generate` produces from `server/prisma/schema.prisma` into `server/src/generated/prisma/`, used with a driver adapter.
- **Journal_Queue**: The bounded in-memory queue in the Server that holds Journal records until the Journal_Writer stores them.
- **Journal_Writer**: The Server background task that takes records from the Journal_Queue, writes them to the Journal in batches, and retries failed writes.
- **Journal_Status**: The Server's in-memory record of whether the Journal is reachable, with the value `up` or `down`. The value is `up` when the Server starts after the Migrations succeed. The value is `down` when the Server starts after the Migrations fail, until the Migrations succeed, and after any Journal operation that fails to reach the database, until the next Journal operation succeeds.
- **Migration**: A Prisma Migrate migration: a directory under `server/prisma/migrations/` with a committed `migration.sql` file that changes the Journal schema.
- **Start_Script**: The `server/scripts/start.ts` script that the Server_Image runs as its command. The Start_Script validates the configuration, applies pending Migrations with `prisma migrate deploy`, and then starts the Server in the same process.
- **Session_Id**: A random identifier that the Server generates each time the Engine starts and attaches to every Journal record created while that Engine process runs. A Session_Id identifies an Engine run, not a signed-in user; see Session_Token.
- **Wallet**: A Solana browser wallet that implements Wallet Standard. The supported Wallets are Phantom and Backpack.
- **Wallet_Address**: The base58 encoding of a Wallet's 32-byte Ed25519 public key.
- **SIWS_Message**: A Sign In With Solana message text with the fields domain, address, statement, URI, version, chain ID, nonce, issued-at time, and expiration time, in the line format of the Sign In With Solana specification.
- **Sign_In_Statement**: The fixed SIWS_Message statement `Sign in to Haunted Terminal paper trading. This signature does not authorize any transaction.`
- **SIWS_Parser**: The Server component that parses SIWS_Message text into its fields.
- **SIWS_Formatter**: The Server component that formats SIWS_Message fields into SIWS_Message text.
- **Nonce**: A single-use random value that the Auth_Service issues for one sign-in attempt and that expires 5 minutes after issue.
- **Auth_Service**: The Server component that issues Nonces, verifies signed SIWS_Messages, issues and verifies Session_Tokens, keeps the Token_Denylist, and runs Pairings.
- **Session_Token**: A bearer token issued by the Auth_Service after a verified sign-in: a payload with the Wallet_Address, an expiry time 24 hours after issue, and a unique token identifier (jti), signed with HMAC-SHA256 under SESSION_SECRET.
- **Token_Denylist**: The Auth_Service's in-memory set of the jti values of signed-out Session_Tokens, each kept until the token's expiry time. The Token_Denylist is empty after each Server start.
- **Connection_Session**: The Server's record, per WebSocket connection, of the Account_Id and, for a Wallet_Account, the Wallet_Address, jti, and expiry time of the Session_Token that the connection authenticated with.
- **Pairing**: A Server record that links a TUI that has no Session_Token to a sign-in completed in the Web_UI. A Pairing holds a Pairing_Code, the SHA-256 hash of a Pairing_Secret, an expiry time 5 minutes after creation, and, after confirmation, the Wallet_Address.
- **Pairing_Code**: An 8-character code from the alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0, 1, I, L, or O) that identifies one Pairing.
- **Pairing_Secret**: 32 random bytes generated by the TUI for one Pairing and kept by the TUI until the Pairing ends.
- **Token_Store**: The TUI file in the operating system's per-user configuration directory that holds the TUI's Session_Token.
- **Command_Parser**: The Server component that parses command bar text, such as `BUY BTC 0.1 LMT 64000`, into an Order_Preview.
- **Command_Formatter**: The Server component that formats a parsed command back into canonical command bar text.
- **Order_Preview**: A description of a proposed order or order action that a client displays and that the user confirms or discards before the Router receives the order.
- **LLM_Provider**: The Server interface for converting plain-English text into a structured order request. The first implementation uses OpenAI structured output.
- **LLM_Order_Parser**: The Server component that sends `?`-prefixed command bar text to the LLM_Provider and validates the result with Zod.
- **MCP_Server**: The Server component built with @modelcontextprotocol/sdk that exposes the tools get_quote, get_candles, get_positions, preview_order, and place_paper_order.
- **Client**: Either the Web_UI or the TUI.
- **Client_Message**: A message sent by a Client or the MCP_Server to the Server over WebSocket. The Client_Message variants are Subscribe, Unsubscribe, CommandText, Confirm, Discard, Cancel, CancelAll, FlattenAll, ResetAccount, Authenticate, and Ping.
- **Server_Message**: A message sent by the Server to a Client or the MCP_Server over WebSocket. The Server_Message variants are Hello, Event, Preview, ParseError, Notice, Session, and Pong.
- **Web_UI**: The Next.js 16 App Router client under `web/`, built as a static export.
- **TUI**: The Rust `tui` crate, a Ratatui and crossterm terminal client.
- **CandleChart_Widget**: The custom TUI widget that draws candles with Unicode block characters and indicator lines with braille characters.
- **Hit_Map**: The TUI map of panel rectangles recorded at draw time and used to resolve mouse events to panels and items.
- **Keymap**: The shared key binding file at `shared/keymap.json`.
- **Command_Bar**: The text input in each Client for command bar commands and `?`-prefixed plain-English orders.
- **Render_Blueprint**: The `render.yaml` file that defines the Render services.
- **Server_Image**: The Docker image built from the repository Dockerfile that contains the Server and the Engine.
- **Release_Workflow**: The GitHub Actions workflow `release.yml` that builds release binaries.
- **CI_Workflow**: The GitHub Actions workflow `ci.yml` that runs tests and checks.
- **Repository**: The public GitHub repository for Haunted Terminal.

## Requirements

### Protocol

### Requirement 1: Message Types

**User Story:** As a developer, I want one shared definition of every Command and Event, so that the Engine, Server, and Clients agree on message shapes.

#### Acceptance Criteria

1. THE Protocol_Crate SHALL define the Command variants Subscribe, Unsubscribe, PlaceOrder, Cancel, CancelAll, StartReplay, ResetAccount, and Ping.
2. THE Protocol_Crate SHALL define the Event variants Candle, Trade, Book, Indicators, OrderAck, OrderRejected, Fill, Position, Heartbeat, Error, and Pong.
3. THE Protocol_Crate SHALL generate TypeScript type definitions for every Command, Event, Client_Message, and Server_Message into `shared/protocol/` using ts-rs.
4. THE Protocol_Crate SHALL represent every price as an i64 count of Ticks and every quantity as an i64 count of Lots.
5. THE Protocol_Crate SHALL use floating-point fields only for indicator values.
6. WHEN the Engine receives a Ping Command, THE Engine SHALL emit a Pong Event that carries the identifier from the Ping Command.
7. THE Protocol_Crate SHALL define the Client_Message variants Subscribe, Unsubscribe, CommandText, Confirm, Discard, Cancel, CancelAll, FlattenAll, ResetAccount, Authenticate, and Ping, where Authenticate carries a Session_Token.
8. THE Protocol_Crate SHALL define the Server_Message variants Hello, Event, Preview, ParseError, Notice, Session, and Pong, where Session carries the Account_Id of the connection and the Wallet_Address or null.
9. THE Protocol_Crate SHALL include an Account_Id field in the PlaceOrder, Cancel, CancelAll, and ResetAccount Commands and in the OrderAck, OrderRejected, Fill, and Position Events.
10. THE Protocol_Crate SHALL accept as an Account_Id only a string of 1 to 64 characters from the set A–Z, a–z, 0–9, and underscore.
11. THE Protocol_Crate SHALL include the data mode and, in live mode, the Live_Venue in the Hello Server_Message.

### Requirement 2: Message Serialization

**User Story:** As a developer, I want messages to serialize to and from JSON without loss, so that every process boundary carries exact data.

#### Acceptance Criteria

1. THE Protocol_Crate SHALL serialize each Command and each Event as a single-line JSON object.
2. THE Protocol_Crate SHALL parse single-line JSON objects into Commands and Events.
3. FOR ALL valid Commands and Events, serializing to JSON and then parsing SHALL produce a message equal to the original (round-trip property).
4. IF the Engine receives an input line that is not valid JSON or does not match a Command variant, THEN THE Engine SHALL emit an Error Event that describes the problem and continue processing subsequent input lines.
5. IF a Command contains a field value outside the valid range for that field, THEN THE Engine SHALL emit an Error Event and continue processing subsequent input lines.

### Engine: Process and Market Data

### Requirement 3: Engine Process Interface

**User Story:** As a server developer, I want the Engine to speak JSON lines over standard streams, so that the Server can supervise the Engine as a child process.

#### Acceptance Criteria

1. THE Engine SHALL read Commands as JSON lines from stdin.
2. THE Engine SHALL write Events as JSON lines to stdout.
3. THE Engine SHALL write log output to stderr using tracing.
4. WHILE the Engine is running, THE Engine SHALL emit a Heartbeat Event once per second.
5. WHEN stdin reaches end of file, THE Engine SHALL exit with status code 0.

### Requirement 4: Instruments

**User Story:** As a trader, I want each symbol to use its own tick and lot sizes, so that prices and quantities match the market's increments.

#### Acceptance Criteria

1. THE Instrument_Table SHALL define a tick size and a lot size for each of BTC-USD, ETH-USD, and SOL-USD.
2. IF a Command references a symbol that is absent from the Instrument_Table, THEN THE Engine SHALL emit an Error Event that names the unknown symbol.
3. WHEN the Command_Parser converts a decimal price or quantity into Ticks or Lots, THE Command_Parser SHALL use the tick size and lot size of the command's symbol.
4. IF a decimal price is not a whole multiple of the symbol's tick size, or a decimal quantity is not a whole multiple of the symbol's lot size, THEN THE Command_Parser SHALL return a parse error that names the offending value.

### Requirement 5: Live Market Data (Coinbase)

**User Story:** As a trader, I want live crypto market data from Coinbase, so that I can practice against real prices.

#### Acceptance Criteria

1. WHERE DATA_MODE is set to live and the Live_Venue is Coinbase, THE Coinbase_Adapter SHALL subscribe to the Coinbase public WebSocket feed for BTC-USD, ETH-USD, and SOL-USD trades and order book updates.
2. WHERE DATA_MODE is set to live and the Live_Venue is Coinbase, WHEN a Client subscribes to a symbol, THE Coinbase_Adapter SHALL backfill candle history from the Coinbase public REST API.
3. THE Market_Feed SHALL use only public, unauthenticated Coinbase and Backpack endpoints.
4. THE Market_Feed SHALL establish TLS connections with rustls using the `ring` crypto provider.
5. IF the Coinbase WebSocket connection closes or fails, THEN THE Coinbase_Adapter SHALL emit an Error Event and reconnect with exponential backoff.

### Requirement 6: Replay Mode

**User Story:** As a hackathon judge, I want the terminal to run on recorded data without API keys, so that I can try the system immediately and see the same results every time.

#### Acceptance Criteria

1. WHERE DATA_MODE is unset or set to replay, THE Market_Feed SHALL read market data from Fixture files in `fixtures/`.
2. THE Market_Feed SHALL operate in replay mode without any API key or credential.
3. WHEN the Engine receives a StartReplay Command with a speed between 1 and 50 inclusive, THE Market_Feed SHALL replay the Fixture with inter-message delays equal to the recorded delays divided by the speed.
4. IF a StartReplay Command specifies a speed below 1 or above 50, THEN THE Engine SHALL emit an Error Event and keep the current replay state.
5. IF a StartReplay Command names a Fixture that does not exist or cannot be parsed, THEN THE Engine SHALL emit an Error Event that names the Fixture.
6. FOR ALL Fixtures and replay speeds, replaying the same Fixture with the same Commands SHALL produce the same sequence of Candle, Trade, Book, Indicators, OrderAck, OrderRejected, Fill, and Position Events, excluding wall-clock timestamps (determinism property).

### Requirement 7: Recording Fixtures

**User Story:** As a developer, I want to record live market data into Fixtures, so that replay mode has realistic data.

#### Acceptance Criteria

1. WHEN the `engine record` subcommand runs with a Venue argument of `coinbase` or `backpack`, THE Recorder SHALL write the public feed messages it receives from that Venue for the requested symbols, normalized to market data messages with internal symbols, to a Fixture file, one message per line, with the receive time of each message.
2. THE Market_Feed SHALL parse each Fixture line written by the Recorder into a market data message.
3. FOR ALL recorded market data messages, writing the message as a Fixture line and then parsing that line SHALL produce a message equal to the original (round-trip property).

### Engine: Candles, Order Book, Indicators

### Requirement 8: Candle Building

**User Story:** As a trader, I want candles built from trades at every Timeframe, so that I can read price action at different scales.

#### Acceptance Criteria

1. WHEN the Candle_Builder receives a Trade, THE Candle_Builder SHALL update the 1m candle whose interval contains the trade time.
2. THE Candle_Builder SHALL set each candle's open to the first trade price, close to the last trade price, high to the maximum trade price, and low to the minimum trade price within the candle interval.
3. THE Candle_Builder SHALL aggregate 1m candles into 5m, 15m, 1h, and 1d candles aligned to UTC interval boundaries.
4. FOR ALL trade sequences, every candle SHALL satisfy low ≤ open ≤ high and low ≤ close ≤ high (invariant).
5. FOR ALL trade sequences, the volume of each candle SHALL equal the sum of the quantities of the trades within the candle interval (invariant).
6. FOR ALL trade sequences and Timeframes above 1m, candles aggregated from 1m candles SHALL equal candles built directly from the same trades at that Timeframe (model-based property).
7. WHEN a Client subscribes to a symbol and Timeframe, THE Engine SHALL send a history snapshot of up to 500 of the most recent candles for that symbol and Timeframe before any live Candle Event for that subscription.
8. WHILE a subscription is active, THE Engine SHALL emit a Candle Event each time the current candle for the subscribed symbol and Timeframe changes.

### Requirement 9: Order Book

**User Story:** As a trader, I want an accurate order book with spread and imbalance, so that I can judge liquidity before I trade.

#### Acceptance Criteria

1. WHEN the Order_Book receives a snapshot for a symbol, THE Order_Book SHALL replace all price levels for that symbol with the snapshot levels.
2. WHEN the Order_Book receives a delta with a non-zero quantity, THE Order_Book SHALL set the quantity of the delta's price level to the delta quantity.
3. WHEN the Order_Book receives a delta with a zero quantity, THE Order_Book SHALL remove the delta's price level.
4. IF the Order_Book receives a delta with a negative quantity, THEN THE Order_Book SHALL discard the delta and emit an Error Event.
5. IF a delta would make the best bid greater than or equal to the best ask, THEN THE Order_Book SHALL remove the opposite-side levels crossed by the delta's price.
6. THE Order_Book SHALL emit Book Events that contain the top N levels per side, the spread, and the imbalance, where N is a fixed Engine constant.
7. THE Order_Book SHALL emit at most one Book Event per symbol in each 100 ms interval.
8. WHEN the Market_Feed receives a trade, THE Engine SHALL emit a Trade Event with the symbol, price, quantity, aggressor side, and trade time.
9. FOR ALL snapshot and delta sequences, every level quantity in the Order_Book SHALL be greater than zero (invariant).
10. FOR ALL snapshot and delta sequences, WHILE both sides of the Order_Book are non-empty, the best bid SHALL be less than the best ask (invariant).
11. FOR ALL snapshot and delta sequences, applying a snapshot followed by deltas SHALL produce the same Order_Book as applying a snapshot that contains the final levels (model-based property).

### Requirement 10: Indicators

**User Story:** As a trader, I want common indicators computed in the Engine, so that both Clients show the same values.

#### Acceptance Criteria

1. THE Indicator_Engine SHALL compute EMA, SMA, VWAP, Bollinger Bands, RSI, and ATR incrementally as each candle updates.
2. WHEN a candle updates for a subscribed symbol and Timeframe, THE Engine SHALL emit an Indicators Event with the current indicator values for that symbol and Timeframe.
3. FOR ALL input price sequences, every EMA value SHALL lie between the minimum and the maximum of the input prices seen so far (invariant).
4. FOR ALL input price sequences, every RSI value SHALL lie within [0, 100] (invariant).
5. FOR ALL input price sequences, every SMA value SHALL equal the arithmetic mean of the most recent window of input prices, computed non-incrementally (model-based property).

### Engine: Paper Trading

### Requirement 11: Order Types

**User Story:** As a trader, I want market, limit, and stop orders, so that I can practice the order types I use.

#### Acceptance Criteria

1. WHEN the Matcher receives a market order, THE Matcher SHALL fill the order against the opposite side of the Order_Book starting at the best price level.
2. WHEN the Matcher receives a limit buy order, THE Matcher SHALL fill the order only at prices less than or equal to the limit price.
3. WHEN the Matcher receives a limit sell order, THE Matcher SHALL fill the order only at prices greater than or equal to the limit price.
4. WHILE a limit order has remaining quantity, THE Matcher SHALL keep the order open until the order fills completely or is canceled.
5. WHEN the last trade price reaches or crosses a stop order's stop price, THE Matcher SHALL convert the stop order to a market order.
6. WHEN the Matcher accepts an order, THE Engine SHALL emit an OrderAck Event with the order identifier.
7. WHEN the Engine receives a Cancel Command for an open order, THE Matcher SHALL remove the order and THE Engine SHALL emit an OrderAck Event with status canceled.
8. WHEN the Engine receives a CancelAll Command, THE Matcher SHALL remove every open order and THE Engine SHALL emit an OrderAck Event with status canceled for each removed order.
9. IF the Engine receives a Cancel Command for an order identifier that is not open, THEN THE Engine SHALL emit an OrderRejected Event that names the order identifier.
10. FOR ALL market data sequences and limit buy orders, every fill price SHALL be less than or equal to the limit price, and for all limit sell orders every fill price SHALL be greater than or equal to the limit price (invariant).

### Requirement 12: Fills, Slippage, and Fees

**User Story:** As a trader, I want realistic fills with slippage and fees, so that paper results resemble real trading.

#### Acceptance Criteria

1. IF the available quantity at acceptable prices is less than an order's remaining quantity, THEN THE Matcher SHALL fill the available quantity and keep the remainder open as a partial fill.
2. WHEN a market order consumes more than one price level, THE Matcher SHALL fill each portion at the price of the level that supplied the portion.
3. THE Matcher SHALL charge a fee on each fill equal to the fill notional multiplied by the configured fee rate.
4. WHEN the Matcher fills all or part of an order, THE Engine SHALL emit a Fill Event with the order identifier, fill price, fill quantity, fee, and remaining quantity.
5. FOR ALL orders and market data sequences, the order's filled quantity plus remaining quantity SHALL equal the order's original quantity (invariant).
6. FOR ALL market data sequences and order sequences, processing the same inputs twice SHALL produce identical Fill Events (determinism property).
7. THE Matcher SHALL settle every fill against the Paper_Account only.

### Requirement 13: Positions and P&L

**User Story:** As a trader, I want accurate positions and P&L, so that I can measure my paper performance.

#### Acceptance Criteria

1. WHEN a fill increases the size of a Position, THE Engine SHALL set the Position's average entry price to the quantity-weighted average of the previous entry price and the fill price.
2. WHEN a fill reduces the size of a Position, THE Engine SHALL add (fill price − average entry price) × reduced quantity × position direction, minus the fill fee, to the Position's realized P&L.
3. WHEN the last trade price of a symbol changes, THE Engine SHALL set the Position's unrealized P&L to (last trade price − average entry price) × signed position quantity.
4. WHEN a Position changes, THE Engine SHALL emit a Position Event with the symbol, signed quantity, average entry price, realized P&L, and unrealized P&L.
5. FOR ALL prices and quantities, a buy of quantity q at price b followed by a sell of quantity q at price s SHALL leave a flat Position with realized P&L equal to (s − b) × q − total fees (round-trip property).

### Requirement 14: Paper Accounts and Account Reset

**User Story:** As a trader, I want my own paper account when I sign in with my wallet, and a guest account when I don't, so that my results are mine and judges can try the app without a wallet.

#### Acceptance Criteria

1. THE Engine SHALL keep a separate Paper_Account for each Account_Id, with its own open orders and Positions, while the order book and all other market data stay shared by every Paper_Account.
2. THE Haunted_Terminal SHALL provide the Guest_Account without sign-in to every connection and caller that has no valid Session_Token.
3. WHEN the Engine receives a ResetAccount Command, THE Engine SHALL cancel all open orders of the Paper_Account named by the Command's Account_Id, set that Paper_Account's Positions to flat with zero realized and unrealized P&L, and emit a Position Event for each symbol with that Account_Id.
4. WHEN the Engine receives a PlaceOrder Command for an Account_Id that has no Paper_Account, THE Engine SHALL create a flat Paper_Account for that Account_Id before processing the order.
5. IF the Engine receives a PlaceOrder Command for an Account_Id that has no Paper_Account while the Engine holds 1,000 Paper_Accounts, THEN THE Engine SHALL emit an OrderRejected Event with the reason account_limit and create no Paper_Account.
6. IF the Engine receives a Cancel Command for an order identifier that is open in a Paper_Account other than the Command's Account_Id, THEN THE Engine SHALL emit an OrderRejected Event that names the order identifier and leave the order open.
7. WHEN the Engine receives a CancelAll Command, THE Matcher SHALL remove only the open orders of the Paper_Account named by the Command's Account_Id.
8. THE Matcher SHALL leave the shared Order_Book unchanged when the Matcher fills a paper order.
9. FOR ALL interleaved sequences of market data and order Commands across several Account_Ids, the OrderAck, OrderRejected, Fill, and Position Events of each Account_Id SHALL equal the Events produced by running that Account_Id's Commands alone against the same market data (account isolation property).

### Server

### Requirement 15: Engine Supervision

**User Story:** As an operator, I want the Server to restart a failed Engine, so that the terminal recovers without manual action.

#### Acceptance Criteria

1. WHEN the Server starts, THE Engine_Supervisor SHALL spawn the Engine from ENGINE_PATH with Bun.spawn.
2. WHEN the Engine exits, THE Engine_Supervisor SHALL restart the Engine after a delay that starts at 500 ms and doubles after each consecutive exit, up to a maximum of 30 seconds.
3. WHEN the Engine has run for 60 seconds without exiting, THE Engine_Supervisor SHALL reset the restart delay to 500 ms.
4. WHEN the Engine restarts, THE Server SHALL resend every active Client subscription to the Engine.
5. WHILE the Engine is not running, THE Router SHALL reject order requests with the reason engine_unavailable.
6. THE Server SHALL forward Engine stderr output to the Server log.
7. WHEN the Engine restarts, THE Server SHALL clear its cached Positions and open orders of every Paper_Account and send an account reset notice to every connected Client.
8. THE Server SHALL NOT restore the state of any Paper_Account from the Journal after an Engine restart.

### Requirement 16: Configuration and Secrets

**User Story:** As an operator, I want all configuration in environment variables, so that I can deploy the Server without code changes and keep secrets out of the Repository.

#### Acceptance Criteria

1. THE Server SHALL read configuration from the environment variables PORT, ENGINE_PATH, DATA_MODE, LIVE_VENUE, ALLOWED_ORIGINS, WEB_URL, DATABASE_URL, DIRECT_URL, DB_ADAPTER, KILL_SWITCH, OPENAI_API_KEY, SESSION_SECRET, and NODE_ENV.
2. IF an environment variable holds a value that fails Zod validation, THEN THE Server SHALL log the variable name and exit with a non-zero status code.
3. THE Server SHALL read secrets only from environment variables.
4. THE Server SHALL exclude the values of OPENAI_API_KEY, DATABASE_URL, DIRECT_URL, and SESSION_SECRET, including the passwords inside DATABASE_URL and DIRECT_URL, and every Session_Token and Pairing_Secret, from all log output and all responses other than the response that issues the Session_Token.
5. WHERE NODE_ENV is set to production, IF DATABASE_URL or DIRECT_URL is unset, THEN THE Server SHALL log the name of each unset variable and exit with a non-zero status code.
6. WHERE NODE_ENV is not set to production, IF DATABASE_URL is unset, THEN THE Server SHALL keep Journal records in memory only and log a warning that the Journal is not persisted.
7. WHERE NODE_ENV is set to production, IF SESSION_SECRET is unset or shorter than 32 bytes, THEN THE Server SHALL log the variable name and exit with a non-zero status code.
8. WHERE NODE_ENV is not set to production, IF SESSION_SECRET is unset, THEN THE Server SHALL generate a random 32-byte secret for the current process and log a warning that Session_Tokens will not survive a Server restart.
9. IF WEB_URL is set to an origin that is not listed in ALLOWED_ORIGINS, THEN THE Server SHALL log the variable name and exit with a non-zero status code.

### Requirement 17: WebSocket and Health Endpoints

**User Story:** As a Client developer, I want a WebSocket endpoint and a health endpoint, so that Clients can stream data and hosting can check liveness.

#### Acceptance Criteria

1. THE Server SHALL accept WebSocket connections at the path `/ws` using Bun.serve WebSockets.
2. IF a WebSocket upgrade request carries an Origin header that is not listed in ALLOWED_ORIGINS, THEN THE Server SHALL reject the upgrade with HTTP status 403.
3. WHEN the Server receives a message from a Client, THE Server SHALL validate the message with Zod before acting on the message.
4. IF a Client message fails validation, THEN THE Server SHALL send an Error Event to that Client and keep the connection open.
5. WHEN the Server receives a GET request at `/health`, THE Server SHALL respond with HTTP status 200 and a JSON body that reports whether the Engine is running and reports the Journal_Status in a `db` field with the value `up` or `down`.
6. WHEN the Engine emits a market data Event, THE Server SHALL forward the Event to every Client subscribed to the Event's symbol.
7. WHEN the Engine emits an OrderAck, Fill, or Position Event, THE Server SHALL forward the Event only to the connections whose Connection_Session holds the Event's Account_Id.
8. WHEN the Server answers a GET request at `/health`, THE Server SHALL read the Journal_Status from memory and send no query to the Journal.
9. WHEN the Server sends a Notice Server_Message about the Engine state or an account reset, THE Server SHALL send the Notice to every connected Client.
10. WHEN the Engine emits an OrderRejected Event, THE Server SHALL forward the Event to the connection that requested the order and, if that connection has closed, to the connections whose Connection_Session holds the Event's Account_Id.
11. FOR ALL sets of connections with Connection_Sessions and all sequences of OrderAck, Fill, and Position Events, each connection SHALL receive exactly the Events whose Account_Id equals the Account_Id of the connection's Connection_Session at delivery time (account routing property).

### Requirement 18: Single Order Path

**User Story:** As a safety-minded trader, I want every order to pass through one router and one risk check, so that no input source can bypass the limits.

#### Acceptance Criteria

1. THE Router SHALL receive every order request from the Web_UI, the TUI, the LLM_Order_Parser, and the MCP_Server.
2. WHEN the Router receives an order request, THE Router SHALL submit the request to the Risk_Engine before sending any Command to the Engine.
3. THE Server SHALL send PlaceOrder, Cancel, CancelAll, and ResetAccount Commands to the Engine only from the Router.
4. THE Engine SHALL accept Commands only from the stdin pipe opened by the Engine_Supervisor.
5. WHEN the Router sends a PlaceOrder, Cancel, CancelAll, or ResetAccount Command, THE Router SHALL set the Command's Account_Id from the Connection_Session of the requesting connection, or to `guest` for a request without a Connection_Session, and from no field supplied by the Client.
6. FOR ALL Connection_Sessions and Client_Message sequences, including messages that carry extra account fields, every order Command that the Router sends SHALL carry the Account_Id of the requesting connection's Connection_Session (account derivation property).

### Requirement 19: Risk Engine

**User Story:** As a safety-minded trader, I want pre-trade risk limits and a kill switch, so that mistakes are blocked before they reach the Matcher.

#### Acceptance Criteria

1. IF an order's value exceeds the maximum order value in the Risk_Limits, THEN THE Risk_Engine SHALL reject the order with the reason max_order_value.
2. IF an order would make the absolute Position for its symbol in the order's Paper_Account exceed the maximum position in the Risk_Limits, THEN THE Risk_Engine SHALL reject the order with the reason max_position.
3. IF an order would make the number of open orders in the order's Paper_Account exceed the maximum open orders in the Risk_Limits, THEN THE Risk_Engine SHALL reject the order with the reason max_open_orders.
4. IF a limit or stop order's price lies outside the price band around the symbol's last trade price in the Risk_Limits, THEN THE Risk_Engine SHALL reject the order with the reason price_band.
5. IF a WebSocket connection exceeds the per-client order rate in the Risk_Limits, THEN THE Risk_Engine SHALL reject the order with the reason rate_limit.
6. WHILE the Kill_Switch is enabled, THE Risk_Engine SHALL reject every order request with the reason kill_switch.
7. WHEN the Risk_Engine rejects an order, THE Server SHALL send an OrderRejected Event with the rejection reason to the requesting source.
8. FOR ALL order requests and states of every Paper_Account, every order approved by the Risk_Engine SHALL satisfy every limit in the Risk_Limits, evaluated against the Paper_Account named by the order's Account_Id (invariant).
9. FOR ALL order requests, WHILE the Kill_Switch is enabled, the Risk_Engine SHALL approve zero orders (invariant).

### Requirement 20: Journal and REST Endpoints

**User Story:** As a trader, I want a persistent journal of orders, fills, and rejections, so that I can review the current session and earlier sessions.

#### Acceptance Criteria

1. WHEN the Router submits an order to the Engine, THE Journal SHALL store an order record, written asynchronously through the Journal_Queue.
2. WHEN the Engine emits a Fill Event, THE Journal SHALL store a fill record, written asynchronously through the Journal_Queue.
3. WHEN the Risk_Engine or the Engine rejects an order, THE Journal SHALL store a rejection record with the rejection reason, written asynchronously through the Journal_Queue.
4. THE Journal SHALL store data in the Postgres database at DATABASE_URL, accessed through the Prisma_Client.
5. WHEN the Server receives a GET request at `/orders`, THE Server SHALL respond with the journaled orders as JSON.
6. WHEN the Server receives a GET request at `/positions`, THE Server SHALL respond with the current Positions of the caller's Paper_Account, as defined in criterion 28, as JSON.
7. WHEN the Server receives a GET request at `/journal`, THE Server SHALL respond with the journaled orders, fills, and rejections as JSON in time order, with records that share a time ordered by insertion order.
8. WHEN the Router approves an order, THE Router SHALL send the PlaceOrder Command to the Engine without waiting for the Journal write of the order record to complete.
9. WHILE the Journal_Status is down, THE Router SHALL continue to submit order requests to the Risk_Engine and send approved orders to the Engine.
10. IF a Journal operation fails to reach the database, THEN THE Journal_Writer SHALL log the error, keep the unwritten records in the Journal_Queue, and retry after a delay that starts at 500 ms and doubles after each consecutive failure, up to a maximum of 30 seconds.
11. IF a record is enqueued while the Journal_Queue holds 10,000 records, THEN THE Journal_Queue SHALL drop the oldest queued record and THE Server SHALL log the number of dropped records.
12. FOR ALL sequences of Journal records and Journal write failures, after the database becomes reachable and the Journal_Queue drains, the Journal SHALL hold every enqueued record that the Journal_Queue did not drop exactly once, in enqueue order (model-based property).
13. WHILE the Journal_Status is down, WHEN the Server receives a GET request at `/orders` or `/journal`, THE Server SHALL respond with HTTP status 503.
14. IF the Journal query for a GET request at `/orders` or `/journal` fails to reach the database or takes longer than 5 seconds, THEN THE Server SHALL respond with HTTP status 503 and set the Journal_Status to down.
15. WHEN the Server_Image starts, THE Start_Script SHALL apply each pending Migration with `prisma migrate deploy` before the Start_Script starts the Server.
16. WHEN the Start_Script runs Prisma Migrate, THE Start_Script SHALL supply DIRECT_URL as the Prisma Migrate connection string.
17. IF applying the Migrations fails, THEN THE Start_Script SHALL log the error, start the Server with the Journal_Status down, and retry the Migrations in the background with the delays defined in criterion 10, and THE Journal_Writer SHALL keep records in the Journal_Queue until the Migrations succeed.
18. WHEN the Engine_Supervisor starts the Engine, THE Server SHALL generate a new Session_Id and attach the Session_Id to every Journal record created until the next Engine start.
19. WHEN the Server receives a GET request at `/orders` or `/journal` without a `session` query parameter, THE Server SHALL respond with only the records of the current Session_Id.
20. WHEN the Server receives a GET request at `/orders` or `/journal` with the query parameter `session=all`, THE Server SHALL respond with the records of every Session_Id.
21. IF the Server receives a GET request at `/orders` or `/journal` with a `session` query parameter whose value is not `all`, THEN THE Server SHALL respond with HTTP status 400.
22. THE Journal SHALL store each Price, Qty, and Money value and each record time as a Postgres BIGINT.
23. FOR ALL Journal records, writing the record to the Journal and then reading the record back SHALL produce a record equal to the original (round-trip property).
24. WHEN the Server receives a GET request at `/orders` or `/journal` with a `limit` query parameter that is an integer from 1 to 5000 inclusive, THE Server SHALL respond with the most recent records, at most `limit` of them, in the order defined in criterion 7.
25. WHEN the Server receives a GET request at `/orders` or `/journal` without a `limit` query parameter, THE Server SHALL respond with the most recent records, at most 500 of them, in the order defined in criterion 7.
26. IF the Server receives a GET request at `/orders` or `/journal` with a `limit` query parameter that is not an integer from 1 to 5000 inclusive, THEN THE Server SHALL respond with HTTP status 400.
27. THE Journal SHALL store the Account_Id with every order, fill, and rejection record.
28. WHEN the Server receives a GET request at `/positions`, `/orders`, or `/journal`, THE Server SHALL use as the caller's Paper_Account the Wallet_Account of a valid Session_Token given in an `Authorization: Bearer` header, or the Guest_Account when the request has no Authorization header.
29. IF a GET request at `/positions`, `/orders`, or `/journal` carries an Authorization header with a Session_Token that is invalid, expired, or in the Token_Denylist, THEN THE Server SHALL respond with HTTP status 401.
30. WHEN the Server receives a GET request at `/orders` or `/journal`, THE Server SHALL respond with only the records of the caller's Paper_Account, filtered further by the `session` query parameter as defined in criteria 19 and 20.
31. FOR ALL sets of Journal records across several Account_Ids and Session_Ids, listing the Journal for an Account_Id and a session filter SHALL return exactly the records with that Account_Id that match the session filter (account scoping property).

### Requirement 21: Command Parser

**User Story:** As a fast trader, I want typed commands such as `BUY BTC 0.1 LMT 64000`, so that I can enter orders without a mouse.

#### Acceptance Criteria

1. THE Command_Parser SHALL accept commands of the form `BUY|SELL <symbol> <quantity> [LMT <price> | STP <price>]`, `BUY|SELL <symbol> <percent>%`, `CANCEL ALL`, and `FLAT`, with case-insensitive keywords.
2. WHEN the Command_Parser receives a well-formed command, THE Command_Parser SHALL return an Order_Preview that describes the side, symbol, quantity in Lots, order type, and price in Ticks.
3. WHEN the Command_Parser receives a `<percent>%` quantity, THE Command_Parser SHALL compute the quantity as that percentage of the current Position size for the symbol, rounded down to a whole Lot.
4. WHEN the Command_Parser receives a short symbol such as BTC, THE Command_Parser SHALL resolve the symbol to the matching Instrument_Table symbol such as BTC-USD.
5. IF the Command_Parser receives a malformed command, THEN THE Command_Parser SHALL return a parse error that identifies the position of the first invalid token.
6. THE Command_Formatter SHALL format each parsed command as canonical command bar text.
7. FOR ALL well-formed commands, parsing SHALL return an Order_Preview (property).
8. FOR ALL malformed command strings, parsing SHALL return a parse error and zero order requests (property).
9. FOR ALL parsed commands, formatting and then parsing SHALL produce a command equal to the original (round-trip property).

### Requirement 22: Preview and Confirmation

**User Story:** As a safety-minded trader, I want to confirm every typed order before it is placed, so that typos do not become trades.

#### Acceptance Criteria

1. WHEN the Server returns an Order_Preview to a Client, THE Client SHALL display the Order_Preview with confirm and discard actions.
2. WHEN the user confirms an Order_Preview, THE Client SHALL send the confirmed order to the Router.
3. WHEN the user discards an Order_Preview, THE Client SHALL discard the Order_Preview and send no order request.
4. THE Router SHALL accept an order that originated from the Command_Bar only after the Client sends a confirmation that references the Order_Preview.

### Requirement 23: Plain-English Orders

**User Story:** As a trader, I want to type orders in plain English, so that I can describe an order without exact syntax.

#### Acceptance Criteria

1. WHEN the Command_Bar text starts with `?`, THE LLM_Order_Parser SHALL send the remaining text to the LLM_Provider.
2. WHEN the LLM_Provider returns a result, THE LLM_Order_Parser SHALL validate the result with a Zod schema.
3. WHEN the LLM_Provider result passes validation, THE LLM_Order_Parser SHALL return an Order_Preview through the same preview, confirmation, and risk path as the Command_Parser.
4. IF the LLM_Provider result fails validation, THEN THE LLM_Order_Parser SHALL return an error to the Client and create no Order_Preview.
5. IF the LLM_Provider returns no result within 15 seconds or returns an error, THEN THE LLM_Order_Parser SHALL return an error to the Client and create no Order_Preview.
6. THE LLM_Order_Parser SHALL produce Order_Previews only; order requests from plain-English input SHALL reach the Router only after user confirmation.
7. WHERE OPENAI_API_KEY is unset, THE Server SHALL disable the LLM_Order_Parser and respond to `?`-prefixed input with a message stating that plain-English orders are disabled.

### Requirement 24: MCP Server

**User Story:** As a Kiro user, I want MCP tools for quotes, candles, positions, and paper orders, so that an agent can query and trade the paper account.

#### Acceptance Criteria

1. THE MCP_Server SHALL expose the tools get_quote, get_candles, get_positions, preview_order, and place_paper_order.
2. WHEN get_quote is called with a symbol, THE MCP_Server SHALL return the best bid, best ask, and last trade price for the symbol.
3. WHEN get_candles is called with a symbol and Timeframe, THE MCP_Server SHALL return the recent candles for that symbol and Timeframe.
4. WHEN get_positions is called, THE MCP_Server SHALL return the current Positions of the MCP_Server's Paper_Account, as defined in criteria 9 and 10.
5. WHEN preview_order is called, THE MCP_Server SHALL return an Order_Preview and send no order request to the Router.
6. WHEN place_paper_order is called, THE MCP_Server SHALL submit the order to the Router, which applies the Risk_Engine check.
7. IF an MCP tool receives arguments that fail Zod validation, THEN THE MCP_Server SHALL return a tool error that describes the invalid arguments.
8. THE Repository SHALL register the MCP_Server in `.kiro/settings/mcp.json`.
9. WHERE the TERMINAL_TOKEN environment variable is set, THE MCP_Server SHALL send an Authenticate Client_Message with the TERMINAL_TOKEN value after each WebSocket connect and send the value as an `Authorization: Bearer` header on each REST request, so that the MCP_Server uses the Wallet_Account of that Session_Token.
10. WHERE the TERMINAL_TOKEN environment variable is unset, THE MCP_Server SHALL use the Guest_Account.
11. THE MCP_Server SHALL exclude the TERMINAL_TOKEN value from all log output and all tool results.

### Clients

### Requirement 25: Chart Display

**User Story:** As a trader, I want a candlestick chart with volume and timeframes in both Clients, so that I get the same view in the browser and the terminal.

#### Acceptance Criteria

1. THE Web_UI and THE TUI SHALL each display a candlestick chart for the selected symbol with volume bars.
2. THE Web_UI and THE TUI SHALL each provide the Timeframes 1m, 5m, 15m, 1h, and 1d.
3. WHEN the user clicks a Timeframe button or presses keys 1 through 5, THE Client SHALL switch the chart to the Timeframe at that position in the list 1m, 5m, 15m, 1h, 1d.
4. WHILE the pointer or the keyboard cursor is over the chart, THE Client SHALL display a crosshair with the price and time at the crosshair position.
5. THE Web_UI SHALL render the chart with TradingView Lightweight Charts loaded through next/dynamic with ssr set to false.

### Requirement 26: Indicator Display

**User Story:** As a trader, I want to toggle indicator overlays and sub-panes, so that I can show only the studies I need.

#### Acceptance Criteria

1. THE Web_UI and THE TUI SHALL each draw EMA, VWAP, and Bollinger Bands as overlays on the price chart.
2. THE Web_UI and THE TUI SHALL each draw RSI and ATR in a sub-pane below the price chart.
3. WHEN the user toggles an indicator, THE Client SHALL show or hide that indicator.
4. THE Web_UI and THE TUI SHALL each display indicator values taken from Indicators Events.

### Requirement 27: Market Panels

**User Story:** As a trader, I want an order book, trades tape, and watchlist, so that I can see market activity at a glance.

#### Acceptance Criteria

1. THE Web_UI and THE TUI SHALL each display an order book panel with a depth bar per level proportional to the level quantity.
2. THE Web_UI and THE TUI SHALL each display a trades tape of recent Trade Events with price, quantity, and side.
3. THE Web_UI and THE TUI SHALL each display a watchlist of BTC-USD, ETH-USD, and SOL-USD with last trade price.
4. WHEN the user clicks a watchlist symbol, or selects a symbol with Tab or the arrow keys, THE Client SHALL switch every panel to that symbol.

### Requirement 28: Account Panels

**User Story:** As a trader, I want positions, open orders, and P&L on screen, so that I always know my exposure.

#### Acceptance Criteria

1. THE Web_UI and THE TUI SHALL each display the Positions with signed quantity, average entry price, realized P&L, and unrealized P&L.
2. THE Web_UI and THE TUI SHALL each display the open orders with side, symbol, type, price, filled quantity, and remaining quantity.
3. WHEN a Position, OrderAck, or Fill Event arrives, THE Client SHALL update the Positions, open orders, and P&L displays to match the Event.

### Requirement 29: Chart Navigation

**User Story:** As a trader, I want to zoom and pan the chart with mouse or keyboard, so that I can inspect history quickly.

#### Acceptance Criteria

1. WHEN the user turns the scroll wheel over the chart or presses + or −, THE Client SHALL zoom the chart in or out.
2. WHEN the user drags the chart or presses the left or right arrow key while the chart has focus, THE Client SHALL pan the chart backward or forward in time.

### Requirement 30: Order Entry Interactions

**User Story:** As a fast trader, I want one-key and one-click order actions with confirmation, so that I can act quickly without accidental trades.

#### Acceptance Criteria

1. WHEN the user clicks an order book price, or selects a level with the arrow keys and presses Enter, THE Client SHALL prefill a limit order ticket with that price and the selected symbol.
2. WHEN the user presses B or S, THE Client SHALL open a buy or sell Order_Preview for the current order ticket and wait for confirmation.
3. WHEN the user clicks ✕ on an open order, or selects an open order and presses Del, THE Client SHALL send a Cancel request for that order to the Router.
4. WHEN the user presses F, THE Client SHALL request confirmation and, after confirmation, send a flatten-all request to the Router.
5. WHEN the user presses X, THE Client SHALL request confirmation and, after confirmation, send a cancel-all request to the Router.
6. WHEN the Client receives an OrderRejected Event for the Client's request, THE Client SHALL display the rejection reason.

### Requirement 31: Command Bar

**User Story:** As a fast trader, I want a command bar with history, so that I can repeat and edit previous commands.

#### Acceptance Criteria

1. THE Web_UI and THE TUI SHALL each provide a Command_Bar.
2. WHEN the user submits Command_Bar text, THE Client SHALL send the text to the Server for parsing.
3. WHEN the user presses the up or down arrow key in the Command_Bar, THE Client SHALL replace the Command_Bar text with the previous or next entry in the session's command history.
4. WHEN the Server returns a parse error, THE Client SHALL display the error and keep the submitted text in the Command_Bar.

### Requirement 32: Shared Keymap

**User Story:** As a user of both Clients, I want the same key bindings everywhere, so that my muscle memory carries over.

#### Acceptance Criteria

1. THE Keymap SHALL define every keyboard binding used by the Web_UI and the TUI.
2. THE TUI SHALL embed the Keymap at build time.
3. THE Web_UI SHALL load key bindings from the Keymap.
4. THE Keymap SHALL bind each key to at most one action within each input context.

### Requirement 33: Connection State

**User Story:** As a user of the free-hosted demo, I want the Clients to show when the server is waking, so that I know to wait instead of assuming the app is broken.

#### Acceptance Criteria

1. WHILE a Client has no open WebSocket connection to the Server, THE Client SHALL display a "waking server" status.
2. WHILE a Client has no open WebSocket connection to the Server, THE Client SHALL retry the connection with exponential backoff capped at 10 seconds between attempts.
3. WHEN a Client reconnects, THE Client SHALL resubscribe to the selected symbol and Timeframe.
4. WHEN a Client that holds an unexpired Session_Token opens a WebSocket connection, THE Client SHALL send an Authenticate Client_Message with that Session_Token before sending any order request.

### Requirement 34: TUI Rendering

**User Story:** As a terminal user, I want a responsive, detailed chart in the terminal, so that the TUI matches the web chart.

#### Acceptance Criteria

1. THE CandleChart_Widget SHALL draw candle bodies and wicks with Unicode block characters.
2. THE CandleChart_Widget SHALL draw indicator overlay lines with Unicode braille characters.
3. THE TUI SHALL redraw the screen at most 30 times per second.
4. THE TUI SHALL run in Windows Terminal and PowerShell on Windows, and in Terminal.app and iTerm2 on macOS.

### Requirement 35: TUI Mouse Hit-Testing

**User Story:** As a terminal user, I want mouse clicks to hit the right panel and item, so that the mouse works as in the web UI.

#### Acceptance Criteria

1. WHEN the TUI draws a frame, THE TUI SHALL record the rectangle of each panel and clickable item in the Hit_Map.
2. WHEN the TUI receives a mouse event, THE TUI SHALL resolve the event to the panel and item whose Hit_Map rectangle contains the event position.
3. FOR ALL layouts and mouse positions, the Hit_Map SHALL resolve a position to at most one item, and the resolved item's rectangle SHALL contain the position (invariant).

### Requirement 36: TUI Startup and Shutdown

**User Story:** As a terminal user, I want the TUI to connect to the hosted server by default and to leave my terminal usable, so that I can start quickly and recover from crashes.

#### Acceptance Criteria

1. THE TUI SHALL connect to `wss://haunted-terminal-server.onrender.com/ws` by default.
2. WHERE the `--server` argument is given, THE TUI SHALL connect to the URL given in the argument.
3. WHEN the TUI exits, THE TUI SHALL restore the terminal to its original mode.
4. IF the TUI panics, THEN THE TUI SHALL restore the terminal to its original mode before printing the panic message.

### Requirement 37: Web UI Build

**User Story:** As an operator, I want the Web UI as static files, so that it deploys as a free static site.

#### Acceptance Criteria

1. THE Web_UI SHALL build as a Next.js 16 App Router static export with output set to 'export'.
2. THE Web_UI SHALL connect to the Server WebSocket URL given in NEXT_PUBLIC_WS_URL.
3. THE Web_UI SHALL use TypeScript, Tailwind, and zustand.

### Deployment, Distribution, and Repository

### Requirement 38: Render Blueprint

**User Story:** As an operator, I want a Render Blueprint, so that the Server and Web_UI deploy from the Repository.

#### Acceptance Criteria

1. THE Render_Blueprint SHALL define a service named haunted-terminal-server with runtime docker, plan free, healthCheckPath `/health`, autoDeployTrigger checksPass, and a buildFilter.
2. THE Render_Blueprint SHALL define a service named haunted-terminal-web with runtime static that publishes `./web/out` and whose build command installs Bun 1.4.4.
3. THE Render_Blueprint SHALL pass validation against Render's Blueprint schema.
4. THE Render_Blueprint SHALL declare the DATABASE_URL and DIRECT_URL environment variables for haunted-terminal-server with `sync: false`.
5. THE Render_Blueprint SHALL declare the SESSION_SECRET environment variable for haunted-terminal-server with `generateValue: true`.

### Requirement 39: Server Image

**User Story:** As an operator, I want a small, non-root Docker image, so that the Server runs safely on Render.

#### Acceptance Criteria

1. THE Server_Image SHALL build the Engine in a rust:1.94-bookworm build stage.
2. THE Server_Image SHALL use oven/bun:1.4.4-debian as the runtime stage.
3. THE Server_Image SHALL run the Server as a non-root user.

### Requirement 40: Release Binaries

**User Story:** As a terminal user, I want downloadable TUI and Engine binaries, so that I can run the TUI without building from source.

#### Acceptance Criteria

1. WHEN a tag matching `v*` is pushed, THE Release_Workflow SHALL build the TUI and the Engine for x86_64-pc-windows-msvc and package them as a zip archive.
2. WHEN a tag matching `v*` is pushed, THE Release_Workflow SHALL build the TUI and the Engine for aarch64-apple-darwin and x86_64-apple-darwin, merge each pair with lipo into a macOS universal binary, and package them as a tar.gz archive.
3. THE Release_Workflow SHALL publish a SHA-256 checksum for each archive.
4. THE Repository README SHALL explain the macOS Gatekeeper and Windows SmartScreen workarounds for the unsigned binaries.

### Requirement 41: Continuous Integration

**User Story:** As a developer, I want CI on both target platforms, so that regressions are caught before release.

#### Acceptance Criteria

1. THE CI_Workflow SHALL run the test suite on windows-latest and macos-latest.
2. THE Repository SHALL provide a `bun run check` script that runs every test, type check, and lint check.
3. THE CI_Workflow SHALL run a Docker smoke test that starts the Server_Image, connects a WebSocket client, places a paper order, and receives a Fill Event.
4. THE CI_Workflow SHALL validate the Render_Blueprint against Render's Blueprint schema.
5. THE CI_Workflow SHALL run the Journal integration tests in an ubuntu-latest job against a postgres:17 service container, after applying the Migrations to that container with `prisma migrate deploy`, with TEST_DATABASE_URL set to the connection string of that container.
6. THE CI_Workflow SHALL start a postgres:17 service container for the Docker smoke test and pass the connection string of that container to the Server_Image as both DATABASE_URL and DIRECT_URL.
7. WHERE TEST_DATABASE_URL is unset, THE Repository SHALL skip the Journal integration tests so that `bun run check` passes without a database.

### Requirement 42: Hackathon Repository Deliverables

**User Story:** As a hackathon entrant, I want the Repository to meet the Kiroween submission rules, so that the entry is eligible for judging.

#### Acceptance Criteria

1. THE Repository SHALL be public on GitHub and include an MIT LICENSE file.
2. THE Repository SHALL commit the `.kiro/` directory and exclude `.kiro/` from every ignore rule.
3. THE Repository SHALL include the steering documents `.kiro/steering/product.md`, `.kiro/steering/tech.md`, `.kiro/steering/rust.md`, and `.kiro/steering/trading-safety.md`.
4. THE Repository SHALL include a Kiro hook that runs `cargo test` and `cargo clippy -- -D warnings` when a `.rs` file is saved.
5. THE Repository SHALL include a Kiro hook that runs `bun test` and `tsc --noEmit` when a `.ts` or `.tsx` file is saved.
6. THE Repository SHALL include a README that describes setup, replay mode, the hosted demo, the free-plan limits (the Server sleeps after 15 minutes idle and takes about 1 minute to wake), and that the Journal persists in Neon Postgres across Server restarts while the Paper_Account resets.
7. THE Repository SHALL include a link to a demo video shorter than 3 minutes and a write-up of how Kiro was used.
8. THE Repository README SHALL explain how to create a Neon project, set the project's pooled connection string as DATABASE_URL, and set the project's direct connection string as DIRECT_URL, in the Render dashboard and in a local `.env` file.
9. THE Repository README SHALL explain wallet sign-in with Phantom and Backpack, that the Wallet signs only a sign-in message and never a transaction, guest mode, TUI pairing with the `--guest` and `--logout` flags, the choice of Live_Venue with LIVE_VENUE, and that every Paper_Account resets when the Engine restarts.

### Engine: Venues

### Requirement 43: Live Market Data (Backpack)

**User Story:** As a trader, I want live market data from Backpack Exchange, so that I can practice against Solana-native prices.

#### Acceptance Criteria

1. WHERE DATA_MODE is set to live and the Live_Venue is Backpack, THE Backpack_Adapter SHALL subscribe to the Backpack public WebSocket at `wss://ws.backpack.exchange` for the trade and depth streams of BTC_USDC, ETH_USDC, and SOL_USDC.
2. WHERE DATA_MODE is set to live and the Live_Venue is Backpack, WHEN a Client subscribes to a symbol, THE Backpack_Adapter SHALL backfill candle history from the Backpack public REST kline endpoint.
3. THE Backpack_Adapter SHALL send no API key, signature, or account credential to any Backpack endpoint.
4. WHEN the Backpack_Adapter receives a Backpack trade or depth message, THE Backpack_Adapter SHALL normalize the message into a market data message that carries the internal symbol from the Venue_Symbol_Map.
5. WHEN the Backpack_Adapter connects or reconnects, THE Backpack_Adapter SHALL load an order book snapshot for each symbol from the Backpack public REST depth endpoint and apply only depth updates that follow the snapshot.
6. IF a Backpack depth update does not follow the previous update for its symbol in the Backpack update sequence, THEN THE Backpack_Adapter SHALL discard the local book for that symbol and load a new snapshot from the Backpack public REST depth endpoint.
7. IF the Backpack WebSocket connection closes or fails, THEN THE Backpack_Adapter SHALL emit an Error Event and reconnect with exponential backoff.
8. THE Backpack_Adapter SHALL establish TLS connections with rustls using the `ring` crypto provider.

### Requirement 44: Live Venue Selection

**User Story:** As an operator, I want to choose Coinbase or Backpack as the live data source, so that the terminal can run against either venue without code changes.

#### Acceptance Criteria

1. WHERE DATA_MODE is set to live, THE Market_Feed SHALL connect to the Live_Venue named by LIVE_VENUE, and to Backpack when LIVE_VENUE is unset.
2. THE Venue_Symbol_Map SHALL map BTC-USD, ETH-USD, and SOL-USD to the Coinbase symbols BTC-USD, ETH-USD, and SOL-USD and to the Backpack symbols BTC_USDC, ETH_USDC, and SOL_USDC.
3. THE Instrument_Table SHALL use 2 price decimals (a tick of 0.01) and 8 quantity decimals (a lot of 0.00000001) for every symbol, independent of the Live_Venue.
4. WHEN the Market_Feed starts in live mode, THE Market_Feed SHALL read the Live_Venue's public market metadata and log an error for each symbol whose Venue tick size or lot size is not a whole multiple of the internal tick or lot.
5. IF a Venue price or quantity is not a whole multiple of the internal tick or lot, THEN THE Market_Feed SHALL discard the message that holds the value and log the count of discarded messages at most once every 10 seconds.
6. FOR ALL decimal strings that are whole multiples of the internal tick or lot, converting the string to Ticks or Lots and back to a decimal string SHALL produce a string with the same numeric value (round-trip property).
7. THE Web_UI and THE TUI SHALL each display in the status bar either REPLAY or LIVE with the name of the Live_Venue, taken from the Hello Server_Message.

### Accounts and Authentication

### Requirement 45: Wallet Sign-In (Server)

**User Story:** As a trader with a Solana wallet, I want to sign in by signing a message, so that I get my own paper account without a password.

#### Acceptance Criteria

1. WHEN the Auth_Service receives a POST request at `/auth/nonce` with an Origin header listed in ALLOWED_ORIGINS and a Wallet_Address that base58-decodes to 32 bytes, THE Auth_Service SHALL create a Nonce bound to that Wallet_Address and that origin and respond with the SIWS_Message fields: domain set to the host of the origin, the Wallet_Address, the Sign_In_Statement, URI set to the origin, version 1, chain ID `solana:mainnet`, the Nonce, the issued-at time, and an expiration time 5 minutes after issue.
2. IF a request at `/auth/nonce` or `/auth/verify` carries no Origin header or an Origin header that is not listed in ALLOWED_ORIGINS, THEN THE Auth_Service SHALL respond with HTTP status 403.
3. IF a request at `/auth/nonce` carries a Wallet_Address that does not base58-decode to 32 bytes, THEN THE Auth_Service SHALL respond with HTTP status 400.
4. WHEN the Auth_Service receives a POST request at `/auth/verify` with SIWS_Message bytes and a signature, THE Auth_Service SHALL verify the 64-byte Ed25519 signature over the exact SIWS_Message bytes against the public key decoded from the Wallet_Address in the SIWS_Message.
5. IF the signature is invalid, or the SIWS_Message domain differs from the request origin's host, or the SIWS_Message URI differs from the request origin, or the Nonce was not issued for the SIWS_Message's Wallet_Address and origin, or the Nonce has been used or has expired, or the chain ID is not `solana:mainnet`, or the version is not 1, or the statement differs from the Sign_In_Statement, or the expiration time has passed, THEN THE Auth_Service SHALL respond with HTTP status 401 and issue no Session_Token.
6. WHEN the Auth_Service receives a Nonce at `/auth/verify`, THE Auth_Service SHALL mark the Nonce as used before the Auth_Service checks the signature, whatever the outcome of the check.
7. WHEN the Auth_Service verifies a signed SIWS_Message, THE Auth_Service SHALL respond with a new Session_Token for the Wallet_Address, the Account_Id `w_<Wallet_Address>`, and the token's expiry time.
8. THE SIWS_Parser SHALL parse SIWS_Message text into its fields and return an error for text that does not follow the SIWS_Message line format.
9. THE SIWS_Formatter SHALL format SIWS_Message fields into SIWS_Message text.
10. FOR ALL valid SIWS_Message field sets, formatting and then parsing SHALL produce fields equal to the original (round-trip property).
11. FOR ALL valid signed SIWS_Messages, changing any one of the domain, URI, address, Nonce, chain ID, version, statement, or expiration time, or any byte of the signature, SHALL make the Auth_Service reject the sign-in (tamper property).
12. THE Auth_Service SHALL sign each Session_Token with HMAC-SHA256 under SESSION_SECRET over a payload that holds the Wallet_Address, an expiry time 24 hours after issue, and a unique jti.
13. FOR ALL Session_Token payloads, secrets, and times, the Auth_Service SHALL accept a Session_Token if and only if the token was issued under the current SESSION_SECRET, the token is unmodified, the expiry time has not passed, and the jti is not in the Token_Denylist (token property).
14. WHEN the Auth_Service receives a POST request at `/auth/logout` with a valid Session_Token in an `Authorization: Bearer` header, THE Auth_Service SHALL add the token's jti to the Token_Denylist until the token's expiry time.
15. IF a client IP address sends more than 10 requests in one minute to `/auth/nonce`, `/auth/verify`, or `/auth/logout`, THEN THE Auth_Service SHALL respond to the excess requests with HTTP status 429.

### Requirement 46: WebSocket Authentication and Connection Sessions

**User Story:** As a signed-in trader, I want my WebSocket connection tied to my wallet account, so that my orders and fills go to my account only.

#### Acceptance Criteria

1. WHEN a WebSocket connection opens, THE Server SHALL send a Session Server_Message with the Account_Id `guest` and a null Wallet_Address after the Hello Server_Message.
2. WHEN the Server receives an Authenticate Client_Message with a Session_Token that the Auth_Service accepts, THE Server SHALL set the connection's Connection_Session to the Wallet_Account of the token and send a Session Server_Message with the Account_Id and the Wallet_Address.
3. IF the Server receives an Authenticate Client_Message with a Session_Token that the Auth_Service rejects, THEN THE Server SHALL set the connection's Connection_Session to the Guest_Account, send a Session Server_Message with the Account_Id `guest`, and send a Notice with the kind auth_failed.
4. WHEN a connection's Connection_Session changes Account_Id, THE Server SHALL discard every pending Order_Preview of that connection.
5. IF a connection sends an order request after the expiry time of the Connection_Session's Session_Token, THEN THE Router SHALL reject the order with the reason session_expired, and THE Server SHALL set the connection's Connection_Session to the Guest_Account and send a Session Server_Message and a Notice with the kind session_expired.
6. WHEN the Auth_Service adds a jti to the Token_Denylist, THE Server SHALL set the Connection_Session of every connection that authenticated with that jti to the Guest_Account and send each such connection a Session Server_Message and a Notice with the kind signed_out.

### Requirement 47: Wallet Sign-In (Web UI)

**User Story:** As a trader with Phantom or Backpack, I want sign-in buttons in the web UI, so that I can switch from the guest account to my own account.

#### Acceptance Criteria

1. THE Web_UI SHALL detect installed Wallets through Wallet Standard and show one "Sign in with Phantom" or "Sign in with Backpack" button for each detected Phantom or Backpack Wallet that supports the `solana:signIn` or `solana:signMessage` feature.
2. WHEN the user clicks a sign-in button, THE Web_UI SHALL connect the Wallet, request a Nonce from `/auth/nonce`, ask the Wallet to sign the SIWS_Message with `solana:signIn`, or with `solana:signMessage` when the Wallet lacks `solana:signIn`, and send the signed SIWS_Message to `/auth/verify`.
3. THE Web_UI SHALL request from a Wallet only the `standard:connect`, `standard:disconnect`, `solana:signIn`, and `solana:signMessage` features.
4. WHILE the Web_UI holds a Session_Token, THE Web_UI SHALL display the Wallet_Address shortened to its first 4 and last 4 characters and a sign-out action.
5. WHEN the user signs out, THE Web_UI SHALL send the Session_Token to `/auth/logout`, delete the stored Session_Token, and disconnect the Wallet.
6. WHEN the Web_UI loads with a stored Session_Token whose expiry time has not passed, THE Web_UI SHALL send an Authenticate Client_Message with that token after the WebSocket connection opens.
7. IF the Web_UI detects no supported Wallet, THEN THE Web_UI SHALL display that no supported Wallet was found and keep the connection on the Guest_Account.
8. WHILE a Client's Connection_Session holds the Guest_Account, THE Client SHALL display the label GUEST next to the account panels.

### Requirement 48: TUI Pairing

**User Story:** As a terminal user, I want to sign the TUI in through my browser wallet, so that the TUI trades on my own paper account without handling keys in the terminal.

#### Acceptance Criteria

1. WHEN the user presses the pairing key in the TUI, THE TUI SHALL generate a Pairing_Secret and send a POST request at `/auth/pair` with the base64url SHA-256 hash of the Pairing_Secret.
2. WHEN the Auth_Service receives a POST request at `/auth/pair` with a 32-byte hash, THE Auth_Service SHALL create a Pairing and respond with the Pairing_Code, a pair URL of the form `<WEB_URL>/pair?code=<Pairing_Code>`, and an expiry of 300 seconds.
3. WHEN the TUI receives a Pairing_Code, THE TUI SHALL display the Pairing_Code and the pair URL until the Pairing succeeds, fails, or expires.
4. WHEN a signed-in user opens the pair URL and confirms the Pairing in the Web_UI, THE Web_UI SHALL send a POST request at `/auth/pair/confirm` with the Pairing_Code and the user's Session_Token, and THE Auth_Service SHALL bind the Pairing to the token's Wallet_Address.
5. THE Web_UI SHALL display the Pairing_Code on the pair page and bind the Pairing only after the user clicks a confirm button.
6. WHEN the Auth_Service receives a POST request at `/auth/pair/poll` with a Pairing_Code and a Pairing_Secret whose SHA-256 hash matches the Pairing, for a confirmed Pairing, THE Auth_Service SHALL respond with a new Session_Token for the bound Wallet_Address and delete the Pairing.
7. WHILE a Pairing is unconfirmed and unexpired, THE Auth_Service SHALL respond to a matching poll with a pending status.
8. IF a poll carries a Pairing_Code that is unknown, used, or expired, or a Pairing_Secret whose hash does not match, THEN THE Auth_Service SHALL respond with HTTP status 404 and issue no Session_Token.
9. IF a client IP address sends more than 5 requests in one minute to `/auth/pair` or more than 10 requests in one minute to `/auth/pair/confirm`, or polls one Pairing more than once every 2 seconds, THEN THE Auth_Service SHALL respond to the excess requests with HTTP status 429.
10. FOR ALL sequences of create, confirm, poll, and clock-advance operations on Pairings, the Auth_Service SHALL issue a Session_Token for a Pairing at most once, only to a poll with the matching Pairing_Secret, only after confirmation, and only before the Pairing's expiry time (pairing property).
11. WHEN the TUI receives a Session_Token from a poll, THE TUI SHALL write the Session_Token to the Token_Store, with file permissions 0600 on macOS, and send an Authenticate Client_Message with the token.
12. WHEN the TUI starts with an unexpired Session_Token in the Token_Store and without the `--guest` argument, THE TUI SHALL send an Authenticate Client_Message with that token after each WebSocket connect.
13. WHERE the `--guest` argument is given, THE TUI SHALL use the Guest_Account and leave the Token_Store unchanged.
14. WHERE the `--logout` argument is given, THE TUI SHALL send the stored Session_Token to `/auth/logout`, delete the Token_Store file, and exit with status code 0.

### Requirement 49: Wallet Safety

**User Story:** As a wallet owner, I want the terminal to never ask my wallet for a transaction, so that signing in cannot move funds.

#### Acceptance Criteria

1. THE Haunted_Terminal SHALL ask a Wallet to sign only SIWS_Messages.
2. THE Web_UI SHALL contain no call to the `solana:signTransaction`, `solana:signAndSendTransaction`, or `solana:signAndSendAllTransactions` Wallet features and no token approval request.
3. THE Server SHALL treat the chain ID `solana:mainnet` in a SIWS_Message as an identity claim and verify sign-ins without contacting any Solana RPC endpoint.
