//! Shared Command and Event message types for Oni.
//!
//! Prices, quantities, and money are exact `i64` newtypes (Req 1.4). Floats appear only in
//! indicator values (Req 1.5). The instrument table defines tick and lot sizes (Req 4.1).
//! The codec reads and writes one JSON message per line and validates Command ranges (Req 2).
//!
//! `cargo test -p protocol` (or `bun run gen:protocol`) writes the TypeScript bindings for every
//! wire type to `shared/protocol/` (Req 1.3).

pub mod client;
mod codec;
mod command;
mod error;
mod event;
mod instrument;
mod num;
#[cfg(test)]
mod properties;
#[cfg(test)]
mod strategies;
mod types;

pub use codec::{
    DecodeError, MAX_EVENT_LINE_BYTES, MAX_LINE_BYTES, MAX_REPLAY_SPEED, MIN_REPLAY_SPEED,
    decode_command, decode_line, encode_line, is_valid_fixture_name,
};
pub use command::Command;
pub use error::ProtocolError;
pub use event::{
    Bar, ErrorCode, Event, IndicatorPoint, IndicatorValues, Level, OrderStatus, WireEvent,
};
pub use instrument::{INSTRUMENTS, Instrument, instrument, notional};
pub use num::{MONEY_DECIMALS, Money, Price, Qty};
pub use types::{
    AccountId, AnalysisBias, CopilotAction, NewsItem, OrderId, OrderKind, PairHealth, ProviderId,
    Side, Ticker, TimeMs, Timeframe, TwapStatus, Venue, VenueKind, VenueStatusKind,
};

/// Directory that ts-rs writes TypeScript bindings into: `shared/protocol/` at the repository
/// root. Every exported type passes it as `#[ts(export_to = ...)]`.
///
/// It is absolute (built from `CARGO_MANIFEST_DIR`) because cargo reads `.cargo/config.toml`
/// from the current directory, not from the manifest directory, so a `TS_RS_EXPORT_DIR` set in
/// `rust/.cargo/config.toml` is ignored when cargo runs from the repository root with
/// `--manifest-path rust/Cargo.toml`. The trailing `/` makes ts-rs write `<Type>.ts` files.
pub(crate) const TS_EXPORT_DIR: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../../shared/protocol/");

/// Version of the wire protocol spoken between the engine, the server, and the clients.
///
/// Version 2 added `account_id` to the order Commands and account Events, `Authenticate`,
/// `Session`, and `Hello.venue` (design Decision A7, Req 1.7–1.11). Version 3 adds `venue` to
/// the market data and order messages, `synthetic` to `Book` and `Trade`, the ticker, venue
/// status, pair status, reference venue, and balance messages, and the 4h timeframe.
pub const PROTOCOL_VERSION: u32 = 3;

/// Returns the wire protocol version.
pub fn protocol_version() -> u32 {
    PROTOCOL_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_is_three() {
        assert_eq!(protocol_version(), 3);
    }
}
