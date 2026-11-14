# Venue sample messages (Task 7.1)

**These files are documented examples written by hand. They are not live captures.**
Each file wraps its payload as `{ "_source", "_note", "sample" }`; the tests in Task 7.6 must read the `sample` field. Replace them with real captures when the recorder exists (Task 7.7).

Reference: `.kiro/specs/haunted-terminal/venue-notes.md`.

| File | What it is | Source |
|---|---|---|
| `backpack_trade.json` | WS `trade.SOL_USDC` envelope | https://docs.backpack.exchange/#tag/Streams |
| `backpack_depth.json` | WS `depth.SOL_USDC` incremental update (`U`, `u`) | https://docs.backpack.exchange/#tag/Streams, https://apis.io/channels/backpack/depth-symbol/ |
| `backpack_depth_rest.json` | REST `GET /api/v1/depth` snapshot (`lastUpdateId`) | https://docs.backpack.exchange/#tag/Markets |
| `backpack_markets.json` | REST `GET /api/v1/markets` subset: BTC/ETH/SOL `_USDC` tick and step | https://docs.backpack.exchange/#tag/Markets |
| `backpack_klines.json` | REST `GET /api/v1/klines` bars | https://docs.backpack.exchange/#tag/Markets |
| `coinbase_trade.json` | WS `market_trades` message | https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/websocket/market-trades |
| `coinbase_level2_snapshot.json` | WS `level2` (`l2_data`) snapshot | https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/websocket/level2 |
| `coinbase_level2_update.json` | WS `level2` (`l2_data`) update | same |
| `coinbase_candles.json` | REST public product candles | https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/public/get-public-product-candles |
| `coinbase_products.json` | REST public product subset: tick and size increments | https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/public/get-public-product |

Provenance caveats:
- The Backpack WS field lists (`trade`, `depth`) could not be re-read from the official docs page by the research tool (the page is a script-rendered reference). The `U`/`u` continuity rule and the microsecond unit come from an AsyncAPI mirror. Those two files are the least certain. Verify them against a real capture.
- REST response shapes and the tick/step values were cross-checked once with read-only fetches of the public endpoints. The sample values themselves are hand-written.
