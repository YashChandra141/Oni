//! Property and golden tests for the Indicator_Engine (Task 9.2, Req 10.3, 10.4, 10.5).
//!
//! Property P11: EMA within [min, max] of the inputs seen.
//! Property P12: RSI within [0, 100].
//! Property P13: incremental SMA equals the naive mean of the window.

use proptest::prelude::*;

use super::*;

const CASES: u32 = 256;
const MAX_PRICE: u32 = 1_000_000_000;
const MINUTE: TimeMs = 60_000;

/// Sequences of 1..200 closes in ticks: plain random, runs of constants, and extreme jumps.
fn closes_strategy() -> impl Strategy<Value = Vec<u32>> {
    prop_oneof![
        prop::collection::vec(1u32..=MAX_PRICE, 1..200),
        prop::collection::vec((1u32..=MAX_PRICE, 1usize..40), 1..8).prop_map(|runs| {
            runs.into_iter()
                .flat_map(|(v, n)| std::iter::repeat_n(v, n))
                .take(199)
                .collect::<Vec<_>>()
        }),
        prop::collection::vec(prop_oneof![Just(1u32), Just(MAX_PRICE)], 1..200),
    ]
}

/// Peeked "next bar" closes, one per step (200 is above any sequence length).
fn peeks_strategy() -> impl Strategy<Value = Vec<u32>> {
    prop::collection::vec(1u32..=MAX_PRICE, 200)
}

/// One generated bar: close, high/low spreads, volume, and minutes to advance the start time
/// (0 = same start, an update of the forming bar; 1500 crosses a UTC day boundary).
fn bar_steps_strategy() -> impl Strategy<Value = Vec<(u32, u32, u32, u32, i64)>> {
    let step = prop_oneof![Just(0i64), Just(1), Just(1), Just(1), Just(2), Just(1500)];
    prop::collection::vec(
        (1u32..=MAX_PRICE, 0u32..1000, 0u32..1000, 0u32..1_000_000, step),
        1..120,
    )
}

fn within(v: f64, lo: f64, hi: f64) -> bool {
    // Rounding in `prev + alpha * (close - prev)` can land a hair outside [lo, hi].
    let tol = 1e-9 * v.abs().max(1.0);
    v >= lo - tol && v <= hi + tol
}

fn rsi_ok(v: Option<f64>) -> bool {
    v.is_none_or(|r| r.is_finite() && (0.0..=100.0).contains(&r))
}

fn rel_close(a: f64, b: f64, rel: f64) -> bool {
    (a - b).abs() <= rel * a.abs().max(b.abs()).max(1.0)
}

