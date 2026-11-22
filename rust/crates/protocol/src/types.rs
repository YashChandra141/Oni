//! Order and market vocabulary shared by Commands and Events.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use ts_rs::TS;

use crate::error::ProtocolError;
use crate::num::Price;

/// Unix epoch time in milliseconds. A JSON number on the wire (not a string): epoch ms stays
/// far below 2^53, so JavaScript reads it exactly.
///
/// ts-rs maps a bare `i64` to `bigint`, so message fields of this type need
/// `#[ts(type = "number")]` when they are exported.
pub type TimeMs = i64;

/// Order side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum Side {
    Buy,
    Sell,
}

/// Candle interval, aligned to UTC boundaries.
///
/// On the wire: `"1m"`, `"5m"`, `"15m"`, `"1h"`, `"4h"`, `"1d"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum Timeframe {
    #[serde(rename = "1m")]
    M1,
    #[serde(rename = "5m")]
    M5,
    #[serde(rename = "15m")]
    M15,
    #[serde(rename = "1h")]
    H1,
    #[serde(rename = "4h")]
    H4,
    #[serde(rename = "1d")]
    D1,
}

impl Timeframe {
    /// Every timeframe, shortest first.
    pub const ALL: [Timeframe; 6] = [Self::M1, Self::M5, Self::M15, Self::H1, Self::H4, Self::D1];

    /// Length of one interval in milliseconds.
    pub const fn millis(self) -> i64 {
        match self {
            Self::M1 => 60_000,
            Self::M5 => 5 * 60_000,
            Self::M15 => 15 * 60_000,
            Self::H1 => 60 * 60_000,
            Self::H4 => 4 * 60 * 60_000,
            Self::D1 => 24 * 60 * 60_000,
        }
    }

    /// Wire name, e.g. `"15m"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::M1 => "1m",
            Self::M5 => "5m",
            Self::M15 => "15m",
            Self::H1 => "1h",
            Self::H4 => "4h",
            Self::D1 => "1d",
        }
    }
}

