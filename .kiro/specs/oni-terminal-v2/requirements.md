# Requirements Document

## Introduction

Oni Terminal v2 is the second iteration of the Oni crypto paper-trading terminal (Kiroween 2026 hackathon, Frankenstein category; deadline December 4, 2026, 2:00 PM PT; internal target December 3, 2026). It extends the system specified in `.kiro/specs/haunted-terminal/requirements.md` (referred to below as "HT") and the finished `.kiro/specs/chart-and-tape-fix/` spec. Requirement numbers written as "HT Req N.M" point into the HT document.

Version 2 makes six changes:

1. **No database.** The Neon Postgres journal and Prisma ORM are removed. Orders, fills, and rejections live in a bounded in-memory Activity_Log for the current Engine run. History comes from public exchange APIs, never from storage the project maintains.
2. **Pluggable AI providers and an AI analyst.** A single LLM_Provider interface has four implementations: OpenAI, Anthropic Claude, NVIDIA NIM, and Ollama. Any provider can drive the plain-English order parser and the new AI_Analyst. The AI_Analyst reads market data and news and suggests a trade as an Order_Preview that the user must confirm. No AI component places an order (decision recorded below).
3. **A new layout** in the Web_UI and the TUI, following the supplied mockup: top navigation, left sidebar, exchange chips, symbol header, chart with drawing tools, order book and trades, order ticket, bottom tabs, AI Copilot panel, watchlist, and news.
4. **More venues and symbols, read-only.** Jupiter and Raydium are added as price-only DEX venues next to Coinbase and Backpack. The symbol set grows from 3 to 10. Binance and Bybit appear in the Web_UI as disabled chips only. Nothing in the system builds, signs, or sends a transaction.
5. **News** from NewsAPI (local development) and CryptoPanic (hosted), fetched and cached by the Server. Keys never reach a browser.
6. **Low latency** with measurable targets, a visible latency readout, message batching with coalescing, and render-efficiency rules.

### Decisions Recorded From the Requirements Interview

| Topic | Decision |
|---|---|
| Decision models | AI analyst that suggests a trade as an Order_Preview. The user confirms every order. Trading-safety rule 4 ("The LLM never trades") is unchanged. An autonomous agent and a rule/quant signal model are out of scope. |
| Provider reach | Any provider can serve the AI_Analyst and the LLM_Order_Parser, selected at runtime. API keys come from Server environment variables only. |
| Symbols | 10: BTC, ETH, SOL, BNB, XRP, DOGE, JUP, WIF, BONK, PEPE (approved). A symbol that a Venue does not list is marked "not listed" for that Venue in the Venue_Symbol_Map. |
| Paper balance | Orders that the Paper_Account cannot pay for are rejected with the reason insufficient_balance (approved). Short selling stays allowed and needs 100 percent cash margin. |
| Chart drawing tools | Optional and lowest priority: the first scope item to cut if time runs short (approved). |
| Chart types | Candles, line, area, and Heikin-Ashi in the Web_UI. Candles and line in the TUI. |
| Venues | Coinbase, Backpack, Jupiter, Raydium. Binance and Bybit are shown disabled. |
| Pages in scope | Trade and AI Copilot are complete. Markets, Portfolio, Logs, Dashboard, and Settings are simple. Strategies and Backtest are placeholders. |
| News | NewsAPI for local development, CryptoPanic free tier for the hosted deploy, behind one News_Provider interface. |
| TUI panels | The TUI also gets the News panel and the AI Copilot panel. |
| TWAP | The Router schedules TWAP child orders after one confirmed Order_Preview. Each child order passes through the Risk_Engine. |

## Glossary

Terms defined in HT keep their HT meaning unless this glossary redefines them. HT terms retired by this spec (Journal, Prisma_Client, Journal_Queue, Journal_Writer, Journal_Status, Migration, Start_Script) are listed under Superseded Requirements.