fn naive_mean(xs: &[f64]) -> f64 {
    xs.iter().sum::<f64>() / f64::from(u32::try_from(xs.len()).unwrap_or(u32::MAX))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(CASES))]

    // Property P11 — validates Req 10.3
    // Committed EMA and peeked EMA are Some and within [min, max] of all inputs seen (with the
    // peeked bar included for peeks). Tolerance: 1e-9 * max(1, |value|) for rounding.
    // Interleaved peeks must not change the committed results (exact equality).
    #[test]
    fn p11_ema_within_input_bounds(closes in closes_strategy(), peeks in peeks_strategy()) {
        let mut plain = Ema::new(EMA_PERIOD);
        let mut peeking = Ema::new(EMA_PERIOD);
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        let mut out_plain = Vec::new();
        let mut out_peeking = Vec::new();
        for (i, &c) in closes.iter().enumerate() {
            let cf = f64::from(c);
            let pk = f64::from(peeks[i]);

            let peeked = peeking.peek(pk);
            prop_assert!(peeked.is_some());
            if let Some(v) = peeked {
                prop_assert!(within(v, lo.min(pk), hi.max(pk)), "peek {v} outside [{}, {}]", lo.min(pk), hi.max(pk));
            }

            lo = lo.min(cf);
            hi = hi.max(cf);
            // The value after committing `c` is what `peek(c)` returns before the commit.
            let a = plain.peek(cf);
            prop_assert!(a.is_some());
            if let Some(v) = a {
                prop_assert!(within(v, lo, hi), "ema {v} outside [{lo}, {hi}]");
            }
            plain.commit(cf);
            out_plain.push(a);

            out_peeking.push(peeking.peek(cf));
            peeking.commit(cf);
        }
        prop_assert_eq!(out_plain, out_peeking);
    }

    // Property P12 — validates Req 10.4
    // Every committed-path or peeked RSI value is None or finite and within [0, 100].
    #[test]
    fn p12_rsi_within_range(closes in closes_strategy(), peeks in peeks_strategy()) {
        let mut rsi = Rsi::new(RSI_PERIOD);
        for (i, &c) in closes.iter().enumerate() {
            let cf = f64::from(c);
            prop_assert!(rsi_ok(rsi.peek(f64::from(peeks[i]))));
            prop_assert!(rsi_ok(rsi.peek(cf)));
            rsi.commit(cf);
        }
    }

    // Property P13 — validates Req 10.5
    // With n committed closes before the step: peek(c) is Some iff n + 1 >= 20 and then equals
    // the naive mean of the last 20 of (committed closes + c). Peek with another close equals
    // the mean of the last 19 committed closes plus that close. Relative tolerance 1e-6.
    #[test]
    fn p13_sma_matches_naive_mean(closes in closes_strategy(), peeks in peeks_strategy()) {
        let mut sma = Sma::new(SMA_PERIOD);
        let all: Vec<f64> = closes.iter().map(|&c| f64::from(c)).collect();
        for (i, &cf) in all.iter().enumerate() {
            let pk = f64::from(peeks[i]);

            let got_peek = sma.peek(pk);
            if i + 1 >= SMA_PERIOD {
                // The last 19 committed closes (indices i-19..i, valid since i >= 19) plus the peek.
                let mut tail: Vec<f64> = all[i - (SMA_PERIOD - 1)..i].to_vec();
                tail.push(pk);
                let want = naive_mean(&tail);
                prop_assert!(got_peek.is_some_and(|g| rel_close(g, want, 1e-6)), "{got_peek:?} vs {want}");
            } else {
                prop_assert_eq!(got_peek, None);
            }

            let got = sma.peek(cf);
            if i + 1 >= SMA_PERIOD {
                let want = naive_mean(&all[i + 1 - SMA_PERIOD..=i]);
                prop_assert!(got.is_some_and(|g| rel_close(g, want, 1e-6)), "{got:?} vs {want}");
            } else {
                prop_assert_eq!(got, None);
            }

            sma.commit(cf);
            prop_assert_eq!(sma.window().closes().len(), (i + 1).min(SMA_PERIOD));
        }
    }

    // Bollinger consistency (Req 10.1): mid equals the SMA, bands are symmetric around mid, and
    // Some exactly when the SMA is Some.
    #[test]
    fn bollinger_is_consistent_with_sma(closes in closes_strategy()) {
        let mut sma = Sma::new(SMA_PERIOD);
        let mut bb = Bollinger::new(BOLLINGER_PERIOD, BOLLINGER_K);
        for &c in &closes {
            let cf = f64::from(c);
            let s = sma.peek(cf);
            let b = bb.peek(cf);
            prop_assert_eq!(s.is_some(), b.is_some());
            if let (Some(s), Some(b)) = (s, b) {
                prop_assert!(rel_close(b.mid, s, 1e-12));
                prop_assert!(b.upper >= b.mid - 1e-9 * b.mid.abs().max(1.0));
                prop_assert!(b.lower <= b.mid + 1e-9 * b.mid.abs().max(1.0));
                let up = b.upper - b.mid;
                let down = b.mid - b.lower;
                prop_assert!(rel_close(up, down, 1e-6), "{up} vs {down}");
            }
            sma.commit(cf);
            bb.commit(cf);
        }
    }

    // Bollinger width is zero for constant input (Req 10.1).
    #[test]
    fn bollinger_width_is_zero_for_constant_input(v in 1u32..=MAX_PRICE, n in 20usize..60) {
        let vf = f64::from(v);
        let mut bb = Bollinger::new(BOLLINGER_PERIOD, BOLLINGER_K);
        for _ in 0..n {
            bb.commit(vf);
        }
        let b = bb.peek(vf).expect("window is full");
        prop_assert!(rel_close(b.upper, vf, 1e-12));
        prop_assert!(rel_close(b.mid, vf, 1e-12));
        prop_assert!(rel_close(b.lower, vf, 1e-12));
    }

    // No NaN or infinity from SymbolIndicators::update for any valid bar sequence, and RSI stays
    // in [0, 100] (Req 10.1, 10.4). Includes same-start updates and UTC day changes.
    #[test]
    fn update_never_returns_non_finite(steps in bar_steps_strategy()) {
        let mut ind = SymbolIndicators::default();
        let mut t: TimeMs = 0;
        for (close, hi, lo, vol, dt) in steps {
            t += dt * MINUTE;
            let close = i64::from(close);
            let bar = Bar {
                t,
                open: Price(close),
                high: Price(close + i64::from(hi)),
                low: Price((close - i64::from(lo)).max(1)),
                close: Price(close),
                volume: Qty(i64::from(vol)),
            };
            let values = ind.update(&bar).expect("times never go backwards");
            for v in [
                values.ema, values.sma, values.vwap, values.bb_upper,
                values.bb_mid, values.bb_lower, values.rsi, values.atr,
            ]
            .into_iter()
            .flatten()
            {
                prop_assert!(v.is_finite());
            }
            prop_assert!(rsi_ok(values.rsi));
        }
    }
}

fn approx(a: Option<f64>, b: f64) {
    match a {
        Some(a) => assert!((a - b).abs() < 1e-9, "{a} vs {b}"),
        None => panic!("expected {b}, got None"),
    }
}