impl fmt::Display for Timeframe {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Order type and its price, if any. On the wire: `{"type":"limit","price":"6400000"}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum OrderKind {
    Market,
    Limit { price: Price },
    Stop { stop_price: Price },
}

/// Order identifier: 1 to 64 characters of `[A-Za-z0-9_-]`.
///
/// The only constructors validate, and deserialization validates too, so every `OrderId`
/// value is well formed.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct OrderId(String);

impl OrderId {
    /// Maximum length in characters.
    pub const MAX_LEN: usize = 64;

    /// Validates and wraps an order identifier.
    pub fn new(id: impl Into<String>) -> Result<Self, ProtocolError> {
        let id = id.into();
        if is_valid_order_id(&id) {
            Ok(Self(id))
        } else {
            Err(ProtocolError::InvalidOrderId(id))
        }
    }

    /// The identifier text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn is_valid_order_id(id: &str) -> bool {
    let allowed = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
    (1..=OrderId::MAX_LEN).contains(&id.len()) && id.bytes().all(allowed)
}

impl fmt::Display for OrderId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Serialize for OrderId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for OrderId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let id = String::deserialize(deserializer)?;
        Self::new(id).map_err(serde::de::Error::custom)
    }
}

/// Paper account identifier: 1 to 64 characters of `[A-Za-z0-9_]` (Req 1.10).
///
/// The server uses `guest` for the shared Guest_Account and `w_<base58 address>` for a
/// Wallet_Account (at most 46 characters). The engine treats the value as an opaque key; only the
/// server knows the convention (design Decision A7).
///
/// The only constructor validates, and deserialization validates too, so every `AccountId`
/// value is well formed.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct AccountId(String);

impl AccountId {
    /// Maximum length in characters.
    pub const MAX_LEN: usize = 64;

    /// Validates and wraps an account identifier.
    pub fn new(id: impl Into<String>) -> Result<Self, ProtocolError> {
        let id = id.into();
        if is_valid_account_id(&id) {
            Ok(Self(id))
        } else {
            Err(ProtocolError::InvalidAccountId(id))
        }
    }

    /// The identifier text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn is_valid_account_id(id: &str) -> bool {
    let allowed = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    (1..=AccountId::MAX_LEN).contains(&id.len()) && id.bytes().all(allowed)
}

impl fmt::Display for AccountId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Serialize for AccountId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for AccountId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let id = String::deserialize(deserializer)?;
        Self::new(id).map_err(serde::de::Error::custom)
    }
}

/// A source of market data: one of the four live public feeds, or recorded fixtures
/// (Req 15.1, 15.2, design "Types").
///
/// On the wire: `"coinbase"`, `"backpack"`, `"jupiter"`, `"raydium"`, `"replay"`.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS,
)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum Venue {
    Coinbase,
    Backpack,
    Jupiter,
    Raydium,
    /// Recorded fixtures. Fixture lines carry no venue and are tagged `replay` on read.
    #[default]
    Replay,
}

impl Venue {
    /// Every venue, in wire order.
    pub const ALL: [Venue; 5] = [
        Self::Coinbase,
        Self::Backpack,
        Self::Jupiter,
        Self::Raydium,
        Self::Replay,
    ];

    /// The four live venues, in the default `LIVE_VENUES` order.
    pub const LIVE: [Venue; 4] = [Self::Coinbase, Self::Backpack, Self::Jupiter, Self::Raydium];

    /// Whether the venue has a real order book (`Cex`) or only prices (`Dex`). Replay is `Cex`.
    pub const fn kind(self) -> VenueKind {
        match self {
            Self::Coinbase | Self::Backpack | Self::Replay => VenueKind::Cex,
            Self::Jupiter | Self::Raydium => VenueKind::Dex,
        }
    }

    /// Wire name, e.g. `"backpack"`.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Coinbase => "coinbase",
            Self::Backpack => "backpack",
            Self::Jupiter => "jupiter",
            Self::Raydium => "raydium",
            Self::Replay => "replay",
        }
    }
}

impl fmt::Display for Venue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// How a [`Venue`] supplies market data. A `Dex` venue has prices only, so its book is
/// synthetic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum VenueKind {
    Cex,
    Dex,
}

/// Connection state of one venue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum VenueStatusKind {
    Connected,
    Connecting,
    Stale,
    Down,
    Disabled,
}

/// Health of one (venue, symbol) pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum PairHealth {
    Ok,
    Stale,
    Suspect,
}

/// 24-hour statistics of one (venue, symbol) pair, from the 1h bar series.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct Ticker {
    pub open: Price,
    pub high: Price,
    pub low: Price,
    pub last: Price,
    /// `null` when the venue supplies no volume (DEX venues).
    pub volume: Option<crate::num::Qty>,
    pub change_bps: i32,
    /// True while fewer than 24 hourly bars back the window.
    pub partial: bool,
}

/// An AI Copilot action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum CopilotAction {
    Analyze,
    Ask,
    CreateStrategy,
    Scan,
}

/// Direction of an AI analysis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum AnalysisBias {
    Long,
    Short,
    Neutral,
}

/// An LLM provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum ProviderId {
    Openai,
    Anthropic,
    Nvidia,
    Ollama,
}

/// One news headline. External text: clients show it, nothing executes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub struct NewsItem {
    pub id: String,
    pub title: String,
    pub source: String,
    pub url: String,
    #[ts(type = "number")]
    pub published_at: TimeMs,
    pub symbols: Vec<String>,
}

/// State of a TWAP plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = crate::TS_EXPORT_DIR)]
pub enum TwapStatus {
    Active,
    Done,
    Canceled,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json<T: Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap()
    }

    fn parse<T: for<'de> Deserialize<'de>>(text: &str) -> Result<T, serde_json::Error> {
        serde_json::from_str(text)
    }

    #[test]
    fn side_uses_snake_case() {
        assert_eq!(json(&Side::Buy), "\"buy\"");
        assert_eq!(json(&Side::Sell), "\"sell\"");
        assert_eq!(parse::<Side>("\"sell\"").unwrap(), Side::Sell);
        assert!(parse::<Side>("\"BUY\"").is_err());
    }

    #[test]
    fn timeframe_wire_names_and_lengths() {
        let expected = [
            ("1m", 60_000),
            ("5m", 300_000),
            ("15m", 900_000),
            ("1h", 3_600_000),
            ("4h", 14_400_000),
            ("1d", 86_400_000),
        ];
        for (tf, (name, millis)) in Timeframe::ALL.into_iter().zip(expected) {
            assert_eq!(json(&tf), format!("\"{name}\""));
            assert_eq!(parse::<Timeframe>(&json(&tf)).unwrap(), tf);
            assert_eq!(tf.as_str(), name);
            assert_eq!(tf.to_string(), name);
            assert_eq!(tf.millis(), millis);
        }
        assert!(parse::<Timeframe>("\"2m\"").is_err());
        assert!(parse::<Timeframe>("\"M1\"").is_err());
    }

    #[test]
    fn order_kind_is_internally_tagged() {
        let limit = OrderKind::Limit {
            price: Price(6_400_000),
        };
        let stop = OrderKind::Stop {
            stop_price: Price(1),
        };
        assert_eq!(json(&OrderKind::Market), r#"{"type":"market"}"#);
        assert_eq!(json(&limit), r#"{"type":"limit","price":"6400000"}"#);
        assert_eq!(json(&stop), r#"{"type":"stop","stop_price":"1"}"#);
        for kind in [OrderKind::Market, limit, stop] {
            assert_eq!(parse::<OrderKind>(&json(&kind)).unwrap(), kind);
        }
        let numeric_price = r#"{"type":"limit","price":6400000}"#;
        assert!(parse::<OrderKind>(numeric_price).is_err());
        assert!(parse::<OrderKind>(r#"{"type":"limit"}"#).is_err());
    }

    #[test]
    fn order_id_accepts_valid_ids() {
        let max = "a".repeat(OrderId::MAX_LEN);
        for id in ["a", "o_1a_XyZ-9", "0", "-_-", max.as_str()] {
            let order_id = OrderId::new(id).unwrap();
            assert_eq!(order_id.as_str(), id);
            assert_eq!(json(&order_id), format!("\"{id}\""));
            assert_eq!(parse::<OrderId>(&json(&order_id)).unwrap(), order_id);
        }
    }

    #[test]
    fn order_id_rejects_invalid_ids() {
        let too_long = "a".repeat(OrderId::MAX_LEN + 1);
        let mut bad = vec!["", "a b", "a/b", "../x", "é", "a\n", "a.b"];
        bad.push(&too_long);
        for id in bad {
            let expected = Err(ProtocolError::InvalidOrderId(id.to_owned()));
            assert_eq!(OrderId::new(id), expected);
            assert!(parse::<OrderId>(&json(&id)).is_err(), "accepted {id:?}");
        }
        assert!(parse::<OrderId>("42").is_err());
    }

    /// Regression: the account ids the server builds, and the 1 and 64 character bounds, are
    /// accepted (Req 1.10).
    #[test]
    fn account_id_accepts_valid_ids() {
        let max = "A".repeat(AccountId::MAX_LEN);
        // A base58 Solana address is 32 to 44 characters, so `w_<address>` fits in 64.
        let wallet = "w_9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
        for id in ["guest", wallet, "a", "0", "_", "Az09_", max.as_str()] {
            let account_id = AccountId::new(id).unwrap();
            assert_eq!(account_id.as_str(), id);
            assert_eq!(account_id.to_string(), id);
            assert_eq!(json(&account_id), format!("\"{id}\""));
            assert_eq!(parse::<AccountId>(&json(&account_id)).unwrap(), account_id);
        }
    }

    /// Regression: anything outside 1..=64 characters of `[A-Za-z0-9_]` is refused by the
    /// constructor and by deserialization, including `-`, which an `OrderId` allows (Req 1.10).
    #[test]
    fn account_id_rejects_invalid_ids() {
        let too_long = "a".repeat(AccountId::MAX_LEN + 1);
        let mut bad = vec![
            "", "guest-1", "w-abc", "a b", " guest", "guest\n", "a/b", "../x", "é", "a.b", "a:b",
        ];
        bad.push(&too_long);
        for id in bad {
            let expected = Err(ProtocolError::InvalidAccountId(id.to_owned()));
            assert_eq!(AccountId::new(id), expected);
            assert!(parse::<AccountId>(&json(&id)).is_err(), "accepted {id:?}");
        }
        assert!(parse::<AccountId>("42").is_err());
        assert!(parse::<AccountId>("null").is_err());
    }

    #[test]
    fn venue_uses_snake_case() {
        assert_eq!(json(&Venue::Coinbase), "\"coinbase\"");
        assert_eq!(json(&Venue::Backpack), "\"backpack\"");
        assert_eq!(parse::<Venue>("\"backpack\"").unwrap(), Venue::Backpack);
        assert!(parse::<Venue>("\"Backpack\"").is_err());
        assert!(parse::<Venue>("\"binance\"").is_err());
    }

    #[test]
    fn venue_names_kinds_and_lists() {
        for venue in Venue::ALL {
            assert_eq!(json(&venue), format!("\"{}\"", venue.name()));
            assert_eq!(parse::<Venue>(&json(&venue)).unwrap(), venue);
        }
        let live = [
            Venue::Coinbase,
            Venue::Backpack,
            Venue::Jupiter,
            Venue::Raydium,
        ];
        assert_eq!(Venue::LIVE, live);
        assert_eq!(Venue::Coinbase.kind(), VenueKind::Cex);
        assert_eq!(Venue::Backpack.kind(), VenueKind::Cex);
        assert_eq!(Venue::Replay.kind(), VenueKind::Cex);
        assert_eq!(Venue::Jupiter.kind(), VenueKind::Dex);
        assert_eq!(Venue::Raydium.kind(), VenueKind::Dex);
    }

    #[test]
    fn small_enums_use_snake_case() {
        assert_eq!(json(&VenueStatusKind::Connecting), "\"connecting\"");
        assert_eq!(json(&PairHealth::Suspect), "\"suspect\"");
        assert_eq!(json(&CopilotAction::CreateStrategy), "\"create_strategy\"");
        assert_eq!(json(&AnalysisBias::Neutral), "\"neutral\"");
        assert_eq!(json(&ProviderId::Nvidia), "\"nvidia\"");
        assert_eq!(json(&TwapStatus::Canceled), "\"canceled\"");
    }

    #[test]
    fn ticker_and_news_item_round_trip() {
        let ticker = Ticker {
            open: Price(1),
            high: Price(3),
            low: Price(1),
            last: Price(2),
            volume: None,
            change_bps: -25,
            partial: true,
        };
        let expected = concat!(
            r#"{"open":"1","high":"3","low":"1","last":"2","volume":null,"#,
            r#""change_bps":-25,"partial":true}"#
        );
        assert_eq!(json(&ticker), expected);
        assert_eq!(parse::<Ticker>(expected).unwrap(), ticker);

        let item = NewsItem {
            id: "n1".into(),
            title: "t".into(),
            source: "s".into(),
            url: "https://example.com/a".into(),
            published_at: 5,
            symbols: vec!["BTC-USD".into()],
        };
        assert_eq!(parse::<NewsItem>(&json(&item)).unwrap(), item);
    }
}
