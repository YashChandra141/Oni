//! Exact integer newtypes for prices, quantities, and money (Req 1.4).
//!
//! Each newtype wraps an `i64` and travels on the wire as a canonical decimal string such as
//! `"6400000"`, because JavaScript numbers lose precision above 2^53. TypeScript sees `string`
//! and converts with `BigInt`.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use ts_rs::TS;

/// Number of decimal places in a [`Money`] value: one unit is 10^-10 USD.
pub const MONEY_DECIMALS: u32 = 10;

macro_rules! decimal_string_newtype {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, TS)]
        #[ts(export, export_to = crate::TS_EXPORT_DIR)]
        pub struct $name(#[ts(type = "string")] pub i64);

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                fmt::Display::fmt(&self.0, f)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.collect_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = deserializer.deserialize_str(DecimalStringVisitor)?;
                Ok($name(value))
            }
        }
    };
}

decimal_string_newtype!(
    /// A price as a signed count of the symbol's Ticks.
    Price
);

decimal_string_newtype!(
    /// A quantity as a signed count of the symbol's Lots. Positions use the sign for direction.
    Qty
);

decimal_string_newtype!(
    /// An amount of USD in units of 10^-10 USD (see [`MONEY_DECIMALS`]).
    Money
);

/// Parses a canonical decimal integer string: optional `-`, digits, no leading zeros, no `+`,
/// no `-0`, no whitespace. Rejecting other spellings keeps encode/decode an exact round trip.
fn parse_canonical_i64(s: &str) -> Option<i64> {
    let n: i64 = s.parse().ok()?;
    (n.to_string() == s).then_some(n)
}

struct DecimalStringVisitor;

impl serde::de::Visitor<'_> for DecimalStringVisitor {
    type Value = i64;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a canonical decimal integer string such as \"6400000\"")
    }

    fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<i64, E> {
        match parse_canonical_i64(v) {
            Some(n) => Ok(n),
            None => Err(E::invalid_value(serde::de::Unexpected::Str(v), &self)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALUES: [i64; 6] = [0, 1, -1, 6_400_000, i64::MAX, i64::MIN];

    fn json<T: Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap()
    }

    fn round_trip<T: Serialize + for<'de> Deserialize<'de>>(value: &T) -> T {
        let text = json(value);
        serde_json::from_str(&text).unwrap()
    }

    fn rejects<T: for<'de> Deserialize<'de>>(input: &str) -> bool {
        serde_json::from_str::<T>(input).is_err()
    }

    #[test]
    fn newtypes_serialize_as_decimal_strings() {
        assert_eq!(json(&Price(6_400_000)), "\"6400000\"");
        assert_eq!(json(&Qty(-25)), "\"-25\"");
        assert_eq!(json(&Money(i64::MAX)), "\"9223372036854775807\"");
    }

    #[test]
    fn newtypes_round_trip_through_json() {
        for v in VALUES {
            assert_eq!(round_trip(&Price(v)), Price(v));
            assert_eq!(round_trip(&Qty(v)), Qty(v));
            assert_eq!(round_trip(&Money(v)), Money(v));
        }
    }

    #[test]
    fn newtypes_reject_numbers_and_non_canonical_strings() {
        let bad = [
            "6400000",
            "1.5",
            "null",
            "\"\"",
            "\"+5\"",
            "\"05\"",
            "\"-0\"",
            "\" 5\"",
            "\"1.5\"",
            "\"1e3\"",
            "\"9223372036854775808\"",
        ];
        for input in bad {
            assert!(rejects::<Price>(input), "Price accepted {input}");
            assert!(rejects::<Qty>(input), "Qty accepted {input}");
            assert!(rejects::<Money>(input), "Money accepted {input}");
        }
    }

    #[test]
    fn display_prints_the_raw_integer() {
        assert_eq!(Price(-42).to_string(), "-42");
        assert_eq!(Money::default().to_string(), "0");
    }
}