- **Oni_Terminal**: The complete system described in this document. It replaces the HT term Haunted_Terminal.
- **Activity_Log**: The bounded in-memory log in the Server that holds order, fill, and rejection records for the current Engine run, per Account_Id.
- **Activity_Record**: One entry of the Activity_Log: kind (order, fill, or rejection), Account_Id, symbol, venue, time, and the fields of the order, fill, or rejection reason.
- **Run_Id**: A random identifier that the Server generates each time the Engine starts. It replaces the HT Session_Id and is not stored anywhere.
- **Venue**: A source of market data. The Venues are `coinbase`, `backpack`, `jupiter`, `raydium`, and, in replay mode only, `replay`.
- **Venue_Kind**: `cex` for Coinbase, Backpack, and Replay, and `dex` for Jupiter and Raydium.
- **Live_Venues**: The set of Venues that the Market_Feed connects to in live mode, set by the LIVE_VENUES environment variable.
- **Venue_Status**: The state of one Venue: `connected`, `connecting`, `stale`, `down`, or `disabled`.
- **Venue_Symbol_Map**: The committed table that maps each internal symbol to the symbol or token mint address on each Venue, and records which symbols a Venue does not list.
- **Active_Venue**: The Venue whose chart, order book, trades tape, and order ticket a Client currently shows.
- **Reference_Venue**: For one symbol, the first Venue in the priority order backpack, coinbase, raydium, jupiter, replay whose Venue_Status is `connected` and that lists the symbol.
- **Mark_Price**: The last trade price or last Price_Sample of a symbol on its Reference_Venue. The Engine uses the Mark_Price for unrealized P&L and equity.
- **Price_Sample**: A price for one symbol and one DEX Venue obtained by polling that Venue's public price endpoint.
- **Synthetic_Book**: An Order_Book that the Engine builds around a Price_Sample for a DEX Venue, with a simulated spread and constant-size levels.
- **DEX_Adapter**: Either the Jupiter_Adapter or the Raydium_Adapter.
- **Jupiter_Adapter**: The Market_Feed component that polls the Jupiter Price API v3 (`https://api.jup.ag/price/v3`).
- **Raydium_Adapter**: The Market_Feed component that polls the Raydium public data API (`https://api-v3.raydium.io`): `GET /mint/price` for prices and `GET /pools/info/mint` for pool liquidity. It contacts no other Raydium host.
- **Endpoint_Allowlist**: The committed list of exact URL hosts and path prefixes that the Market_Feed and the Server may request on exchange and news hosts. The Endpoint_Allowlist is defined in Requirement 14.
- **Ticker24h**: An Event that carries, for one symbol and Venue, the 24-hour open, high, low, last price, base volume, and percentage change.
- **Paper_Balance**: The simulated quote-currency (USD) balance of a Paper_Account.
- **Starting_Balance**: The Paper_Balance of a Paper_Account at creation or reset, 100,000 USD unless set by STARTING_BALANCE.
- **Equity**: Starting_Balance plus realized P&L (net of fees) plus unrealized P&L of a Paper_Account.
- **Short_Basis**: For one Paper_Account, the sum over symbols with a negative Position of the absolute cost basis of that Position (the notional at entry of the short).
- **Required_Funds**: For one order, the amount by which a full fill would reduce Paper_Balance minus twice the Short_Basis, as defined in Requirement 16, criterion 6.
- **Reserved_Balance**: For one Paper_Account, the sum over its open orders of the larger of zero and the Required_Funds of that order, evaluated against the account's current Positions.
- **Free_Balance**: Paper_Balance minus twice the Short_Basis minus the Reserved_Balance. Short sale proceeds are credited to the Paper_Balance, and the factor two locks those proceeds and an equal amount of the account's own cash as margin. A long Position needs no extra term, because the purchase has already reduced the Paper_Balance.
- **LLM_Provider**: The Server interface for a language model. The implementations are `openai`, `anthropic`, `nvidia`, and `ollama`. This definition extends HT's LLM_Provider.
- **Provider_Registry**: The Server component that lists the LLM_Providers that are configured and reachable and resolves a provider identifier to an LLM_Provider.
- **Provider_Selection**: The LLM_Provider that one WebSocket connection uses for AI requests, set by the Server default or by the Client.
- **Ollama_Model_List**: The Server's latest validated list of the models that the Ollama instance at OLLAMA_BASE_URL reports installed, each with name, size in bytes, family, and parameter size. The list is empty when Ollama is unreachable or its answer is invalid.
- **Model_Selection**: The Ollama model that one WebSocket connection uses for plain-English orders and AI_Analyst requests, set by the Server default or by `set_model`.
- **AI_Analyst**: The Server component that builds a Market_Snapshot, sends it to the selected LLM_Provider, validates the answer with Zod, and returns an Analysis.
- **Market_Snapshot**: The data the AI_Analyst sends to an LLM_Provider: for one symbol, recent candles, indicator values, top-of-book levels, Ticker24h, news headlines, and the Positions of the caller's Paper_Account. It holds no Account_Id, Wallet_Address, or secret.
- **Analysis**: The validated AI_Analyst result: a summary, a bias (`long`, `short`, or `neutral`), a confidence from 0 to 1, a list of rationale strings, and an optional suggested order.
- **Copilot**: The AI Copilot panel and page in the Web_UI and the AI Copilot panel in the TUI. The Copilot sends prompts to the AI_Analyst and shows Analyses.
- **Copilot_Action**: One of the four quick actions: Analyze, Place trade, Create strategy, and Scan opportunities.
- **News_Provider**: The Server interface for a news source. The implementations are `newsapi` (https://newsapi.org) and `cryptopanic`.
- **News_Item**: A news entry with id, title, source name, URL, published time, and optional related symbols.
- **News_Cache**: The Server's in-memory cache of News_Items.
- **TWAP_Order**: An order type that splits a total quantity into equal child market orders at fixed intervals.
- **TWAP_Plan**: The slice count, interval, total quantity, symbol, side, and Venue of a TWAP_Order, shown in one Order_Preview.
- **Exchange_Chip**: A Web_UI filter button for a Venue or Venue_Kind.
- **Chart_Type**: One of `candles`, `line`, `area`, and `heikin_ashi`.
- **Drawing_Tool**: An optional, lowest-priority Web_UI chart tool: horizontal line, trend line, or clear all drawings.
- **App_Shell**: The Web_UI frame: top navigation, left sidebar, header status, and the page area.
- **Latency_Readout**: The Client display of the median of the last 10 Ping and Pong round-trip times between the Client and the Server, in milliseconds.
- **Flush_Window**: The 10 ms interval in which the Server collects Events for one connection before sending them as one batch.
- **Event_Batch**: A Server_Message that holds an ordered list of Events for one connection.
- **Coalescible_Event**: An Event of a kind where a newer Event for the same key replaces an older one: Book (key: symbol and Venue), Indicators (key: symbol, Venue, and Timeframe), Candle updates that are not history snapshots (key: symbol, Venue, Timeframe, and bar start time, so that the final update of a closed bar is never dropped), and Ticker24h (key: symbol and Venue).
- **Latency_Histogram**: The Server's in-memory record of stage durations, reported as p50 and p95 values.
- **Settings_Page**: The Web_UI page for the Provider_Selection, default Venue, default Chart_Type, and wallet sign-in.

## Requirements

### Database Removal

### Requirement 1: Remove the Journal Database

**User Story:** As the project owner, I want no database to run or maintain, so that deployment needs only the Server image and the static site.

#### Acceptance Criteria

1. THE Repository SHALL contain no Prisma packages, `server/prisma/` directory, Prisma schema, Migration, generated Prisma client, or `db:generate` script.
2. THE Server SHALL read no DATABASE_URL, DIRECT_URL, or DB_ADAPTER setting.
3. IF DATABASE_URL, DIRECT_URL, or DB_ADAPTER is set in the environment, THEN THE Server SHALL log the name of each such variable as unused and ignore the value.
4. THE Server_Image start command SHALL start the Server without a Migration step.
5. THE Render_Blueprint SHALL declare no DATABASE_URL or DIRECT_URL variable for oni-server.
6. THE CI_Workflow SHALL contain no postgres service container, no journal integration job, and no `prisma migrate deploy` step.
7. THE Repository documentation SHALL contain no instruction that creates a Neon project or sets a database connection string.
8. THE Server SHALL send no query to any database, and `bun run check` SHALL pass with no database or database environment variable available.
9. WHEN the Server answers a GET request at `/health`, THE Server SHALL respond with HTTP status 200 and a JSON body that reports whether the Engine is running, the Venue_Status of each Live_Venue, and the Latency_Histogram p50 and p95 values, and that contains no `db` field.

### Requirement 2: Activity Log and REST Endpoints

**User Story:** As a trader, I want to review my orders, fills, and rejections for the current run, so that I can check what happened without a database.

#### Acceptance Criteria

1. WHEN the Router sends a PlaceOrder Command to the Engine, THE Server SHALL append an Activity_Record of kind order to the Activity_Log of the order's Account_Id.
2. WHEN the Engine emits a Fill Event, THE Server SHALL append an Activity_Record of kind fill to the Activity_Log of the Event's Account_Id.
3. WHEN the Risk_Engine or the Engine rejects an order, THE Server SHALL append an Activity_Record of kind rejection with the rejection reason to the Activity_Log of the order's Account_Id.
4. THE Activity_Log SHALL hold at most 1,000 Activity_Records per Account_Id and SHALL drop the oldest record of that Account_Id when a new record would exceed the limit.
5. THE Activity_Log SHALL hold records for at most 1,000 Account_Ids and SHALL drop all records of the least recently updated Account_Id when a record for a new Account_Id would exceed the limit.
6. WHEN the Engine restarts, THE Server SHALL clear the Activity_Log and generate a new Run_Id.
7. THE Server SHALL keep the Activity_Log in process memory only and write no Activity_Record to disk.
8. WHEN the Server receives a GET request at `/journal`, THE Server SHALL respond with the Activity_Records of the caller's Paper_Account as JSON in append order.
9. WHEN the Server receives a GET request at `/orders`, THE Server SHALL respond with only the Activity_Records of kind order of the caller's Paper_Account as JSON in append order.
10. WHEN the Server receives a GET request at `/positions`, THE Server SHALL respond with the current Positions of the caller's Paper_Account as JSON.
11. WHEN the Server receives a GET request at `/orders` or `/journal` with a `limit` query parameter that is an integer from 1 to 1000 inclusive, THE Server SHALL respond with the most recent records, at most `limit` of them.
12. WHEN the Server receives a GET request at `/orders` or `/journal` without a `limit` query parameter, THE Server SHALL respond with the most recent records, at most 500 of them.
13. IF the Server receives a GET request at `/orders` or `/journal` with a `limit` query parameter that is not an integer from 1 to 1000 inclusive, THEN THE Server SHALL respond with HTTP status 400.
14. WHEN the Server receives a GET request at `/positions`, `/orders`, or `/journal`, THE Server SHALL use as the caller's Paper_Account the Wallet_Account of a valid Session_Token given in an `Authorization: Bearer` header, or the Guest_Account when the request has no Authorization header.
15. IF a GET request at `/positions`, `/orders`, or `/journal` carries an Authorization header with a Session_Token that is invalid, expired, or in the Token_Denylist, THEN THE Server SHALL respond with HTTP status 401.
16. THE Server SHALL send an Activity_Record only to requests and connections of the Activity_Record's Account_Id.
17. THE Router SHALL send each approved PlaceOrder Command to the Engine without waiting for any Activity_Log operation.
18. FOR ALL sequences of Activity_Records across several Account_Ids, listing the Activity_Log for an Account_Id with a limit n SHALL return exactly the last min(n, 1,000) records of that Account_Id in append order, and no record of another Account_Id (account scoping property).
19. FOR ALL sequences of appended Activity_Records, the number of records held for each Account_Id SHALL be at most 1,000 and the held records SHALL equal the most recent appended records of that Account_Id (bound invariant).

### AI Providers and Decision Support

### Requirement 3: LLM Provider Interface and Configuration

**User Story:** As an operator, I want to plug in OpenAI, Claude, NVIDIA NIM, or a local Ollama model through configuration, so that the AI features work with whichever model I have.

#### Acceptance Criteria

1. THE Server SHALL define one LLM_Provider interface that takes a system prompt, a user prompt, and a JSON schema, and returns text that the caller validates with Zod.
2. THE Server SHALL provide LLM_Provider implementations with the identifiers `openai`, `anthropic`, `nvidia`, and `ollama`.
3. THE `openai` implementation SHALL call the OpenAI Responses API with strict JSON-schema structured output using OPENAI_API_KEY and the model named by OPENAI_MODEL.
4. THE `anthropic` implementation SHALL call the Anthropic Messages API with JSON-schema structured output in `output_config.format`, using ANTHROPIC_API_KEY and the model named by ANTHROPIC_MODEL.
5. THE `nvidia` implementation SHALL call the NVIDIA NIM OpenAI-compatible chat completions API at NVIDIA_BASE_URL, which defaults to `https://integrate.api.nvidia.com/v1`, using NVIDIA_API_KEY and the model named by NVIDIA_MODEL.
6. THE `ollama` implementation SHALL call the Ollama chat API at OLLAMA_BASE_URL, which defaults to `http://localhost:11434`, with the model named by OLLAMA_MODEL and the JSON schema as the response format, and with no API key.
7. THE Server SHALL read LLM_PROVIDER, OPENAI_API_KEY, OPENAI_MODEL, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, NVIDIA_API_KEY, NVIDIA_MODEL, NVIDIA_BASE_URL, OLLAMA_BASE_URL, and OLLAMA_MODEL from environment variables only and validate each with Zod.
8. IF LLM_PROVIDER names an identifier that is not one of the four implementations, THEN THE Server SHALL log the variable name and exit with a non-zero status code.
9. THE Provider_Registry SHALL list an API-key provider as available only when its API key is set, and SHALL list `ollama` as available only when an HTTP request to the Ollama model list endpoint at OLLAMA_BASE_URL succeeds within 2 seconds.
10. THE Provider_Registry SHALL re-check the availability of `ollama` at most once every 30 seconds.
11. IF OLLAMA_BASE_URL or NVIDIA_BASE_URL is not a valid `http` or `https` URL, THEN THE Server SHALL log the variable name and exit with a non-zero status code.
12. IF an LLM_Provider returns no result within the provider timeout or returns an error, THEN THE Server SHALL return an error that names the provider and the failure class to the requesting Client and create no Order_Preview.
13. THE Server SHALL exclude OPENAI_API_KEY, ANTHROPIC_API_KEY, NVIDIA_API_KEY, and the full text of every LLM request and response from all log output and from all responses to Clients, except the validated Analysis or Order_Preview.
14. THE Server SHALL use the provider timeout 15 seconds for the LLM_Order_Parser and 30 seconds for the AI_Analyst.

### Requirement 4: Provider Selection and AI Abuse Limits

**User Story:** As a user, I want to pick which AI provider answers me, so that I can use a local model or a hosted one.

#### Acceptance Criteria

1. WHEN a WebSocket connection opens, THE Server SHALL send a Server_Message that lists the available LLM_Provider identifiers, the default identifier, and, for each identifier, the model name, and that contains no key, base URL, or credential.
2. WHEN the Server receives a SetProvider Client_Message with an identifier that is in the Provider_Registry's available list, THE Server SHALL set that connection's Provider_Selection to the identifier and send the updated provider Server_Message.
3. IF the Server receives a SetProvider Client_Message with an identifier that is not in the Provider_Registry's available list, THEN THE Server SHALL send an Error Event and leave the Provider_Selection unchanged.
4. THE Server SHALL take the Provider_Selection default from LLM_PROVIDER when that provider is available, and otherwise from the first available provider in the order `ollama`, `openai`, `anthropic`, `nvidia`.
5. THE Web_UI Settings_Page and the Copilot SHALL each show the available providers and the current Provider_Selection, and SHALL change the Provider_Selection through a SetProvider Client_Message.
6. THE Web_UI SHALL accept no API key, base URL, or model credential from the user and SHALL send none to the Server.
7. WHERE no LLM_Provider is available, THE Server SHALL disable the LLM_Order_Parser and the AI_Analyst and respond to `?`-prefixed input and to Copilot prompts with a message that AI features are disabled.
8. IF a connection sends more than the AI request rate in AI_RATE_PER_MIN requests in one minute, which defaults to 6, THEN THE Server SHALL reject the excess requests with the reason ai_rate_limit and send no request to an LLM_Provider.
9. IF the Server has sent AI_DAILY_CAP requests to LLM_Providers other than `ollama` in the current UTC day, which defaults to 500, THEN THE Server SHALL reject further requests to those providers with the reason ai_daily_cap until the next UTC day.
10. FOR ALL Provider_Selections and sets of available providers, THE Server SHALL send an AI request only to the LLM_Provider named by the connection's Provider_Selection and SHALL never retry a failed request on a different provider (provider isolation property).

### Requirement 5: AI Analyst

**User Story:** As a trader, I want an AI assistant that analyses the market and suggests a trade, so that I get a second opinion before I place an order.

#### Acceptance Criteria

1. WHEN the AI_Analyst receives a prompt for a symbol, THE AI_Analyst SHALL build a Market_Snapshot for the symbol from the Server's cached Engine Events and cached News_Items, using the most recent 100 candles of the selected Timeframe, the latest indicator values, the top 10 book levels per side of the Active_Venue, the latest Ticker24h, and at most 10 News_Items.
2. WHEN the AI_Analyst builds a Market_Snapshot, THE AI_Analyst SHALL include the Positions of the caller's Paper_Account for the symbol and SHALL include no Account_Id, Wallet_Address, Session_Token, or other secret.
3. WHEN the selected LLM_Provider returns a result, THE AI_Analyst SHALL validate the result with a strict Zod schema that has the fields summary, bias, confidence, rationale, and an optional suggested order with the fields side, symbol, order type, quantity, and price, and no account, venue, or wallet field.
4. IF the result fails Zod validation, THEN THE AI_Analyst SHALL return an error to the Client and create no Analysis and no Order_Preview.
5. WHEN an Analysis holds a suggested order, THE AI_Analyst SHALL convert the suggested order into command text and parse the command text with the Command_Parser, so that the Client receives an Order_Preview built by the Command_Parser.
6. IF the Command_Parser returns a parse error for the converted command text, THEN THE AI_Analyst SHALL return the Analysis without an Order_Preview and with the parse error.
7. THE AI_Analyst SHALL produce Analyses and Order_Previews only, and an order from an Analysis SHALL reach the Router only after the user confirms the Order_Preview as defined in HT Req 22.
8. THE AI_Analyst SHALL treat News_Item titles and every other external text in the Market_Snapshot as data, delimit it from the instructions in the prompt, and never execute an instruction found in it.
9. THE Client SHALL display each Analysis with its summary, bias, confidence, rationale, and the name of the provider and model that produced it.
10. THE Server SHALL send an Order_Preview from an Analysis only to the connection that sent the prompt, and SHALL set the Order_Preview's Account_Id and venue from the connection's Connection_Session and Active_Venue, never from the LLM result.
11. FOR ALL LLM results, including results that carry account, venue, or wallet fields or instruction text, THE AI_Analyst SHALL send zero PlaceOrder, Cancel, CancelAll, or ResetAccount Commands to the Engine (LLM no-trade property).
12. FOR ALL LLM results, THE AI_Analyst SHALL return either an Analysis that satisfies the Zod schema or an error (validation property).

### Requirement 6: Plain-English Orders on Any Provider

**User Story:** As a trader, I want `?` plain-English orders to work with whichever provider I selected, so that I am not tied to one vendor.

#### Acceptance Criteria

1. WHEN the Command_Bar text starts with `?`, THE LLM_Order_Parser SHALL send the remaining text to the LLM_Provider named by the connection's Provider_Selection.
2. THE LLM_Order_Parser SHALL validate the result and create an Order_Preview as defined in HT Req 23, criteria 2 through 6.
3. THE Server SHALL disable the LLM_Order_Parser as defined in Requirement 4, criterion 7, instead of HT Req 23, criterion 7.
4. FOR ALL LLM_Provider implementations that return the same JSON object, THE LLM_Order_Parser SHALL return the same Order_Preview (provider independence property).

### Requirement 7: Copilot Actions

**User Story:** As a trader, I want one-click Copilot actions, so that common analysis tasks need no typing.

#### Acceptance Criteria

1. WHEN the user submits Copilot text that starts with `@oni`, THE Copilot SHALL send the text after `@oni` to the AI_Analyst together with the Active_Venue and the selected symbol and Timeframe.
2. WHEN the user submits Copilot text that does not start with `@oni`, THE Copilot SHALL send the whole text to the AI_Analyst with the same context.
3. WHEN the user activates the Analyze action, THE Copilot SHALL send an analysis prompt for the selected symbol to the AI_Analyst.
4. WHEN the user activates the Place trade action, THE Copilot SHALL send the Copilot text to the LLM_Order_Parser, and the Server SHALL return an Order_Preview or an error as defined in Requirement 6.
5. WHEN the user activates the Scan opportunities action, THE AI_Analyst SHALL analyse each watchlist symbol that has candles for the selected Timeframe, with at most 3 LLM requests running at the same time, and return a list of Analyses ranked by confidence in descending order.
6. WHEN the user activates the Create strategy action, THE AI_Analyst SHALL return a strategy description as text labelled "draft, not executed", and THE Server SHALL store no strategy and place no order from the description.
7. WHILE an AI request is pending, THE Copilot SHALL display a pending state with the provider name and a cancel action.
8. WHEN the user cancels a pending AI request, THE Server SHALL discard the result of that request and send no Analysis or Order_Preview for it.
9. WHEN an Analysis returns an Order_Preview, THE Copilot SHALL display the Order_Preview with confirm and discard actions as defined in HT Req 22.
10. IF the Scan opportunities action would exceed the limits in Requirement 4, criteria 8 and 9, THEN THE Server SHALL reject the action with the matching reason and run no partial scan.

### Markets, Venues, and Paper Execution

### Requirement 8: Instrument Set

**User Story:** As a trader, I want ten symbols, including major coins and memecoins, with tick and lot sizes that fit each price, so that low-priced coins are not rounded away.

#### Acceptance Criteria

1. THE Instrument_Table SHALL define the symbols BTC-USD, ETH-USD, SOL-USD, BNB-USD, XRP-USD, DOGE-USD, JUP-USD, WIF-USD, BONK-USD, and PEPE-USD.
2. THE Instrument_Table SHALL define for each symbol its own tick size and lot size, so that the tick size is at most 0.02 percent of the symbol's reference price recorded in the Instrument_Table, the lot size is no coarser than the finest quantity increment of any Venue that lists the symbol, and the sum of the price decimals and the quantity decimals does not exceed the 10 decimals of Money.
3. THE Instrument_Table SHALL replace the fixed 2 price decimals and 8 quantity decimals of HT Req 44, criterion 3, and every component that converts decimals SHALL read tick size and lot size from the Instrument_Table.
4. THE Venue_Symbol_Map SHALL list for each symbol and each Venue the Venue's symbol or token mint address, or SHALL mark the symbol as not listed on that Venue.
5. THE Venue_Symbol_Map SHALL hold only addresses that appear in the committed map, and THE Server SHALL read no mint address from client input, LLM output, or news data.
6. IF a Client subscribes to a symbol that the Instrument_Table lacks, THEN THE Engine SHALL emit an Error Event that names the symbol.
7. WHEN the Market_Feed starts a Venue, THE Market_Feed SHALL log, for each mapped symbol, the Venue's symbol or mint address and any tick or lot size mismatch against the Instrument_Table.
8. FOR ALL symbols in the Instrument_Table and all decimal strings that are whole multiples of the symbol's tick or lot, converting the string to Ticks or Lots and back to a decimal string SHALL produce a string with the same numeric value (round-trip property).
9. THE Demo Fixture in `fixtures/` SHALL hold market data for every symbol in the Instrument_Table, so that replay mode shows all ten symbols with no API key.

### Requirement 9: Multi-Venue Feed and Venue Status

**User Story:** As a trader, I want several exchanges feeding the terminal at once with a clear status, so that I can compare prices and see which feeds are healthy.

#### Acceptance Criteria

1. WHERE DATA_MODE is set to live, THE Market_Feed SHALL connect to every Venue named in LIVE_VENUES, which accepts a comma-separated list of `coinbase`, `backpack`, `jupiter`, and `raydium` and defaults to all four.
2. THE Server SHALL accept LIVE_VENUE with a single value as an alias for LIVE_VENUES with that one value, and SHALL log the use of the alias.
3. IF LIVE_VENUES names an identifier that is not `coinbase`, `backpack`, `jupiter`, or `raydium`, THEN THE Server SHALL log the variable name and exit with a non-zero status code.
4. THE Engine SHALL keep a separate Order_Book, last price, and Candle_Builder state for each pair of Venue and symbol.
5. WHERE DATA_MODE is unset or set to replay, THE Market_Feed SHALL serve every symbol from the Venue `replay`, and the Web_UI SHALL show the Exchange_Chips of the four live Venues as disabled with the text "live mode only".
6. WHEN a Venue's connection or poll fails, THE Market_Feed SHALL set that Venue's Venue_Status to `down`, emit an Error Event that names the Venue, and retry with exponential backoff starting at 500 ms and capped at 30 seconds, while every other Venue continues.
7. WHEN the Market_Feed has received no message or Price_Sample for a symbol and Venue for longer than the staleness limit of 15 seconds for a CEX Venue or 20 seconds for a DEX Venue, THE Market_Feed SHALL set that Venue_Status to `stale` until the next message or Price_Sample arrives.
8. THE Engine SHALL emit a VenueStatus Event for each Venue whenever the Venue_Status changes, and THE Server SHALL include the current Venue_Status of every Venue in the Hello Server_Message.
9. THE Web_UI and THE TUI SHALL each display the count of Live_Venues with Venue_Status `connected` and the count of Live_Venues as "N/M Exchanges".
10. WHEN a Client subscribes to a symbol, THE Client SHALL name a Venue, and THE Engine SHALL send market data for that Venue and symbol only.
11. THE Engine SHALL select the Reference_Venue of each symbol as defined in the Glossary and use its Mark_Price as defined in the Glossary.
12. THE Venue_Kind of each Venue SHALL be the value defined in the Glossary, and the Exchange_Chips All, CEX, and DEX SHALL filter the Venue list by Venue_Kind.

### Requirement 10: Jupiter Price Feed

**User Story:** As a Solana trader, I want Jupiter prices in the terminal, so that I can see DEX prices next to exchange prices.

#### Acceptance Criteria

1. WHERE the Live_Venues include `jupiter`, THE Jupiter_Adapter SHALL poll the Jupiter Price API v3 with one batched request for all symbols listed in the Venue_Symbol_Map for Jupiter.
2. THE Jupiter_Adapter SHALL request no Jupiter URL other than `https://api.jup.ag/price/v3` and SHALL call no swap, order, execute, quote-to-transaction, or any other endpoint that builds a transaction.
3. WHEN JUPITER_API_KEY is unset, THE Jupiter_Adapter SHALL send requests without a key at no more than one request every 2 seconds.
4. WHERE JUPITER_API_KEY is set, THE Jupiter_Adapter SHALL send its value in the `x-api-key` request header and nowhere else, and SHALL use the poll interval JUPITER_POLL_MS, which defaults to 1000 ms and is at least 500 ms.
5. IF the Jupiter Price API responds with HTTP status 429, THEN THE Jupiter_Adapter SHALL wait at least the number of seconds in the Retry-After header, or the current backoff delay when the header is absent, before the next request.
6. WHEN the Jupiter_Adapter receives a price response, THE Jupiter_Adapter SHALL validate the response with Zod, convert each price to a Price_Sample with the internal symbol, and discard a price that is not a positive finite number.
7. THE Jupiter_Adapter SHALL exclude the value of JUPITER_API_KEY from all log output and all responses.

### Requirement 11: Raydium Price Feed

**User Story:** As a Solana trader, I want Raydium prices in the terminal, so that I can see a second DEX source.

#### Acceptance Criteria

1. WHERE the Live_Venues include `raydium`, THE Raydium_Adapter SHALL poll `GET /mint/price` on `https://api-v3.raydium.io` with one batched request for all symbols listed in the Venue_Symbol_Map for Raydium, at the poll interval RAYDIUM_POLL_MS, which defaults to 3000 ms and is at least 1000 ms.
2. WHERE the Live_Venues include `raydium`, THE Raydium_Adapter SHALL read pool liquidity with `GET /pools/info/mint` on `https://api-v3.raydium.io` to size the Synthetic_Book as defined in Requirement 12, at most once every 60 seconds per symbol, and SHALL fall back to the default level size when the liquidity request fails.
3. THE Raydium_Adapter SHALL send only HTTP GET requests, and only to the paths `/mint/price` and `/pools/info/mint` on `https://api-v3.raydium.io`.
4. THE Raydium_Adapter SHALL contact no Raydium host other than `api-v3.raydium.io`, in particular not `transaction-v1.raydium.io`, and SHALL call no endpoint that builds, serializes, or returns a transaction.
5. IF the Raydium_Adapter receives a response that contains a transaction field, THEN THE Raydium_Adapter SHALL discard the whole response, log the Venue name, and set the Venue_Status to `down`.
6. WHEN the Raydium_Adapter receives a price response, THE Raydium_Adapter SHALL validate the response with Zod, convert each price to a Price_Sample with the internal symbol, and discard a price that is not a positive finite number.
7. IF Raydium responds with HTTP status 429, THEN THE Raydium_Adapter SHALL back off exponentially from 1 second to a cap of 30 seconds.

### Requirement 12: Synthetic Book and DEX Paper Fills

**User Story:** As a trader, I want paper orders on DEX venues to fill at believable prices, so that DEX paper trading includes spread and slippage.

#### Acceptance Criteria

1. WHEN the Engine receives a Price_Sample for a symbol and DEX Venue, THE Engine SHALL replace the Synthetic_Book of that pair with a book that has DEX_LEVELS levels per side, which defaults to 10.
2. THE Engine SHALL place the best bid at the sample price minus half of DEX_SPREAD_BPS and the best ask at the sample price plus half of DEX_SPREAD_BPS, where DEX_SPREAD_BPS defaults to 10 basis points.
3. THE Engine SHALL space each further level by DEX_STEP_BPS from the previous level on the same side, which defaults to 5 basis points.
4. THE Engine SHALL give each level the quantity whose notional is DEX_LEVEL_NOTIONAL at the sample price, which defaults to 25,000 USD, or the notional derived from pool liquidity when the Raydium_Adapter provides it.
5. THE Engine SHALL round each Synthetic_Book price to the nearest tick of the symbol, with bids rounded down and asks rounded up, and SHALL keep the best bid below the best ask.
6. THE Matcher SHALL fill a paper order on a DEX Venue against the Synthetic_Book of that Venue and symbol with the existing matching rules of HT Req 11 and 12, and no other fill path.
7. THE Engine SHALL tag the Fill Events, Trade Events, and Book Events that derive from a Synthetic_Book with the Venue and a `synthetic` marker, and THE Web_UI and THE TUI SHALL label DEX book data "simulated depth".
8. WHEN a paper order fills against a Synthetic_Book, THE Matcher SHALL leave the Synthetic_Book unchanged until the next Price_Sample replaces the book.
9. THE Engine SHALL convert a DEX Price_Sample to Ticks by rounding to the nearest tick, and the rule in tech.md that venue values that do not fit exactly are dropped SHALL apply to CEX Venues only.
10. FOR ALL Price_Samples and DEX parameters, the Synthetic_Book SHALL have every level quantity greater than zero, a best bid below the best ask, bid prices strictly descending, and ask prices strictly ascending (invariant).
11. FOR ALL Price_Samples and DEX parameters, building the Synthetic_Book twice from the same inputs SHALL produce equal books (determinism property).
12. FOR ALL market buy orders against a Synthetic_Book, the quantity-weighted average fill price SHALL be at least the Price_Sample price, and for market sell orders at most the Price_Sample price (slippage direction property).

### Requirement 13: DEX Candles and Venue History

**User Story:** As a trader, I want candles for every venue, and history from public APIs where available, so that charts are never empty and never need stored data.

#### Acceptance Criteria

1. WHEN the Engine receives a Price_Sample, THE Candle_Builder SHALL update the candles of that Venue and symbol as for a trade with the sample price and zero quantity.
2. THE Engine SHALL not emit a Trade Event for a Price_Sample.
3. THE Web_UI and THE TUI SHALL show volume as "n/a" for candles of a DEX Venue.
4. WHEN a Client subscribes to a symbol, Venue, and Timeframe, THE Engine SHALL backfill candle history for the pair from the Venue's public REST API, as HT Req 5, criterion 2, and HT Req 43, criterion 2 define for Coinbase and Backpack.
5. WHERE a Venue offers no public candle history endpoint for a symbol, THE Engine SHALL send only candles built since the Venue's feed started, and THE Client SHALL display "history unavailable" for that pair.
6. WHERE a DEX Venue offers no candle history, THE Engine SHALL offer the user a switch to the Reference_Venue of the symbol and SHALL NOT merge candles of different Venues into one series.
7. THE Engine SHALL fetch backfill candles only from the public endpoints in the Endpoint_Allowlist.
8. FOR ALL sequences of Price_Samples, every candle SHALL satisfy low ≤ open ≤ high and low ≤ close ≤ high and SHALL have volume zero (invariant).

### Requirement 14: Read-Only Market Data Guard

**User Story:** As a safety-minded operator, I want a hard guarantee that new venues only ever return prices, so that nothing in the system can build or send a transaction.

#### Acceptance Criteria

1. THE Server and THE Engine SHALL request exchange and news hosts only at the exact hosts and path prefixes in the Endpoint_Allowlist: Coinbase and Backpack public market-data endpoints as in HT Req 5 and 43, `https://api.jup.ag/price/v3`, `GET https://api-v3.raydium.io/mint/price`, `GET https://api-v3.raydium.io/pools/info/mint`, `https://newsapi.org/v2/`, and `https://cryptopanic.com/api/`.
2. THE Market_Feed SHALL send only HTTP GET requests, plus WebSocket subscription messages, to Venue hosts.
3. IF code requests a host or path outside the Endpoint_Allowlist, THEN THE HTTP client wrapper SHALL refuse the request, log the host, and make no network call.
4. THE Repository SHALL contain an automated test that fails when any source file outside the Endpoint_Allowlist module names a Venue host or when any source file references the strings `signTransaction`, `sendTransaction`, `VersionedTransaction`, `swapTransaction`, `/swap/v2/order`, `/execute`, or `/transaction/`.
5. THE Oni_Terminal SHALL ask no Wallet to sign a transaction, SHALL build no Solana transaction, and SHALL contact no Solana RPC endpoint, as HT Req 49 requires.
6. IF the last price of a symbol on a DEX Venue deviates by more than DEX_MAX_DEVIATION_PCT, which defaults to 5 percent, from the Mark_Price of the symbol's CEX Reference_Venue, THEN THE Engine SHALL set that pair's market data status to `suspect`, and THE Router SHALL reject paper orders on that pair with the reason price_deviation until the deviation falls below the limit.
7. IF a paper order targets a Venue and symbol whose last price is older than the staleness limit in Requirement 9, criterion 7, THEN THE Risk_Engine SHALL reject the order with the reason stale_market_data.
8. IF a paper order targets a Venue whose Venue_Status is `down` or `disabled`, or a symbol that the Venue_Symbol_Map marks as not listed on that Venue, THEN THE Risk_Engine SHALL reject the order with the reason venue_unavailable.
9. FOR ALL URLs, THE HTTP client wrapper SHALL permit exactly the URLs that match the Endpoint_Allowlist and refuse every other URL (allowlist property).
10. THE Server SHALL request LLM provider hosts only at `https://api.openai.com`, `https://api.anthropic.com`, the host of NVIDIA_BASE_URL, and the host of OLLAMA_BASE_URL, through the same HTTP client wrapper, and SHALL accept no provider URL that contains embedded credentials.

### Requirement 15: Venue-Aware Orders

**User Story:** As a trader, I want each order to fill against the exchange I picked, so that the order book I see is the one that fills my order.

#### Acceptance Criteria

1. THE Protocol_Crate SHALL include a Venue field in the PlaceOrder Command and in the OrderAck, OrderRejected, and Fill Events, and SHALL define Subscribe, Book, Trade, Candle, Indicators, and Ticker24h with a Venue field.
2. THE Router SHALL set the Venue of a PlaceOrder Command from the confirmed Order_Preview, and the Order_Preview SHALL take the Venue from the Client's Active_Venue, validated against the Venue identifiers.
3. THE Matcher SHALL fill each paper order only against the Order_Book or Synthetic_Book of the order's Venue and symbol.
4. THE Matcher SHALL trigger a stop order when the last trade price or Price_Sample of the order's Venue and symbol reaches or crosses the stop price.
5. THE Risk_Engine SHALL evaluate the price band of HT Req 19, criterion 4, against the last price of the order's Venue and symbol.
6. THE Engine SHALL keep one Position per symbol and Account_Id, and SHALL combine fills from all Venues into that Position.
7. THE Engine SHALL compute unrealized P&L and Equity from the Mark_Price of the symbol.
8. THE Router SHALL reject an order whose Venue is missing or not one of the Venue identifiers with the reason venue_unavailable.
9. THE Risk_Engine SHALL add the reasons venue_unavailable, stale_market_data, price_deviation, and insufficient_balance to the rejection reasons of HT Req 19.
10. FOR ALL interleaved sequences of market data for several Venues and order Commands, every Fill Event SHALL carry the Venue of its order and a price taken from that Venue's book (venue routing property).

### Requirement 16: Paper Balance, Equity, and Insufficient-Balance Rejection

**User Story:** As a trader, I want a paper balance that limits what I can buy or short, so that the percentage slider, the Balances tab, and my orders behave like a real account.

Today's account model (`rust/crates/engine/src/account.rs`) holds signed Positions per symbol, with cost basis and realized P&L, and no cash balance. A sell larger than a long Position already opens a short Position, and no check limits the size of any order except the Risk_Limits of HT Req 19. This requirement adds a cash balance and one rule that keeps the balance honest: the Paper_Account must be able to pay for what an order opens.

#### Acceptance Criteria

1. WHEN the Engine creates or resets a Paper_Account, THE Engine SHALL set the Paper_Balance to the Starting_Balance.
2. THE Engine SHALL read the Starting_Balance from STARTING_BALANCE, which defaults to 100000 and is an integer from 1,000 to 100,000,000.
3. WHEN a fill buys quantity q at price p with fee f, THE Engine SHALL reduce the Paper_Balance by p × q + f, and WHEN a fill sells quantity q at price p with fee f, THE Engine SHALL increase the Paper_Balance by p × q − f.
4. THE Engine SHALL include the Paper_Balance, the Free_Balance, and Equity in a new Balance Event for the Account_Id after each fill, after each order acceptance or cancellation that changes the Reserved_Balance, and after each Mark_Price change that moves Equity by at least 0.01 USD.
5. IF the Free_Balance of a Paper_Account minus the Required_Funds of an order, computed as criterion 6 defines, is below zero, THEN THE Risk_Engine SHALL reject the order with the reason insufficient_balance.
6. THE Risk_Engine SHALL compute the Required_Funds of an order as the amount by which a full fill of the order would reduce the quantity Paper_Balance minus twice the Short_Basis, counting the fee at the configured fee rate, where the fill price is the order's reference price increased by BALANCE_SLIPPAGE_BPS for a buy and decreased by BALANCE_SLIPPAGE_BPS for a sell, BALANCE_SLIPPAGE_BPS defaults to 100 basis points, and a negative Required_Funds means that the order raises the Free_Balance.
7. WHEN the Engine receives a PlaceOrder Command, THE Engine SHALL apply criteria 5 and 6 with its own Paper_Balance and open orders and, if the Free_Balance would be negative, SHALL emit an OrderRejected Event with the reason insufficient_balance and accept no order.
8. THE Oni_Terminal SHALL allow a sell that exceeds the long Position, which opens or grows a short Position, only to the extent that criterion 5 allows, and SHALL simulate no margin call, no liquidation, and no borrowing cost.
9. WHEN the Router sends a child order of a TWAP_Order, THE Risk_Engine SHALL apply criterion 5 to that child order at its scheduled time.
10. FOR ALL fill sequences of one Account_Id, Equity SHALL equal Starting_Balance plus the sum over symbols of realized P&L plus unrealized P&L (accounting invariant).
11. FOR ALL fill sequences, a buy of quantity q at b followed by a sell of q at s SHALL change the Paper_Balance by (s − b) × q − total fees (round-trip property).
12. FOR ALL Paper_Account states and order requests, every order that the Risk_Engine approves SHALL leave the account with a Free_Balance of at least zero when the order fills in full at its reference price adjusted by BALANCE_SLIPPAGE_BPS (balance invariant).
13. FOR ALL Paper_Account states with a Free_Balance of at least zero, a sell that only closes part or all of a long Position and whose proceeds cover its fee SHALL NOT be rejected with the reason insufficient_balance (exit-always-possible property).

### Requirement 17: TWAP Orders

**User Story:** As a trader, I want a TWAP order type, so that I can spread a larger paper order over time.

#### Acceptance Criteria

1. THE Command_Parser SHALL accept the form `BUY|SELL <symbol> <quantity> TWAP <slices> <seconds>` with case-insensitive keywords, where slices is an integer from 2 to 20 and seconds is an integer from 5 to 3,600, and THE Command_Formatter SHALL format each parsed TWAP command as canonical text.
2. WHEN the Command_Parser receives a well-formed TWAP command, THE Command_Parser SHALL return one Order_Preview that shows the TWAP_Plan with total quantity, slice quantity, slice count, interval, symbol, side, and Venue.
3. WHEN the user confirms a TWAP Order_Preview, THE Router SHALL accept the TWAP_Order once and schedule one child market order per slice at equal intervals, the first child order immediately.
4. THE Router SHALL submit each child order to the Risk_Engine at its scheduled time and send it to the Engine only after the Risk_Engine approves it, with the Account_Id of the confirming connection's Connection_Session at confirmation time.
5. IF the Risk_Engine rejects a child order, THEN THE Router SHALL cancel all remaining child orders of the TWAP_Order and emit an OrderRejected Event with the rejection reason.
6. WHEN the confirming connection closes, the Connection_Session changes Account_Id, or the Engine restarts, THE Router SHALL cancel all remaining child orders of the TWAP_Order.
7. WHEN the user cancels a TWAP_Order, THE Router SHALL cancel all remaining child orders and send no further child order.
8. THE Router SHALL allow at most 3 active TWAP_Orders per Account_Id and SHALL reject another with the reason max_open_orders.
9. THE Client SHALL display each active TWAP_Order with the number of slices sent and a cancel action in the Orders tab.
10. WHILE the Kill_Switch is enabled, THE Router SHALL send no child order and SHALL cancel all active TWAP_Orders.
11. THE Router SHALL give the slice quantities integer Lots that sum to the total quantity, with the last slice holding the remainder.
12. FOR ALL TWAP commands, formatting and then parsing SHALL produce a command equal to the original (round-trip property).
13. FOR ALL TWAP_Plans, the sum of the child order quantities SHALL equal the total quantity and every child order quantity SHALL be at least one Lot (conservation property).

### Requirement 18: Timeframes and 24-Hour Statistics

**User Story:** As a trader, I want a 4h timeframe and 24-hour statistics, so that the chart and the symbol header match the mockup.

#### Acceptance Criteria

1. THE Candle_Builder SHALL provide the Timeframes 1m, 5m, 15m, 1h, 4h, and 1d aligned to UTC boundaries, and this criterion SHALL replace the Timeframe lists of HT Req 8, criterion 3, and HT Req 25, criterion 2.
2. THE Candle_Builder SHALL build 4h candles from 1h candles aligned to 00:00, 04:00, 08:00, 12:00, 16:00, and 20:00 UTC.
3. WHEN a Client subscribes to a symbol and Venue, THE Engine SHALL emit a Ticker24h Event with the open, high, low, last price, base volume, and percentage change over the previous 24 hours, computed from the candles of that Venue and symbol, and SHALL emit a new Ticker24h Event at most once per second while the values change.
4. WHERE a pair has candles that cover less than 24 hours, THE Engine SHALL compute the Ticker24h from the available candles and mark it `partial`.
5. THE Web_UI SHALL show the keys 1 through 6 as the Timeframe keys in the order 1m, 5m, 15m, 1h, 4h, 1d, in the keymap context `chart`.
6. FOR ALL trade sequences, 4h candles aggregated from 1h candles SHALL equal 4h candles built directly from the same trades (model-based property).
7. FOR ALL candle sequences covering at least 24 hours, the Ticker24h high SHALL equal the maximum candle high in the window and the low SHALL equal the minimum candle low (invariant).

### News

### Requirement 19: News Provider and Cache

**User Story:** As a trader, I want crypto news in the terminal, so that I can see events that may move prices.

#### Acceptance Criteria

1. THE Server SHALL define one News_Provider interface that returns a validated list of News_Items for an optional symbol list.
2. THE Server SHALL provide News_Provider implementations with the identifiers `newsapi` and `cryptopanic`.
3. THE Server SHALL select the News_Provider from NEWS_PROVIDER, which accepts `newsapi`, `cryptopanic`, and `none`, and defaults to `newsapi` when NODE_ENV is not `production` and NEWS_API_KEY is set, to `cryptopanic` when NODE_ENV is `production` and CRYPTOPANIC_API_KEY is set, and to `none` otherwise.
4. THE `newsapi` implementation SHALL call the NewsAPI `everything` endpoint at `https://newsapi.org/v2/` using NEWS_API_KEY sent in the `X-Api-Key` request header, with a query for the symbols' coin names, sorted by published time.
5. THE `cryptopanic` implementation SHALL call `GET https://cryptopanic.com/api/<plan>/v2/posts/` with CRYPTOPANIC_API_KEY as the `auth_token` query parameter and the plan named by CRYPTOPANIC_PLAN, which accepts `developer`, `growth`, and `enterprise` and defaults to `developer`.
6. THE Server SHALL read NEWS_PROVIDER, NEWS_API_KEY, CRYPTOPANIC_API_KEY, and CRYPTOPANIC_PLAN from environment variables only.
7. THE Server SHALL exclude the values of NEWS_API_KEY and CRYPTOPANIC_API_KEY from all log output, all responses, and all Server_Messages, and the Web_UI and the TUI SHALL never receive, store, or send a news API key.
8. THE News_Cache SHALL serve every Client from one cached result per News_Provider and query, refreshed at most once every NEWS_TTL_SECONDS, which defaults to 900 and is an integer from 300 to 3,600.
9. THE Server SHALL send no more than 80 requests per UTC day to NewsAPI and SHALL serve the News_Cache after reaching that limit.
10. WHEN the Server receives a SubscribeNews Client_Message, THE Server SHALL send the cached News_Items, with at most 30 items, ordered by published time in descending order, and send an update when the News_Cache refreshes.
11. THE Server SHALL validate every News_Provider response with Zod, keep only items whose URL has the scheme `http` or `https`, truncate titles to 200 characters, and drop items without a title or a published time.
12. IF a News_Provider request fails or returns a status other than 200, THEN THE Server SHALL keep serving the previous News_Cache, log the provider name and the status, and retry after the next TTL interval or after an exponential backoff capped at 30 minutes.
13. WHERE the News_Provider is `none` or the News_Cache is empty after a failure, THE Client SHALL show "News unavailable" in the News panel.
14. THE Client SHALL render News_Item titles as plain text and open a News_Item URL only on user click, in a new browser tab with `rel="noopener noreferrer"` in the Web_UI.
15. FOR ALL News_Provider responses, THE Server SHALL send to Clients only News_Items that satisfy the News_Item schema, with at most 30 items, none older than the cache refresh that produced them, and no field that holds an API key (sanitization property).

### Requirement 20: News Terms and Hosted Deployment

**User Story:** As an operator, I want the hosted deploy to respect each news provider's terms, so that production never uses a key plan that forbids it.

#### Acceptance Criteria

1. WHERE NODE_ENV is `production` and NEWS_PROVIDER is `newsapi`, THE Server SHALL log a warning that the NewsAPI Developer plan permits development use only, and SHALL disable the provider by setting the News_Provider to `none`.
2. WHERE NODE_ENV is `production` and NEWS_PROVIDER is `newsapi`, THE Server SHALL honour an explicit override NEWS_ALLOW_NEWSAPI_IN_PRODUCTION set to `true`, which the operator sets only for a NewsAPI plan that allows production use.
3. THE Render_Blueprint SHALL declare CRYPTOPANIC_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, NVIDIA_API_KEY, and JUPITER_API_KEY for oni-server with `sync: false` and SHALL declare no NEWS_API_KEY value.
4. THE Repository README SHALL state that NewsAPI is for local development, that CryptoPanic serves the hosted deploy, that news on the hosted deploy may be unavailable when CRYPTOPANIC_API_KEY is unset, and that the Developer plan delays articles by about 24 hours.
5. THE Repository SHALL contain `server/.env.example` with every new variable listed and no real value.
6. THE Repository SHALL exclude every `.env` file from version control.

### Web UI Layout

### Requirement 21: App Shell and Navigation

**User Story:** As a user, I want a familiar app frame with top navigation and a sidebar, so that I can move between pages without losing my connection.

#### Acceptance Criteria

1. THE Web_UI App_Shell SHALL show a top navigation bar with the items Trade, Markets, Strategies, AI Copilot, Backtest, and Logs.
2. THE Web_UI App_Shell SHALL show a left sidebar with the items Dashboard, Trade, Markets, Strategies, AI Copilot, Backtest, Portfolio, Logs, and Settings.
3. THE Web_UI SHALL give each page a distinct static route, so that the static export builds one HTML file per page and every page works when opened directly by URL.
4. WHEN the user navigates between pages, THE Web_UI SHALL keep the WebSocket connection, the Connection_Session, and the market data store, and SHALL open no second WebSocket connection.
5. THE Web_UI App_Shell SHALL highlight the current page in the top navigation and the sidebar.
6. THE Web_UI App_Shell SHALL show on the right of the top navigation: the data mode indicator (LIVE or REPLAY), the "N/M Exchanges" count, the Latency_Readout, a notification bell, a settings gear that opens the Settings_Page, and the account control with the wallet avatar or GUEST label.
7. THE Web_UI SHALL take every color from `web/lib/theme.ts` and `web/app/globals.css`, and SHALL NOT hard-code a color value in a component.
8. THE Web_UI SHALL be fully operable with mouse and keyboard, and SHALL give every interactive element a visible focus state and a keyboard-reachable control.
9. WHEN the user activates the notification bell, THE Web_UI SHALL show the most recent 50 Notice, OrderRejected, Fill, and venue status messages of the current page load.
10. THE Web_UI SHALL replace the Timeframe key rule of HT Req 25, criterion 3, and the panel layout of HT Req 25 through 31 with Requirements 21 through 29, while keeping the behaviour of HT Req 29 through 31 for chart zoom, pan, order entry shortcuts, and the Command_Bar.

### Requirement 22: Exchange Chips and Symbol Header

**User Story:** As a trader, I want to filter by exchange type and see the symbol's 24-hour numbers at the top, so that I know where I am trading.

#### Acceptance Criteria

1. THE Web_UI SHALL show the Exchange_Chips All, CEX, and DEX, then one chip each for Backpack, Coinbase, Jupiter, and Raydium, then Binance and Bybit as disabled chips with the text "Not available", then a "+ Add" chip.
2. WHEN the user clicks the chip All, THE Web_UI SHALL set the Active_Venue to the Reference_Venue of the selected symbol.
3. WHEN the user clicks the chip CEX or DEX, THE Web_UI SHALL limit the venue chips and the Markets table to Venues of that Venue_Kind and set the Active_Venue to the first connected Venue of that kind that lists the selected symbol.
4. WHEN the user clicks a Venue chip, THE Web_UI SHALL set the Active_Venue to that Venue, resubscribe to the selected symbol and Timeframe on that Venue, and switch the chart, order book, trades tape, and order ticket to it.
5. THE Web_UI SHALL mark each Venue chip with its Venue_Status and SHALL disable a chip whose Venue is `down`, `disabled`, or does not list the selected symbol.
6. WHEN the user clicks the chip "+ Add", THE Web_UI SHALL open a dialog that lists the Venues of this release, marks Binance and Bybit as "Not available in this release", and accepts no API key, address, or credential.
7. THE Web_UI SHALL show a symbol header with the symbol pair, the last price, and the 24-hour change, high, low, and volume from the Ticker24h Event of the Active_Venue and symbol.
8. THE Web_UI SHALL show the symbol pair in the form `BTC/USD` using the internal symbol, and SHALL show the Venue name next to it.
9. WHEN the Active_Venue is a DEX, THE Web_UI SHALL show the label "simulated depth" next to the order book and "n/a" as the 24-hour volume when the Ticker24h has no volume.

### Requirement 23: Chart Types, Timeframes, and Drawing Tools

**User Story:** As a trader, I want several chart types and, if time allows, basic drawing tools, so that I can mark levels on the chart.

**Priority:** Criteria 1 through 4, 8, and 9 are in scope. Criteria 5 through 7 (the Drawing_Tools) are optional and the lowest priority of this spec. They are the first scope item to cut, and cutting them changes no other requirement.

#### Acceptance Criteria

1. THE Web_UI SHALL offer the Chart_Types candles, line, area, and Heikin-Ashi, and the Timeframe buttons 1m, 5m, 15m, 1h, 4h, and 1D.
2. WHEN the user selects a Chart_Type, THE Web_UI SHALL redraw the chart for that Chart_Type from the same candle data, without a new subscription.
3. THE Web_UI SHALL compute Heikin-Ashi candles from the candles of the Active_Venue with the standard formulas, and SHALL send the Heikin-Ashi values to no Engine, Router, or order function.
4. THE Web_UI SHALL draw the volume histogram and the indicator overlays and sub-panes of HT Req 26 under every Chart_Type.
5. WHERE the optional Drawing_Tools are built, THE Web_UI SHALL offer the Drawing_Tools horizontal line, trend line, and clear all, and a crosshair mode as the default tool.
6. WHERE the optional Drawing_Tools are built, WHEN the user draws with a Drawing_Tool, THE Web_UI SHALL store the drawing in the browser's local storage under a key made of the symbol, Venue, and Timeframe, and SHALL store no drawing on the Server.
7. WHERE the optional Drawing_Tools are built, WHEN the user clicks a horizontal line drawing, THE Web_UI SHALL offer to prefill the order ticket's limit price with the line's price, and SHALL send no order request.
8. THE TUI SHALL offer the Chart_Types candles and line, selectable with the key `c` and a click on the chart type label.
9. THE Web_UI SHALL persist the selected Chart_Type, symbol, Timeframe, and Active_Venue in local storage and restore them on the next load.

### Requirement 24: Order Ticket

**User Story:** As a trader, I want one order ticket with Buy and Sell, order types, a percentage slider, and a total, so that I can size and place an order quickly.

#### Acceptance Criteria

1. THE Web_UI order ticket SHALL show Buy and Sell toggles, the order types Limit, Market, Stop, and TWAP, a price field, a quantity field, a percentage slider, and a total field.
2. WHEN the user moves the percentage slider to p percent, THE order ticket SHALL set the quantity for a Buy to the Lot-rounded-down quantity whose notional at the ticket price equals p percent of the Free_Balance of the Paper_Account, and for a Sell to p percent of the current Position of the selected symbol rounded down to a whole Lot, and SHALL cap the quantity at the maximum order value of the Risk_Limits.
3. THE order ticket SHALL show the total as price × quantity in USD and the estimated fee, and SHALL update both on each change of price or quantity.
4. WHEN the order type is Market, THE order ticket SHALL use the best ask for a buy or the best bid for a sell of the Active_Venue as the total's price.
5. WHEN the order type is TWAP, THE order ticket SHALL show fields for the slice count and the interval in seconds.
6. WHEN the user activates the Buy or Sell submit button, THE Web_UI SHALL send the ticket as command text to the Server and display the returned Order_Preview with confirm and discard actions, and SHALL send no PlaceOrder request before the user confirms.
7. THE order ticket SHALL show the available Paper_Balance and the current Position of the selected symbol.
8. WHEN the user clicks an order book price, THE order ticket SHALL set the order type to Limit and the price to that price, as HT Req 30, criterion 1, defines.
9. IF the Server returns a parse error or an OrderRejected Event for the ticket, THEN THE Web_UI SHALL display the error or reason next to the ticket and keep the ticket values.
10. FOR ALL ticket values, the command text that the order ticket produces SHALL parse with the Command_Parser to an Order_Preview with the same side, symbol, type, quantity, and price, or to a parse error that names the offending value (ticket round-trip property).

### Requirement 25: Order Book, Trades, and Bottom Tabs

**User Story:** As a trader, I want the book and tape beside the chart and my account tabs underneath, so that everything I need is on one screen.

#### Acceptance Criteria

1. THE Web_UI SHALL show an Order Book tab and a Trades tab beside the chart, with the Order Book tab as the default.
2. THE Web_UI Order Book tab SHALL show depth bars, the spread, and the imbalance as HT Req 27 requires, for the Active_Venue and symbol.
3. THE Web_UI Trades tab SHALL show the most recent 50 Trade Events of the Active_Venue and symbol with price, quantity, side, and local time.
4. THE Web_UI SHALL show bottom tabs Positions, Orders, Balances, P&L, and Strategies.
5. THE Positions tab SHALL show, for each symbol with a non-zero Position, the signed quantity, average entry price, Mark_Price, realized P&L, and unrealized P&L.
6. THE Orders tab SHALL show the open orders and active TWAP_Orders with a cancel action, and the most recent 50 Activity_Records of kinds fill and rejection of the Paper_Account.
7. THE Balances tab SHALL show the Paper_Balance, the Free_Balance, Equity, and, for each symbol with a non-zero Position, the signed quantity and its value at the Mark_Price.
8. THE P&L tab SHALL show total realized P&L, total unrealized P&L, and total fees of the Paper_Account since the last reset.
9. THE Strategies tab SHALL show the text "Strategies are not available in this release" and no control that places an order.
10. WHEN a Position, OrderAck, Fill, or Balance Event arrives, THE Web_UI SHALL update the tabs as HT Req 28, criterion 3, requires.

### Requirement 26: Watchlist, Portfolio, and News Column

**User Story:** As a trader, I want a watchlist with 24-hour changes and a news list in the right column, so that I can switch symbols and see events.

#### Acceptance Criteria

1. THE Web_UI SHALL show a right column with a Watchlist tab and a Portfolio tab, and a News panel below them.
2. THE Watchlist tab SHALL list all ten symbols with the last price and the 24-hour percentage change of the Reference_Venue, colored by sign using theme tokens, and sorted by the Instrument_Table order.
3. WHEN the user clicks a Watchlist row, THE Web_UI SHALL switch every panel to that symbol, keeping the Active_Venue when that Venue lists the symbol and otherwise using the Reference_Venue.
4. THE Portfolio tab SHALL list the symbols with a non-zero Position, with the quantity, the value at the Mark_Price, and the share of total position value.
5. THE News panel SHALL list News_Items with title, source name, and relative published time, and SHALL highlight items whose related symbols include the selected symbol.
6. WHEN the user clicks a News_Item, THE Web_UI SHALL open the item's URL as Requirement 19, criterion 14, defines.
7. THE Web_UI SHALL label the News panel "News" and show no item type other than News_Items.

### Requirement 27: AI Copilot Panel and Page (Web)

**User Story:** As a trader, I want the AI Copilot beside my chart and on its own page, so that I can ask for analysis without leaving the trade screen.

#### Acceptance Criteria

1. THE Web_UI Trade page SHALL show an AI Copilot panel with a prompt box, a placeholder example "@oni Analyze BTC trend, find a long entry with <2% risk", the Copilot_Actions Analyze BTC, Place trade, Create strategy, and Scan opportunities, and a provider selector.
2. THE Web_UI SHALL label the Analyze action with the selected symbol's base asset.
3. THE Web_UI AI Copilot page SHALL show the same panel at full size with the conversation of the current page load, at most 50 entries.
4. WHEN the Server returns an Analysis, THE Copilot SHALL display it as defined in Requirement 5, criterion 9, and display the Order_Preview of the Analysis, when present, with confirm and discard actions.
5. WHEN the user clicks a symbol or a suggested order in an Analysis, THE Copilot SHALL switch the Active_Venue and symbol or prefill the order ticket, and SHALL send no order request.
6. THE Copilot SHALL display provider errors, validation errors, ai_rate_limit, and ai_daily_cap reasons as readable messages.
7. WHERE no LLM_Provider is available, THE Copilot SHALL show the message "AI features are disabled" and the names of the environment variables the operator sets, and no key input.
8. THE Copilot SHALL keep the prompt text in the prompt box after an error.

### Requirement 28: Simple and Placeholder Pages

**User Story:** As a user, I want every nav item to open a page that works or says clearly that it is not ready, so that nothing looks broken.

#### Acceptance Criteria

1. THE Web_UI Markets page SHALL show a table of all ten symbols with, for each connected Venue, the last price, the 24-hour change, and the 24-hour volume, sortable by each column, with a row click that opens the Trade page for that symbol and Venue.
2. THE Web_UI Portfolio page SHALL show the Paper_Balance, Equity, the Positions, and the P&L figures of Requirement 25.
3. THE Web_UI Logs page SHALL show the Activity_Records of the Paper_Account from `/journal` and live updates, labelled "current run only", with filters for kind and symbol.
4. THE Web_UI Dashboard page SHALL show Equity, the number of open orders, the top three Watchlist movers, and the latest five News_Items.
5. THE Web_UI Settings_Page SHALL show the Provider_Selection, the default Venue, the default Chart_Type, the wallet sign-in control, and the Server URL, and SHALL show no secret.
6. THE Web_UI Strategies page and Backtest page SHALL each show a title, a one-paragraph description of the planned feature, and the text "Not available in this release", and SHALL contain no control that sends an order request.
7. THE Web_UI SHALL load each page without a request to a Venue, a news provider, or an LLM provider, and receive all data through the Server.

### Requirement 29: Header Status and Latency Readout

**User Story:** As a trader, I want to see live status and my connection latency at a glance, so that I know the data is fresh.

#### Acceptance Criteria

1. WHILE the WebSocket connection is open, THE Client SHALL send a Ping Client_Message every 2 seconds and compute the Latency_Readout from the matching Pong Server_Messages.
2. THE Client SHALL display the Latency_Readout in milliseconds, rounded to the nearest whole millisecond, with the unit "ms".
3. WHERE the Latency_Readout exceeds 250 ms, THE Client SHALL color the readout with the theme warning token.
4. WHILE the WebSocket connection is closed, THE Client SHALL display "—" instead of a Latency_Readout and the "waking server" status of HT Req 33.
5. THE Client SHALL display "LIVE" with the Live_Venue names in live mode and "REPLAY" in replay mode, and SHALL display "STALE" when no Venue has Venue_Status `connected`.
6. FOR ALL sequences of Ping and Pong timings, the Latency_Readout SHALL equal the median of the most recent 10 completed round trips, or of all completed round trips when fewer than 10 exist (median property).

### TUI Layout

### Requirement 30: TUI Panels and Menu

**User Story:** As a terminal user, I want the same panels as the web UI in my terminal, so that I can trade from the keyboard with the same view.

#### Acceptance Criteria

1. THE TUI SHALL show a panel menu with the numbered entries [1] Chart, [2] Book, [3] Trades, [4] Positions, [5] Orders, [6] Watchlist, [7] News, and [8] AI Copilot, and SHALL highlight the focused panel.
2. WHEN the user presses a key from 1 to 8 or clicks a menu entry, THE TUI SHALL focus the panel at that position.
3. THE TUI SHALL show the Chart, Book, Positions, Watchlist, News, and AI Copilot panels together on a terminal of at least 140 columns and 40 rows, and SHALL show the focused panel at full size when the terminal is smaller.
4. THE TUI SHALL step the Timeframe with the keys `<` and `>` and by clicking a Timeframe label, since the number keys select panels, and the Keymap SHALL bind each key once per input context.
5. WHEN the user presses F1, THE TUI SHALL show a help overlay that lists every key binding of the Keymap, and SHALL close the overlay on F1 or Esc.
6. THE TUI SHALL provide Venue selection by the key `v` and by clicking the Venue label, with the same Venue list and Venue_Status marks as the Web_UI Exchange_Chips.
7. THE TUI SHALL show the symbol header with the symbol, last price, 24-hour change, high, low, and volume of the Active_Venue.
8. THE TUI SHALL provide the order ticket as a form in the Orders panel with side, type (Limit, Market, Stop, TWAP), price, quantity, percentage, and total, and SHALL show an Order_Preview with confirm and discard actions before any order request.
9. THE TUI SHALL register the panel rectangles and clickable items of every new panel in the Hit_Map as HT Req 35 requires.
10. THE TUI SHALL use only mouse and keyboard input.

### Requirement 31: TUI News and AI Copilot

**User Story:** As a terminal user, I want news and the AI Copilot in the terminal, so that I do not need the browser to get analysis.

#### Acceptance Criteria

1. THE TUI News panel SHALL show News_Items with title, source name, and relative time, and SHALL render titles as plain text with control characters removed.
2. WHEN the user selects a News_Item and presses Enter or clicks it, THE TUI SHALL show the URL of the item and offer to copy it, and SHALL not open a browser.
3. THE TUI AI Copilot panel SHALL show an input line, the four Copilot_Actions as selectable labels, the provider name with a key to change the Provider_Selection, and the latest Analysis.
4. WHEN the user submits text in the TUI AI Copilot panel, THE TUI SHALL send it to the AI_Analyst as Requirement 7 defines.
5. WHEN an Analysis includes an Order_Preview, THE TUI SHALL show the Order_Preview with confirm and discard actions as HT Req 22 requires.
6. THE TUI SHALL send SetProvider and SubscribeNews Client_Messages and shall hold no API key.
7. WHERE no LLM_Provider is available or the News_Provider is `none`, THE TUI SHALL show "AI features are disabled" or "News unavailable" in the respective panel.

### Requirement 32: TUI Header

**User Story:** As a terminal user, I want a header with live status, exchanges, latency, and memory, so that I see system health at a glance.

#### Acceptance Criteria

1. THE TUI SHALL show a header with the data mode (LIVE or REPLAY), the "N/M Exchanges" count, the Latency_Readout, and the resident memory of the TUI process in megabytes.
2. THE TUI SHALL refresh the memory figure at most once every 2 seconds.
3. THE TUI SHALL use the Oni brand colors from `rust/crates/tui/src/brand.rs` for the header and every new panel.
4. THE TUI SHALL redraw at most 30 times per second, as HT Req 34, criterion 3, requires, and SHALL redraw only when the displayed state has changed.

### Latency

### Requirement 33: Latency Targets and Measurement

**User Story:** As a trader, I want the lowest practical delay between the market and my screen, so that the terminal feels instant, and I want that delay measured.

#### Acceptance Criteria

1. THE Server SHALL record in the Latency_Histogram the duration from the Engine's emit time of a market data Event to the time the Server writes the Event to a connection, and the p95 of that duration SHALL be at most 25 ms in the latency benchmark.
2. THE Engine SHALL attach its emit time, in epoch microseconds, to each Event that the Server measures, and THE Protocol_Crate SHALL define the field.
3. WHEN the Server receives a CommandText Client_Message, THE Server SHALL return the Order_Preview or parse error within 50 ms at p95 in the latency benchmark, excluding requests to an LLM_Provider.
4. WHEN the Server receives a Confirm Client_Message for an approved order, THE Server SHALL deliver the OrderAck Event to the connection within 100 ms at p95 in the latency benchmark.
5. THE Server SHALL deliver a market data Event from the Server's receipt of the Engine's line to a loopback Client within 50 ms at p95 in the latency benchmark, including the Flush_Window.
6. THE Repository SHALL provide a script `bun run bench:latency` that starts the Server and the Engine in replay mode, connects loopback clients, subscribes all ten symbols, and prints the p50 and p95 of each measurement in criteria 1, 3, 4, and 5.
7. THE CI_Workflow SHALL run `bun run bench:latency` on one platform and SHALL fail the job when a p95 value exceeds its target in criteria 1, 3, 4, or 5 by more than the factor CI_LATENCY_FACTOR, which defaults to 2.
8. THE Engine SHALL emit at most one Book Event per Venue and symbol in each 50 ms interval, and this criterion SHALL replace the 100 ms interval of HT Req 9, criterion 7.
9. THE Engine SHALL write each Event line to stdout and flush without waiting for a batch to fill.
10. THE Server SHALL parse each Engine line once and share the parsed Event among all connections that receive it.
11. THE Server SHALL answer a Ping Client_Message with a Pong Server_Message without any dependency on the Flush_Window or an LLM request.
12. THE Server SHALL expose the Latency_Histogram p50 and p95 values in the `/health` response, as Requirement 1, criterion 9, defines.

### Requirement 34: Batching and Coalescing

**User Story:** As a user on a slow connection, I want the Server to combine fast market updates, so that the browser and terminal are not flooded.

#### Acceptance Criteria

1. THE Server SHALL collect the Events of each connection during the Flush_Window and send them as one Event_Batch in one WebSocket frame.
2. WHEN the connection's Event queue holds an OrderAck, OrderRejected, Fill, Position, Balance, or Notice, THE Server SHALL flush the Event_Batch at once without waiting for the end of the Flush_Window.
3. WHEN a Flush_Window holds several Coalescible_Events with the same key, THE Server SHALL send only the latest of them.
4. THE Server SHALL NOT coalesce Trade Events, Fill Events, OrderAck Events, OrderRejected Events, Position Events, Balance Events, and News updates.
5. THE Server SHALL keep the relative order of all Events in an Event_Batch that it does not coalesce.
6. THE Server SHALL send no Event_Batch with more than 200 Events or 256 KB, and SHALL split a larger batch in order.
7. THE Server SHALL disable per-message compression for Event_Batches smaller than 1 KB.
8. WHILE the buffered outgoing bytes of a connection exceed 1 MB, THE Server SHALL drop Coalescible_Events of that connection that are older than the latest of their key and send a Notice with the kind slow_client.
9. IF the buffered outgoing bytes of a connection exceed 4 MB, THEN THE Server SHALL close the connection with a close code that tells the Client to reconnect.
10. THE Web_UI and THE TUI SHALL accept both single Server_Messages and Event_Batches.
11. FOR ALL sequences of Events and Flush_Windows, applying the coalesced batches to a Client state SHALL produce a state equal to applying every Event in order (coalescing equivalence property).
12. FOR ALL sequences of Events, the Events that are not Coalescible_Events SHALL appear in the output in the same order and the same number as in the input (ordering invariant).
13. FOR ALL sequences of Events, an OrderAck, OrderRejected, Fill, Position, or Balance Event SHALL leave the Server no later than the Flush_Window after its arrival, and the Server SHALL flush at once as criterion 2 defines (urgent delivery property).

### Requirement 35: Render Efficiency

**User Story:** As a user, I want the interface to stay smooth under fast data, so that the screen never lags behind the market.

#### Acceptance Criteria

1. THE Web_UI SHALL apply all Events of one Event_Batch to the zustand store in one store update.
2. THE Web_UI SHALL schedule at most one render of the market data panels per animation frame.
3. THE Web_UI SHALL pass chart candle updates to the chart library's series update function and SHALL NOT re-create the chart or re-render the chart's React component for a candle update.
4. THE Web_UI SHALL select only the data that each panel shows from the store, so that an Event for another symbol or Venue causes no render of that panel.
5. THE Web_UI SHALL memoize the rows of the Order Book, Trades tape, Watchlist, and News panels by row key.
6. THE Web_UI SHALL keep at most 500 candles per Timeframe, 200 Trade Events, and 50 News_Items in the store per symbol and Venue.
7. THE Web_UI SHALL load the AI Copilot, Markets, Logs, Settings, and chart components through lazy loading, so that the Trade page's initial JavaScript does not include code of pages that the user has not opened.
8. THE TUI SHALL apply all Events of one Event_Batch to its state before the next redraw.
9. THE Repository SHALL contain a web test that renders the Trade page, sends a batch of 100 Book Events for one symbol, and verifies that the store committed once and that panels of other symbols rendered zero times.
10. FOR ALL Event_Batches, the Web_UI store state after one batched update SHALL equal the state after applying each Event of the batch one at a time (batch equivalence property).

### Deployment, CI, and Documentation

### Requirement 36: Deployment and CI Changes

**User Story:** As an operator, I want deployment and CI free of database parts and covering the new features, so that the pipeline stays simple and honest.

#### Acceptance Criteria

1. THE Render_Blueprint SHALL declare for oni-server the variables LIVE_VENUES, LLM_PROVIDER, OLLAMA_BASE_URL, NEWS_PROVIDER, STARTING_BALANCE, and the `sync: false` secrets of Requirement 20, criterion 3, and SHALL keep SESSION_SECRET with `generateValue: true`.
2. THE Render_Blueprint SHALL pass validation against Render's Blueprint schema.
3. THE Docker smoke test of HT Req 41, criterion 3, SHALL start the Server_Image with no database, connect a WebSocket client, place a paper order, and receive a Fill Event.
4. THE CI_Workflow SHALL run the provider tests with mock HTTP servers for `openai`, `anthropic`, `nvidia`, and `ollama`, the News_Provider tests with mock HTTP servers, and the DEX_Adapter tests with recorded response fixtures, and these tests SHALL contact no real exchange, news, or LLM host.
5. THE CI_Workflow SHALL run the allowlist test of Requirement 14, criterion 4.
6. THE Repository SHALL keep `bun run check` as the single command that runs every test, type check, and lint check, and SHALL not require a database, an API key, or a network connection for it to pass.
7. THE Server_Image SHALL contain no Prisma files and SHALL start with `bun` running the Server entry file.

### Requirement 37: Documentation and Hackathon Deliverables

**User Story:** As a hackathon entrant, I want accurate documentation of the new version, so that judges can run and understand it.

#### Acceptance Criteria

1. THE Repository README SHALL describe the new layout, the ten symbols, the four Venues, the chip filters, replay mode, and the guest account, and SHALL list every environment variable of this spec with its default and whether it is a secret.
2. THE Repository README SHALL state that the Oni_Terminal places no real orders, builds no transaction, and calls no authenticated exchange endpoint, and SHALL list the Endpoint_Allowlist.
3. THE Repository README SHALL explain how to use Ollama locally, including the model download step and the OLLAMA_BASE_URL variable, and SHALL state that a hosted Server cannot reach an Ollama instance on a user's computer.
4. THE Repository README SHALL state that orders, fills, and rejections live in memory for the current Engine run only.
5. THE Repository README SHALL replace the HT Req 42, criteria 6 and 8, statements about Neon Postgres.
6. THE Repository SHALL contain the amended steering documents listed in the section "Applied Steering Amendments".

### Requirement 38: Ollama Local Model Discovery and Selection

**User Story:** As a trader who runs Ollama locally, I want to see the models installed on my machine and pick one, so that the Copilot and plain-English orders use the model I choose without editing environment variables.

#### Acceptance Criteria

1. WHEN the Provider_Registry probes `GET <OLLAMA_BASE_URL>/api/tags`, THE Provider_Registry SHALL validate the response body with Zod and read, for each entry of `models`, the fields `name`, `size`, `details.family`, and `details.parameter_size`.
2. THE Provider_Registry SHALL accept a model name only when the name is 1 to 128 characters long and consists of the characters A–Z, a–z, 0–9, and `.`, `_`, `:`, `/`, `@`, and `-`, and SHALL drop each entry whose name fails this rule.
3. IF the `/api/tags` response is not valid JSON, fails the Zod schema, or lists more than 100 models, THEN THE Provider_Registry SHALL treat the probe as failed, mark `ollama` unavailable, and set the Ollama_Model_List to empty.
4. WHEN the `/api/tags` response is valid, THE Provider_Registry SHALL set the Ollama_Model_List to the accepted entries, with a missing `details.family` or `details.parameter_size` stored as null.
5. THE Provider_Registry SHALL mark `ollama` available only WHILE the latest probe answered with a 2xx status and the Ollama_Model_List holds at least one model.
6. THE Server SHALL include in the `ProviderInfo` of `ollama` an optional `models` list whose entries carry name, size in bytes, family, and parameter size, in the `hello` and `providers` Server_Messages.
7. WHEN a probe changes the Ollama_Model_List, THE Server SHALL send an `ollama_models` Server_Message to every connected Client, carrying the list, the default model, and the Model_Selection of that connection.
8. THE Protocol_Crate SHALL define the Client_Message `set_model` with the fields `provider` and `model`, where `provider` is `ollama`.
9. WHEN the Server receives a `set_model` message whose model name equals a name in the latest Ollama_Model_List, THE Server SHALL store that name as the Model_Selection of that connection and reply with an `ollama_models` Server_Message.
10. IF the Server receives a `set_model` message whose model name is not in the latest Ollama_Model_List, THEN THE Server SHALL send a Notice with the kind `model_unknown`, keep the Model_Selection unchanged, and take no other action on the name.
11. WHEN the Server handles a plain-English order or an AI_Analyst request on a connection whose Provider_Selection is `ollama`, THE Server SHALL send the request to the Model_Selection of that connection.
12. THE Server SHALL use as the default Model_Selection the model named by OLLAMA_MODEL when the Ollama_Model_List contains it, and otherwise the first model of the Ollama_Model_List.
13. IF the Model_Selection of a connection is not in the Ollama_Model_List after a probe, THEN THE Server SHALL replace the Model_Selection with the model named by OLLAMA_MODEL when the Ollama_Model_List contains it, and otherwise with the first model of the Ollama_Model_List.
14. WHEN a WebSocket connection closes, THE Server SHALL discard the Model_Selection of that connection.
15. WHERE the selected provider is `ollama`, THE Web_UI Copilot panel SHALL show a dropdown of the Ollama_Model_List with each option reading name, family, parameter size, and size, separated by ` · `, with the size in human-readable units such as `4.3 GB`.
16. WHEN the user picks a model in the dropdown, THE Web_UI SHALL send `set_model` and store the model name in `localStorage` under the key `oni.ollamaModel`.
17. WHEN the Web_UI receives `hello` or `ollama_models`, THE Web_UI SHALL send `set_model` with the stored name only when the name is in the received Ollama_Model_List.
18. THE TUI SHALL show the current Model_Selection in the Copilot panel and SHALL cycle through the Ollama_Model_List with the key `M`, defined as `model.next` in `shared/keymap.json` for the `tui` client and no other binding.
19. THE Server SHALL treat every model name, family, and parameter size as display data and SHALL include none of them in an instruction to an LLM_Provider other than the `model` field of the Ollama request.
20. THE Server SHALL write no Ollama_Model_List and no `/api/tags` URL to any log, and SHALL log at most the host of OLLAMA_BASE_URL.
21. THE Server SHALL send every order that results from a Model_Selection through the Order_Preview, confirmation, Router, and Risk_Engine path of Requirement 3, with no other order path.
22. THE Endpoint_Allowlist SHALL keep its existing Ollama entries, `GET /api/tags` and `POST /api/chat`, and SHALL gain no host and no path for this requirement.

## Superseded and Amended Requirements

This spec supersedes or amends the following HT requirements. Statements in HT that conflict with this spec stop applying.

| HT requirement | Status | Replaced or changed by |
|---|---|---|
| Req 20 (Journal and REST Endpoints), all criteria | Superseded | Requirement 2 (Activity_Log, `/orders`, `/journal`, `/positions`) |
| Glossary: Journal, Prisma_Client, Journal_Queue, Journal_Writer, Journal_Status, Migration, Start_Script, Session_Id | Retired | Activity_Log, Run_Id |
| Req 16.1 (DATABASE_URL, DIRECT_URL, DB_ADAPTER) | Amended | Requirement 1, criteria 2 and 3; new variables in Requirements 3, 9, 10, 11, 12, 16, 19 |
| Req 16.4 (secrets in logs) | Amended | Add the new keys of Requirements 3, 10, 19 |
| Req 16.5, 16.6 (DATABASE_URL in production, in-memory fallback) | Superseded | Requirement 1 |
| Req 17.5, 17.8 (`db` field in `/health`) | Superseded | Requirement 1, criterion 9 |
| Req 38.4 (Render DATABASE_URL, DIRECT_URL) | Superseded | Requirement 20, criterion 3; Requirement 36 |
| Req 41.5, 41.6, 41.7 (Postgres CI jobs) | Superseded | Requirement 1, criterion 6; Requirement 36 |
| Req 42.6, 42.8 (README on Neon) | Superseded | Requirement 37 |
| Req 1 (Message Types) | Amended | Venue fields, Ticker24h, VenueStatus, Balance events, SetProvider, SubscribeNews, Event_Batch, emit time (Requirements 9, 15, 16, 18, 33, 34) |
| Req 5, 43, 44 (live venues) | Amended | Requirement 9 (LIVE_VENUES, several Venues at once); Requirement 8 (per-symbol decimals replace 44.3) |
| Req 8.3, 25.2, 25.3 (Timeframes) | Amended | Requirement 18 (adds 4h) |
| Req 9.7 (Book Event interval) | Amended | Requirement 33, criterion 8 (50 ms) |
| Req 19 (Risk Engine) | Amended | New rejection reasons: venue_unavailable, stale_market_data, price_deviation, insufficient_balance, ai_rate_limit, ai_daily_cap |
| Req 21 (Command Parser) | Amended | Requirement 17 (TWAP form) |
| Req 23 (Plain-English Orders) | Amended | Requirements 3, 4, 6 (any provider; criterion 7 replaced) |
| Req 24 (MCP Server) | Amended | Tools accept an optional venue argument and the ten symbols; no other change |
| Req 25 through 31 (chart, panels, entry, command bar) | Superseded for layout | Requirements 21 through 29; HT 29 through 31 behaviours kept |
| Req 27.3 (watchlist of three symbols) | Superseded | Requirement 26 |
| Req 34.3, 35 (TUI render rate, Hit_Map) | Kept | Requirements 30 and 32 add panels |
| Req 14, 15, 18, 45 through 49 (accounts, supervision, single order path, auth, wallet safety) | Kept | Unchanged |
| Requirement 3 (Ollama availability = any 2xx from `/api/tags`; fixed model OLLAMA_MODEL) | Amended | Requirement 38 (available only with at least one installed model; per-connection Model_Selection, OLLAMA_MODEL is the preferred default) |

## Applied Steering Amendments

The user approved the steering amendments for this spec, and they are applied to the four files in `.kiro/steering/`. The Endpoint_Allowlist in the steering files matches Requirement 14, and the secrets list matches Requirements 3, 10, 19, and 20.

| File | What changed |
|---|---|
| `trading-safety.md` | Rule 1 names the read-only allowlist (Backpack, Coinbase, Jupiter, Raydium; no transaction building, signing, or swap execution; the optional `JUPITER_API_KEY` goes only in the `x-api-key` header of the Jupiter Price API). Rules 2 and 3 cover TWAP child orders. Rule 4 covers every provider and the AI_Analyst. Rule 5 lists the new rejection reasons, including `insufficient_balance`. Rule 6 drops the database URLs and lists the new secrets. Rule 7 adds Zod validation for LLM, news, and DEX responses and drops the Prisma sentence. Rule 10 says the order venue comes from the confirmed Order_Preview. |
| `tech.md` | Prisma and Neon are gone. The stack lists the four LLM providers, the two News_Providers, and the in-memory Activity_Log. Commands add `bun run bench:latency`. The wire protocol lists the Venue fields, `event_batch`, SetProvider, and SubscribeNews. The market data section lists the allowlist and the ten symbols with per-symbol tick and lot sizes. |
| `product.md` | Ten symbols, four Venues, the AI analyst, news, no database, and `insufficient_balance`. The product name stays Oni. |
| `rust.md` | Per-symbol tick and lot sizes (with the 10-decimal Money limit), DEX rounding, balance arithmetic, the engine's per-venue state, the 50 ms Book interval, `emit_us` set by the runtime, and the read-only feed rule. |

## Open Items for Review

1. **CryptoPanic free plan.** The design could not fetch CryptoPanic's own documentation. A third-party SDK README states that the free Developer API plan was discontinued. Requirement 19 therefore treats CryptoPanic as optional on the hosted deploy: with no working key, the News panel shows "News unavailable". Check your CryptoPanic dashboard before relying on it.
2. **"News & Events" in the mockup** is delivered as News only. No economic calendar or event source is included.
3. **Memory in the TUI header** means the TUI process, not the Server or the Engine.
4. **Hosted Ollama** is not reachable from Render. Ollama works when the Server runs on the same machine as the model, or against a host you operate.
5. **Latency targets** are for loopback in replay mode. A hosted Server adds network round-trip time that the Latency_Readout shows but no target covers.
6. **NVIDIA NIM terms.** NVIDIA's hosted trial endpoint is for development and testing, not production, and may use prompts to improve its models, according to a third-party reading of its terms. The `nvidia` provider is therefore suited to local development and demos. Market_Snapshots hold no account data, so no account data can reach it.