fn ohlcv(t: TimeMs, high: f64, low: f64, close: f64, volume: f64) -> Ohlcv {
    Ohlcv {
        t,
        high,
        low,
        close,
        volume,
    }
}

// Golden: SMA(20) over closes 1..=20 is (1 + 2 + ... + 20) / 20 = 210 / 20 = 10.5 ticks.
#[test]
fn golden_sma_20_of_1_to_20() {
    let mut sma = Sma::new(SMA_PERIOD);
    for c in 1..=19 {
        sma.commit(f64::from(c));
        assert_eq!(sma.peek(f64::from(c + 1)).is_some(), c + 1 >= 20);
    }
    approx(sma.peek(20.0), 10.5);
    sma.commit(20.0);
    // Window 2..=21 sums to 230, mean 11.5.
    approx(sma.peek(21.0), 11.5);
}

// Golden: EMA over constant closes stays exactly at the constant: x + alpha * (x - x) = x.
#[test]
fn golden_ema_20_constant_is_constant() {
    let mut ema = Ema::new(EMA_PERIOD);
    for _ in 0..99 {
        ema.commit(100.0);
    }
    approx(ema.peek(100.0), 100.0);
}

// Golden: RSI(14), closes 100, 101, ..., 114 (14 gains of +1), then a close of 113 (loss of 1).
// Seed after 14 changes: avg_gain = 14 / 14 = 1, avg_loss = 0, so RSI = 100.
// Wilder step with the loss:
//   avg_gain = (1 * 13 + 0) / 14 = 13/14, avg_loss = (0 * 13 + 1) / 14 = 1/14.
// RS = 13, RSI = 100 - 100 / (1 + 13) = 100 - 100/14 = 650/7 = 92.857142857...
#[test]
fn golden_rsi_14_fourteen_gains_then_a_loss() {
    let mut rsi = Rsi::new(RSI_PERIOD);
    for c in 100..=112 {
        rsi.commit(f64::from(c));
    }
    // 13 closes committed (12 changes): the peeked 14th close gives 13 changes, not seeded.
    assert_eq!(rsi.peek(113.0), None);
    rsi.commit(113.0);
    // 14 closes committed (13 changes): the peeked 15th close makes the 14th change, the seed.
    approx(rsi.peek(114.0), 100.0);
    rsi.commit(114.0);
    approx(rsi.peek(115.0), 100.0);
    approx(rsi.peek(113.0), 650.0 / 7.0);
}

#[test]
fn rsi_rising_falling_and_constant_sequences() {
    let run = |closes: Vec<f64>| {
        let mut rsi = Rsi::new(RSI_PERIOD);
        let mut last = None;
        for c in closes {
            last = rsi.peek(c);
            rsi.commit(c);
        }
        last
    };
    approx(run((1..=40).map(f64::from).collect()), 100.0);
    approx(run((1..=40).rev().map(f64::from).collect()), 0.0);
    approx(run(vec![7.0; 40]), 50.0);
}

// Golden: ATR(14) on bars with range 10 around a constant close of 100 (high 105, low 95).
// Each true range = max(10, |105 - 100|, |95 - 100|) = 10. 15 bars give 14 true ranges, so the
// seed is 14 * 10 / 14 = 10, and Wilder smoothing keeps (10 * 13 + 10) / 14 = 10.
#[test]
fn golden_atr_14_constant_range() {
    let mut atr = Atr::new(ATR_PERIOD);
    for i in 0..14 {
        let b = ohlcv(i * MINUTE, 105.0, 95.0, 100.0, 1.0);
        assert_eq!(atr.peek(&b), None);
        atr.commit(&b);
    }
    approx(atr.peek(&ohlcv(14 * MINUTE, 105.0, 95.0, 100.0, 1.0)), 10.0);
    atr.commit(&ohlcv(14 * MINUTE, 105.0, 95.0, 100.0, 1.0));
    approx(atr.peek(&ohlcv(15 * MINUTE, 105.0, 95.0, 100.0, 1.0)), 10.0);
}

// Golden: VWAP. Bar 1: typical 30, volume 2. Bar 2: typical 60, volume 2, same UTC day.
// (30 * 2 + 60 * 2) / (2 + 2) = 180 / 4 = 45. A bar on the next UTC day resets the sums, so a
// lone bar of typical 100 and volume 1 gives 100.
#[test]
fn golden_vwap_two_bars_and_day_reset() {
    let mut vwap = Vwap::new();
    let b1 = ohlcv(0, 30.0, 30.0, 30.0, 2.0);
    let b2 = ohlcv(MINUTE, 60.0, 60.0, 60.0, 2.0);
    let next_day = ohlcv(DAY_MS, 100.0, 100.0, 100.0, 1.0);
    vwap.commit(&b1);
    approx(vwap.peek(&b2), 45.0);
    vwap.commit(&b2);
    approx(vwap.peek(&next_day), 100.0);
}
