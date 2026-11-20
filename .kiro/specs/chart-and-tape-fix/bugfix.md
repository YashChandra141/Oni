# Bugfix Requirements Document

## Introduction

This bugfix covers two defects that the user reported with screenshots. Both make the terminal hard to use in a demo.

**Bug A: the candlestick chart shows only one candle.** In the web chart (TradingView Lightweight Charts) and in the TUI CandleChart_Widget, only one candle is visible. In the web chart the EMA and VWAP lines span the full width, every time-axis label reads the same minute (for example "00:03"), and one thin candle sits at the right edge. The defect has three parts. First, the web UI places each indicator point at the time of the update that produced it instead of at the open time of its candle. Second, the Engine starts with no candle history in replay mode and never loads venue history in live mode, so the history snapshot (Req 8.7) is nearly empty. Third, the subscribe answer carries only the current indicator values, so indicator lines cannot cover history candles.

**Bug B: on the web, the trades tape takes over the page.** As trades arrive, the Tape panel grows with its rows. The chart shrinks until it is no longer visible, and the page fills with tape rows and scrolls.

Approved scope decisions:

- Candle history comes only from data the system already has or can read publicly: the shipped replay Fixture, and the public, unauthenticated kline and candle REST endpoints of the Live_Venue. Nothing new is stored, persisted, or maintained for history.
- Replay warm-up: the Engine fast-forwards every Fixture line older than the last 30 minutes of the Fixture, then plays the last 30 minutes in real time (at REPLAY_SPEED). With the 2-hour demo Fixture, the chart opens with about 90 one-minute candles.
- Indicator history: a subscribe returns one set of indicator values per history candle, so indicator lines cover the history in both Clients. This needs a protocol change.

Requirement references (Req N.M) point to `.kiro/specs/haunted-terminal/requirements.md`.

## Bug Analysis

### Current Behavior (Defect)

**Bug A: chart history and indicator alignment**

1.1 WHEN the Web_UI receives a live Indicators Event for a symbol and Timeframe THEN the system stores the indicator point at the Event's update time (the time of the trade that changed the candle), not at the open time of the candle the values belong to. One candle interval therefore gets a separate point for every second in which a trade arrived, and the 500-point limit covers only the last few minutes instead of the last 500 candles.

1.2 WHEN the Web_UI chart draws indicator lines from those points THEN the system adds one time-axis slot per indicator point. The lines span the full chart width, every time-axis label shows the same minute, and the candles are squeezed into one thin bar at the right edge.

1.3 WHEN the Engine starts in replay mode THEN the system starts with no candle history. The first history snapshot (Req 8.7) holds at most one 1m candle, and at the default REPLAY_SPEED of 1 a new 1m candle appears only once per minute. Both Clients show a single candle at start.

1.4 WHEN the Engine runs in live mode (Live_Venue Coinbase or Backpack) and a Client subscribes to a symbol and Timeframe THEN the system loads no candle history from the Live_Venue's public REST kline or candle endpoint (Req 5.2, 43.2). The history snapshot holds only candles built from trades received since the Engine started.

1.5 WHEN a Client subscribes to a symbol and Timeframe that has history candles THEN the system sends only the current indicator values. In both Clients the indicator lines start at the newest candle and do not cover the history candles.

1.6 WHEN the Web_UI receives a new history snapshot for a symbol and Timeframe (after a reconnect, an Engine restart, or a return to an earlier symbol or Timeframe) THEN the system replaces the stored candles but keeps the stored indicator points and merges the new points into them, so stale points from before the snapshot stay on the chart.

1.7 WHEN a live trade changes the forming candle THEN the Web_UI chart converts the whole stored candle list (up to 500 candles) and every enabled indicator line again. It replaces the indicator line data with a full `setData` call on most Events, and replaces the candle and volume data with a full `setData` call every time a new candle opens.

**Bug B: web layout and tape**

1.8 WHEN trades arrive and the Tape panel fills (up to 50 rendered rows) THEN the system grows the Tape panel with its rows. The grid row that holds the Tape grows with it, the chart's row shrinks until the chart is not visible, and the page becomes taller than the viewport and scrolls.

1.9 WHEN the content of a Web_UI panel (watchlist, order book, positions, open orders, P&L, tape) is taller than the panel THEN the system either clips the content with no way to scroll to it, or lets the content push the page layout.

1.10 WHEN a trade arrives for the selected symbol THEN the Web_UI tape gives every rendered row a new identity, because each row's identity depends on its position in the list. Every visible row is rebuilt for each trade instead of one row being added.

**Scope addition: replay time**

1.11 WHEN the Engine replays a Fixture THEN the system shows the Fixture's recorded timestamps instead of the current time. The chart time axis, the tape, and fills carry an old or fake date (for example Jan 1 00:00 UTC for the demo Fixture).

**Scope addition: local time zone**

1.12 WHEN the Web_UI shows a time (chart time axis, crosshair readout, tape, fills and orders, status bar, notices) THEN the system formats it in UTC, for example "22:13 UTC", instead of the viewer's local time zone. A viewer in India or in the USA sees UTC times that they must convert by hand.

