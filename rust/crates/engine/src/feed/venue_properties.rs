//! Property tests for the venue layer (Task 7.3; Req 44.2, 44.5, 44.6; design P33, Decision A6).

use super::*;
use proptest::prelude::*;

/// Renders `value` scaled by 10^`decimals` as `int.frac` using integer arithmetic only.
fn fmt_scaled(value: u128, decimals: u32) -> String {
    let scale = 10u128.pow(decimals);
    format!(
        "{}.{:0width$}",
        value / scale,
        value % scale,
        width = decimals as usize
    )
}

/// Independent validator for the strict grammar `digits [ "." digits ]` (ASCII digits only).
fn matches_grammar(text: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let mut parts = text.split('.');
    let int_part = parts.next().unwrap_or("");
    match (parts.next(), parts.next()) {
        (None, _) => digits(int_part),
        (Some(frac), None) => digits(int_part) && digits(frac),
        _ => false,
    }
}

fn venues() -> impl Strategy<Value = Venue> {
    prop::sample::select(vec![Venue::Coinbase, Venue::Backpack])
}

fn weird_text() -> impl Strategy<Value = String> {
    let alphabet: Vec<char> = vec![
        '0', '1', '5', '9', '.', '.', '-', '+', 'e', 'E', ' ', 'a', 'x', '\u{FF11}', '\u{0663}',
        ',',
    ];
    prop::collection::vec(prop::sample::select(alphabet), 0..14)
        .prop_map(|chars| chars.into_iter().collect::<String>())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    // Property P33 — validates Req 44.2, 44.5
    // Round trip: a value rendered with exactly the fixed decimals converts back to itself.
    #[test]
    fn p33_ticks_round_trip(n in 0i64..=i64::MAX) {
        let s = fmt_scaled(n as u128, PRICE_DECIMALS);
        prop_assert_eq!(to_ticks(&s, PRICE_DECIMALS), Ok(Price(n)), "{}", s);
    }

    // Property P33 — validates Req 44.2, 44.5
    #[test]
    fn p33_lots_round_trip(n in 0i64..=i64::MAX) {
        let s = fmt_scaled(n as u128, QTY_DECIMALS);
        prop_assert_eq!(to_lots(&s, QTY_DECIMALS), Ok(Qty(n)), "{}", s);
    }

    // Property P33 — validates Req 44.2, 44.5
    // Trailing zeros, a missing fraction, and leading integer zeros do not change the value
    // (venue.rs accepts leading zeros such as "007.50").
    #[test]
    fn p33_trailing_zeros_missing_fraction_leading_zeros(
        n in 0i64..=i64::MAX,
        zeros in 0usize..12,
        lead in 0usize..5,
        whole in 0i64..=(i64::MAX / 100_000_000),
    ) {
        let s = fmt_scaled(n as u128, PRICE_DECIMALS);
        let padded = format!("{s}{}", "0".repeat(zeros));
        prop_assert_eq!(to_ticks(&padded, PRICE_DECIMALS), Ok(Price(n)));
        let led = format!("{}{s}", "0".repeat(lead));
        prop_assert_eq!(to_ticks(&led, PRICE_DECIMALS), Ok(Price(n)));

        let plain = whole.to_string();
        prop_assert_eq!(to_ticks(&plain, PRICE_DECIMALS), Ok(Price(whole * 100)));
        prop_assert_eq!(to_lots(&plain, QTY_DECIMALS), Ok(Qty(whole * 100_000_000)));
    }

    // Property P33 — validates Req 44.2, 44.5
    // Extra fractional digits: any non-zero extra digit gives Inexact, all-zero extras are Ok.
    #[test]
    fn p33_extra_digits_inexact_or_ok(
        n in 0i64..=i64::MAX,
        extra in prop::collection::vec(0u8..10, 1..7),
        qty in any::<bool>(),
    ) {
        let decimals = if qty { QTY_DECIMALS } else { PRICE_DECIMALS };
        let extra_text: String = extra.iter().map(|d| char::from(b'0' + d)).collect();
        let s = format!("{}{extra_text}", fmt_scaled(n as u128, decimals));
        let result = if qty {
            to_lots(&s, decimals).map(|q| q.0)
        } else {
            to_ticks(&s, decimals).map(|p| p.0)
        };
        if extra.iter().any(|d| *d != 0) {
            prop_assert_eq!(result, Err(VenueError::Inexact), "{}", s);
        } else {
            prop_assert_eq!(result, Ok(n), "{}", s);
        }
    }

    // Property P33 — validates Req 44.2, 44.5
    // Arbitrary text never panics; Ok or Inexact/Overflow only for the strict grammar, and
    // every string outside the grammar is Malformed.
    #[test]
    fn p33_malformed_text(text in weird_text()) {
        let valid = matches_grammar(&text);
        for result in [
            to_ticks(&text, PRICE_DECIMALS).map(|p| p.0),
            to_lots(&text, QTY_DECIMALS).map(|q| q.0),
        ] {
            if valid {
                prop_assert_ne!(result, Err(VenueError::Malformed), "{:?}", text);
            } else {
                prop_assert_eq!(result, Err(VenueError::Malformed), "{:?}", text);
            }
        }
    }

    // Property P33 — validates Req 44.2, 44.5
    // Values above i64::MAX overflow, for both fixed decimals and with leading zeros.
    #[test]
    fn p33_overflow(excess in 1u128..=10u128.pow(30), lead in 0usize..4, qty in any::<bool>()) {
        let value = i64::MAX as u128 + excess;
        let decimals = if qty { QTY_DECIMALS } else { PRICE_DECIMALS };
        let s = format!("{}{}", "0".repeat(lead), fmt_scaled(value, decimals));
        let result = if qty {
            to_lots(&s, decimals).map(|q| q.0)
        } else {
            to_ticks(&s, decimals).map(|p| p.0)
        };
        prop_assert_eq!(result, Err(VenueError::Overflow), "{}", s);
    }

    // Property P33 — validates Req 44.6
    // from_venue_symbol inverts to_venue_symbol, and distinct internal symbols never share a
    // venue symbol.
    #[test]
    fn p33_symbol_map_round_trip_and_injective(
        venue in venues(),
        i in 0usize..INSTRUMENTS.len(),
        j in 0usize..INSTRUMENTS.len(),
    ) {
        let symbols: Vec<&'static str> = INSTRUMENTS.iter().map(|x| x.symbol).collect();
        let a = symbols[i];
        let b = symbols[j];
        // A venue may not list a symbol (Coinbase has no JUP-USD product): only the listed
        // symbols round-trip, and unlisted ones are skipped.
        if let Some(va) = to_venue_symbol(venue, a) {
            prop_assert_eq!(from_venue_symbol(venue, va), Some(a));
            if a != b
                && let Some(vb) = to_venue_symbol(venue, b)
            {
                prop_assert_ne!(va, vb);
            }
        }
    }

    // Property P33 — validates Req 44.6
    // Strings outside the table map to None in both directions.
    #[test]
    fn p33_symbol_map_unknown_is_none(venue in venues(), text in "\\PC{0,12}") {
        let known_internal = INSTRUMENTS.iter().any(|x| x.symbol == text);
        let known_venue = INSTRUMENTS
            .iter()
            .filter_map(|x| to_venue_symbol(venue, x.symbol))
            .any(|v| v == text);
        if !known_internal {
            prop_assert_eq!(to_venue_symbol(venue, &text), None);
        }
        if !known_venue {
            prop_assert_eq!(from_venue_symbol(venue, &text), None);
        }
    }

    // Property P33 — validates Req 44.2, 44.5
    // DropStats: should_log fires at most once per 10 s of simulated time, only when drops are
    // pending, and no record is ever lost.
    #[test]
    fn p33_drop_stats_rate_limit_and_no_loss(
        start in 0i64..1_000_000,
        ops in prop::collection::vec((any::<bool>(), 0i64..15_000), 0..60),
        venue in venues(),
    ) {
        let mut stats = DropStats::new();
        let mut now = start;
        let mut recorded = 0u64;
        let mut pending = false;
        let mut last_logged: Option<i64> = None;
        for (record, advance) in ops {
            now += advance;
            if record {
                stats.record(venue, "BTC-USD", VenueError::Inexact);
                recorded += 1;
                pending = true;
            }
            let logged = stats.should_log(now);
            if logged {
                prop_assert!(pending, "logged with nothing pending");
                if let Some(prev) = last_logged {
                    prop_assert!(now - prev >= DROP_LOG_INTERVAL_MS);
                }
                last_logged = Some(now);
                pending = false;
            }
            prop_assert_eq!(stats.total(), recorded);
        }
        // Ten seconds later a line is due exactly when drops are still pending.
        prop_assert_eq!(stats.should_log(now + DROP_LOG_INTERVAL_MS), pending);
        prop_assert_eq!(stats.total(), recorded);
    }
}

#[test]
fn p33_i64_max_boundary_is_exact() {
    assert_eq!(
        to_ticks(
            &fmt_scaled(i64::MAX as u128, PRICE_DECIMALS),
            PRICE_DECIMALS
        ),
        Ok(Price(i64::MAX))
    );
    assert_eq!(
        to_ticks(
            &fmt_scaled(i64::MAX as u128 + 1, PRICE_DECIMALS),
            PRICE_DECIMALS
        ),
        Err(VenueError::Overflow)
    );
    assert_eq!(
        to_lots(&fmt_scaled(i64::MAX as u128, QTY_DECIMALS), QTY_DECIMALS),
        Ok(Qty(i64::MAX))
    );
    assert_eq!(
        to_lots(
            &fmt_scaled(i64::MAX as u128 + 1, QTY_DECIMALS),
            QTY_DECIMALS
        ),
        Err(VenueError::Overflow)
    );
}