### Expected Behavior (Correct)

**Bug A: chart history and indicator alignment**

2.1 WHEN the Web_UI receives a live Indicators Event for a symbol and Timeframe THEN the system SHALL store the indicator point at the open time of the candle the values belong to, aligned down to the Timeframe in UTC. The system SHALL keep at most one point per candle and SHALL replace the forming candle's point on each update.

2.2 WHEN the Web_UI chart draws candles and indicator lines THEN the system SHALL give the time axis exactly one slot per candle, and each indicator point SHALL share the time of its candle. The time-axis labels SHALL follow the candle open times, and the candles SHALL keep their normal width.

2.3 WHEN the Engine starts a replay of a Fixture that spans more than 30 minutes THEN the system SHALL process every Fixture line whose receive time is more than 30 minutes before the receive time of the Fixture's last line at once, without the recorded delays. This builds the candles, indicators, order book, and last trade price. The system SHALL then play the remaining last 30 minutes at REPLAY_SPEED and SHALL then loop through the whole Fixture as it does today. With the 2-hour demo Fixture, the first 1m history snapshot after the warm-up SHALL hold about 90 candles.

2.4 WHILE the replay warm-up of criterion 2.3 runs THEN the system SHALL emit no Trade, Book, live Candle, or live Indicators Event for the warm-up lines, and SHALL NOT match any paper order against warm-up data. WHEN the warm-up finishes, the system SHALL send a fresh history snapshot, with the indicator history of criterion 2.6, for every symbol and Timeframe that is subscribed at that moment.

2.5 WHEN the Engine runs in live mode and a Client subscribes to a symbol and Timeframe that has not been backfilled in the current Engine run THEN the system SHALL load recent candles from the Live_Venue's public, unauthenticated REST endpoint (the Backpack kline endpoint or the Coinbase candle endpoint). It SHALL merge them with the candles built from live trades into one list, oldest first, with one candle per open time, and SHALL feed the backfilled candles to the Indicator_Engine. It SHALL then send a history snapshot of up to 500 candles with their indicator history. The system SHALL make at most one successful backfill request per symbol and Timeframe per Engine run. IF the backfill fails, THEN the system SHALL emit an Error Event, keep the candles built from live trades, and let a later subscribe to that symbol and Timeframe try again.

2.6 WHEN a Client subscribes to a symbol and Timeframe that has history candles THEN the system SHALL send, together with the candle history snapshot, one set of indicator values per history candle, keyed by the candle's open time. The values of each candle SHALL equal the values that the Indicator_Engine computed at that candle's last update. Both the Web_UI and the TUI SHALL draw the enabled indicator lines over the history candles.

2.7 WHEN the Web_UI or the TUI receives a new history snapshot for a symbol and Timeframe THEN the system SHALL replace the stored indicator points of that symbol and Timeframe with the indicator history from the snapshot, as it replaces the stored candles.

2.8 WHEN a live trade changes the forming candle or opens a new candle THEN the Web_UI chart SHALL apply the change with an incremental update of the candle series, the volume series, and each enabled indicator line. The work per Event SHALL be proportional to the changed candle, not to the length of the stored series. The chart SHALL replace whole series data only when a history snapshot arrives, when the symbol, Timeframe, or price decimals change, when an indicator is toggled on, or when a candle older than the newest candle changes.

**Bug B: web layout and tape**

2.9 WHEN any number of trades, order book levels, Positions, open orders, or fills arrive THEN the Web_UI SHALL fill exactly the viewport height and SHALL NOT scroll the page. Each panel SHALL have a height that does not depend on its content, and the chart panel SHALL keep its size and stay visible at all times.

2.10 WHEN the content of a Web_UI panel is taller than the panel THEN the system SHALL scroll the content inside that panel and SHALL leave the size and position of every other panel unchanged.

2.11 WHEN a trade arrives for the selected symbol THEN the Web_UI tape SHALL show the newest trade at the top of its panel, SHALL render at most a fixed number of rows (50), and SHALL add the new row without rebuilding the rows already shown.

**Scope addition: replay time**

2.12 WHEN a replay Fixture loads THEN the system SHALL shift the `recv` and the message `ts` of every Fixture line by one offset, a whole number of minutes, so that the first line after the warm-up (`lines[k]`, or line 0 when there is no warm-up) falls in the current UTC minute of the wall clock at load time. Later loops SHALL keep increasing from there. The shift SHALL be applied before the warm-up, so the Engine core only sees shifted times.

**Scope addition: local time zone**

2.13 WHEN the Web_UI shows a time (chart time axis, crosshair readout, tape, fills and orders, status bar, notices) THEN the system SHALL format it in the browser's local time zone through `Intl.DateTimeFormat` with no fixed zone, so each viewer sees their own zone for the same moment (someone in India sees IST, someone in the USA sees their US zone). The conversion SHALL follow the zone's daylight saving rules for the instant being shown. The change is display-only: the Web_UI SHALL NOT shift any data by a zone offset.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the Candle_Builder builds candles from trades THEN the system SHALL CONTINUE TO satisfy low ≤ open ≤ high and low ≤ close ≤ high, volume equal to the sum of trade quantities in the interval, and equality of aggregated and directly built higher-Timeframe candles (Req 8.4, 8.5, 8.6).

3.2 WHEN a Client subscribes to a symbol and Timeframe THEN the system SHALL CONTINUE TO send at most 500 history candles, oldest first, before any live Candle Event for that subscription, and to emit a Candle Event each time the current candle changes (Req 8.7, 8.8).

3.3 WHEN the Indicator_Engine computes EMA, SMA, VWAP, Bollinger Bands, RSI, and ATR THEN the system SHALL CONTINUE TO produce the same values as today, satisfying Req 10.1 to 10.5. Only the time at which the Web_UI places each value changes.

3.4 WHEN the same Fixture is replayed with the same Commands THEN the system SHALL CONTINUE TO produce the same sequence of Candle, Trade, Book, Indicators, OrderAck, OrderRejected, Fill, and Position Events, excluding wall-clock timestamps (Req 6.6). The system SHALL CONTINUE TO accept replay speeds from 1 to 50, reject other speeds and missing or unparsable Fixtures with an Error Event (Req 6.3, 6.4, 6.5), and loop with market time that keeps increasing.

3.5 WHEN a replay Fixture spans 30 minutes or less THEN the system SHALL CONTINUE TO play the whole Fixture at REPLAY_SPEED from its first line, with no warm-up.

3.6 WHEN the Market_Feed or a backfill contacts a Venue THEN the system SHALL CONTINUE TO use only public, unauthenticated Coinbase and Backpack market-data endpoints, with rustls and the `ring` provider, and with no API key, signature, or account credential (Req 5.3, 5.4, 43.3, 43.8). The system SHALL CONTINUE TO drop venue values that do not fit the internal decimals exactly, and to count them (Req 44.5).

3.7 WHEN candle history is built or loaded THEN the system SHALL CONTINUE TO keep it in Engine memory only, write no candle or market data to the Journal or to any file, and start each Engine run without restoring Paper_Account state (Req 14, 15.8).

3.8 WHEN a user enters an order from the Command_Bar, the order ticket, a hotkey, plain English, or the MCP_Server THEN the system SHALL CONTINUE TO route it through the Router and the Risk_Engine, require confirmation of the Order_Preview by the same client on the same account, and apply the Kill_Switch and every Risk_Limit (Req 18, 19, 22, 23, 24).

3.9 WHEN Commands and market data for several Account_Ids interleave THEN the system SHALL CONTINUE TO keep each Paper_Account isolated and to deliver OrderAck, Fill, and Position Events only to the connections of that Account_Id (Req 14.9, 17.7, 17.11, 18.6).

3.10 WHEN the TUI redraws THEN the system SHALL CONTINUE TO redraw at most 30 times per second and only when state changed (Req 34.3). The TUI SHALL CONTINUE TO align each indicator point to its candle's open time, merge candles by open time, and keep at most 500 candles.

3.11 WHEN the user zooms, pans, moves the crosshair, switches Timeframe with buttons or keys 1 to 5, or toggles an indicator in either Client THEN the system SHALL CONTINUE TO behave as specified in Req 25, 26, and 29. A new history snapshot SHALL CONTINUE TO position the view on the newest candles.

3.12 WHEN a Trade Event arrives THEN the system SHALL CONTINUE TO forward it to every Client subscribed to its symbol, show it in the tape with time (in the viewer's local zone, criterion 2.13), price, quantity, and side for the selected symbol, and update the watchlist last price (Req 9.8, 27.2, 27.3).

3.13 WHEN the Web_UI is displayed THEN the system SHALL CONTINUE TO show the same panels in the same arrangement (status bar at the top, command bar at the bottom, watchlist, chart, order book, order ticket, account panels, and tape), with the preview dialog, confirm dialog, and rejection toast shown above the panels, and with the chart resizing to its panel when the window resizes.

3.14 WHEN the Engine restarts THEN the Server SHALL CONTINUE TO reset every Paper_Account, notify every connected Client, and resend every active subscription (Req 15.4, 15.7).

3.15 WHEN replay time is aligned to the current time (criterion 2.12) THEN the system SHALL CONTINUE TO keep the inter-message delays, the warm-up length `k`, and the shape of every 1m candle unchanged. Higher Timeframes may group trades differently, because the offset is a minute multiple, not a multiple of the Timeframe. Live mode SHALL CONTINUE TO use venue times unchanged. Replay determinism (Req 6.6, criterion 3.4) holds up to this one constant offset, which comes from the wall clock at load time.

3.16 WHEN times are shown in the viewer's local zone (criterion 2.13) THEN the system SHALL CONTINUE TO keep every candle bucket aligned to UTC (a 1d candle opens at 00:00 UTC, which a viewer in India sees as 05:30 IST), and to keep wire data, the Engine, the Server, and the Journal in UTC epoch ms. Chart series times SHALL CONTINUE TO be UTC seconds. The TUI is out of scope for this change and its time display is unchanged.
