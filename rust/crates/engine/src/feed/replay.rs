//! Replay feed timing (design §2 "Market feed → Replay", Req 6.1, 6.3, 6.4, 6.5).
//!
//! [`ReplaySchedule`] is pure: given the lines of a fixture and a speed, it yields each market
//! message together with the wall-clock delay to wait before releasing it. The runtime owns the
//! clock and the file I/O; this module never reads either.
//!
//! # Delays and rounding
//!
//! The delay before line `i` is the recorded gap `recv[i] - recv[i-1]` divided by the speed,
//! in whole milliseconds. Rounding is done on the running total, not per gap: the delay is
//! `floor((recv[i] - recv[0]) / speed) - floor((recv[i-1] - recv[0]) / speed)`. Each delay is
//! therefore the per-gap quotient rounded down or up by less than 1 ms, and the total wall time
//! never falls behind or runs ahead of `elapsed_market_time / speed` by 1 ms or more. Rounding
//! every gap down on its own would make a 50× replay of the demo fixture (about 155 ms between
//! lines, 3.1 ms after division) run roughly 15 % fast. The first message has no delay.
//!
//! # Looping
//!
//! When the last line has been released, replay starts again from line 0. Loop `k` (counting
//! from 0) shifts every `recv` and every message `ts` by `k * period`, where
//! `period = (last.recv - first.recv) + LOOP_GAP_MS`. Market time keeps increasing across loops,
//! so candles and the order book stay valid, and the first line of each loop (a book snapshot
//! in the demo fixture) resets the book cleanly. [`LOOP_GAP_MS`] is at least 1 ms, so even a
//! fixture whose lines all share one `recv` advances market time on every loop and waits
//! `LOOP_GAP_MS / speed` of wall time between loops instead of spinning.
//!
//! If a shift would overflow `i64`, the schedule ends instead of wrapping.
//!
//! # Time alignment
//!
//! [`align_to_now`] shifts a freshly loaded fixture so replay shows today's time: one offset, a
//! whole number of minutes, moves every `recv` and `ts` so the first line after the warm-up
//! lands in the current UTC minute. It takes the clock reading as an argument and is pure.

use std::fmt;
use std::time::Duration;

use protocol::{ErrorCode, Event, MAX_REPLAY_SPEED, MIN_REPLAY_SPEED, TimeMs};

use super::MarketMsg;
use super::fixture::{FixtureError, FixtureLine};

/// Market time added between the last line of one loop and the first line of the next, in ms.
pub const LOOP_GAP_MS: TimeMs = 1_000;

/// Longest `error` event message this module builds, in characters.
const MAX_MESSAGE_CHARS: usize = 400;

/// Replay warm-up window: the engine applies every first-loop line older than this, measured
/// back from the last line's `recv`, at once and without output (Req 2.3).
pub const WARMUP_WINDOW_MS: TimeMs = 30 * 60 * 1000;

/// Number of leading first-loop lines that belong to the warm-up: those with
/// `recv < last.recv - WARMUP_WINDOW_MS`. Depends only on the `recv` values, never on the speed.
/// Zero for a fixture whose span is at most [`WARMUP_WINDOW_MS`] and for an empty fixture.
pub fn warmup_len(lines: &[FixtureLine]) -> usize {
    let Some(last) = lines.last() else {
        return 0;
    };
    let Some(threshold) = last.recv.checked_sub(WARMUP_WINDOW_MS) else {
        return 0;
    };
    lines.iter().take_while(|l| l.recv < threshold).count()
}

/// One minute in ms. Replay time shifts are a whole number of these, so 1m candle boundaries
/// stay on minute boundaries.
const MINUTE_MS: TimeMs = 60_000;

/// `t` rounded down to a whole minute (towards negative infinity).
fn floor_minute(t: TimeMs) -> Option<TimeMs> {
    // For `t` near `i64::MIN` the floor can fall below `i64::MIN`, hence checked.
    t.div_euclid(MINUTE_MS).checked_mul(MINUTE_MS)
}

/// The shift that moves `first_live_recv` into the minute that contains `now_ms`:
/// `floor_minute(now_ms) - floor_minute(first_live_recv)`. Always a multiple of 60 000. `None`
/// if the subtraction overflows `i64`. Pure: the caller supplies the clock reading.
pub fn checked_align_offset(first_live_recv: TimeMs, now_ms: TimeMs) -> Option<TimeMs> {
    floor_minute(now_ms)?.checked_sub(floor_minute(first_live_recv)?)
}

/// Moves `recv` and the message's own `ts` of every line by `offset` ms. All or nothing: if any
/// value would overflow `i64`, returns the lines unchanged as `Err`.
pub fn shift_lines(
    lines: Vec<FixtureLine>,
    offset: TimeMs,
) -> Result<Vec<FixtureLine>, Vec<FixtureLine>> {
    let fits = lines
        .iter()
        .all(|l| l.recv.checked_add(offset).is_some() && l.msg.ts().checked_add(offset).is_some());
    if !fits {
        return Err(lines);
    }
    Ok(lines
        .into_iter()
        .filter_map(|l| {
            Some(FixtureLine {
                recv: l.recv.checked_add(offset)?,
                msg: l.msg.shifted(offset)?,
            })
        })
        .collect())
}

/// A fixture after time alignment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Aligned {
    pub lines: Vec<FixtureLine>,
    /// The shift applied to every `recv` and `ts`, in ms. 0 if none.
    pub offset: TimeMs,
    /// True if the shift would have overflowed, so `offset` is 0 and the lines are unchanged.
    pub overflowed: bool,
}

/// Shifts the whole fixture by one minute-multiple offset so that the first line after the
/// warm-up (`lines[warmup_len]`, or line 0 without a warm-up) falls in the minute of `now_ms`.
/// The warm-up length does not change, and every gap between lines is preserved. On overflow
/// the lines come back unshifted with `overflowed` set. Pure: `now_ms` comes from the caller.
pub fn align_to_now(lines: Vec<FixtureLine>, now_ms: TimeMs) -> Aligned {
    let k = warmup_len(&lines);
    let Some(first_live) = lines.get(k) else {
        return Aligned {
            lines,
            offset: 0,
            overflowed: false,
        };
    };
    let Some(offset) = checked_align_offset(first_live.recv, now_ms) else {
        return Aligned {
            lines,
            offset: 0,
            overflowed: true,
        };
    };
    match shift_lines(lines, offset) {
        Ok(lines) => Aligned {
            lines,
            offset,
            overflowed: false,
        },
        Err(lines) => Aligned {
            lines,
            offset: 0,
            overflowed: true,
        },
    }
}

/// One message ready for release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scheduled {
    /// Wall-clock time to wait after the previous message. Zero for the first message.
    pub delay: Duration,
    /// The fixture line with `recv` and `msg.ts` shifted for the current loop.
    pub line: FixtureLine,
}

/// Why a fixture cannot be replayed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduleError {
    /// The fixture holds no lines, so there is nothing to replay or loop.
    Empty,
    /// The speed is outside 1 to 50 (Req 6.4). `decode_command` already refuses these; this is
    /// a defensive check.
    SpeedOutOfRange(u32),
    /// `last.recv - first.recv + LOOP_GAP_MS` does not fit in `i64`.
    SpanTooLarge,
}

impl fmt::Display for ScheduleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("has no lines"),
            Self::SpeedOutOfRange(speed) => write!(
                f,
                "speed is {speed}, expected {MIN_REPLAY_SPEED} to {MAX_REPLAY_SPEED}"
            ),
            Self::SpanTooLarge => f.write_str("spans too much time to loop"),
        }
    }
}

impl std::error::Error for ScheduleError {}

/// Yields the lines of a fixture forever, looping with shifted times, with the wall-clock delay
/// before each one. See the module docs for the rules.
#[derive(Debug, Clone)]
pub struct ReplaySchedule {
    lines: Vec<FixtureLine>,
    speed: TimeMs,
    /// Market time between the start of one loop and the start of the next.
    period: TimeMs,
    /// `recv` of line 0 in loop 0; wall offsets count from it.
    origin: TimeMs,
    /// Index of the next line to release.
    index: usize,
    /// Number of completed loops.
    loop_index: TimeMs,
    /// Wall offset in ms of the last released message, or `None` before the first one.
    last_wall_ms: Option<TimeMs>,
    /// Set once a shift overflowed. The schedule then yields nothing more.
    ended: bool,
}

impl ReplaySchedule {
    /// Builds a schedule for `lines` (already validated by `read_fixture`, so `recv` never
    /// decreases) at `speed` times the recorded pace.
    pub fn new(lines: Vec<FixtureLine>, speed: u32) -> Result<Self, ScheduleError> {
        if !(MIN_REPLAY_SPEED..=MAX_REPLAY_SPEED).contains(&speed) {
            return Err(ScheduleError::SpeedOutOfRange(speed));
        }
        let (Some(first), Some(last)) = (lines.first(), lines.last()) else {
            return Err(ScheduleError::Empty);
        };
        let origin = first.recv;
        let span = last.recv.checked_sub(first.recv);
        let period = span.and_then(|span| span.checked_add(LOOP_GAP_MS));
        let period = period.ok_or(ScheduleError::SpanTooLarge)?;
        Ok(Self {
            lines,
            speed: TimeMs::from(speed),
            period,
            origin,
            index: 0,
            loop_index: 0,
            last_wall_ms: None,
            ended: false,
        })
    }

    /// Number of lines in one loop.
    pub fn lines_per_loop(&self) -> usize {
        self.lines.len()
    }

    /// Market time between the starts of two consecutive loops, in ms.
    pub fn period(&self) -> TimeMs {
        self.period
    }

    /// Removes the warm-up prefix of loop 0 and returns its messages, unshifted. Valid only
    /// before the first [`Iterator::next`]; afterwards, and when [`warmup_len`] is zero, it
    /// returns an empty Vec and changes nothing.
    ///
    /// After a non-empty call the schedule starts at line `k`: wall offsets count from
    /// `lines[k].recv`, so `lines[k]` has zero delay and the speed applies only to `lines[k..]`
    /// and to later loops. Later loops still replay the whole fixture, shifted by `period`.
    pub fn take_warmup(&mut self) -> Vec<MarketMsg> {
        if self.ended || self.index != 0 || self.loop_index != 0 || self.last_wall_ms.is_some() {
            return Vec::new();
        }
        let k = warmup_len(&self.lines);
        let Some(next) = self.lines.get(k) else {
            return Vec::new();
        };
        if k == 0 {
            return Vec::new();
        }
        self.origin = next.recv;
        self.index = k;
        self.last_wall_ms = None;
        self.lines
            .get(..k)
            .map(|prefix| prefix.iter().map(|l| l.msg.clone()).collect())
            .unwrap_or_default()
    }

    fn next_scheduled(&mut self) -> Option<Scheduled> {
        let line = self.lines.get(self.index)?;
        let offset = self.loop_index.checked_mul(self.period)?;
        let shifted = FixtureLine {
            recv: line.recv.checked_add(offset)?,
            msg: line.msg.clone().shifted(offset)?,
        };
        let wall_ms = shifted.recv.checked_sub(self.origin)? / self.speed;
        // Never negative: `recv` does not decrease within a loop, and each loop starts
        // `LOOP_GAP_MS` after the previous one ended.
        let delay_ms = self.last_wall_ms.map_or(0, |last| wall_ms - last).max(0);
        self.last_wall_ms = Some(wall_ms);
        self.index += 1;
        if self.index == self.lines.len() {
            self.index = 0;
            self.loop_index = self.loop_index.checked_add(1)?;
        }
        Some(Scheduled {
            delay: Duration::from_millis(u64::try_from(delay_ms).unwrap_or(0)),
            line: shifted,
        })
    }
}

impl Iterator for ReplaySchedule {
    type Item = Scheduled;

    /// The next message. Returns `None` only after a time shift would overflow `i64`.
    fn next(&mut self) -> Option<Scheduled> {
        if self.ended {
            return None;
        }
        let next = self.next_scheduled();
        if next.is_none() {
            self.ended = true;
        }
        next
    }
}

/// The `invalid_fixture` event for a fixture that could not be loaded (Req 6.5). The message
/// names the fixture, and for a parse error the 1-based line number. It does not include the
/// fixtures directory.
pub fn load_error_event(fixture: &str, err: &FixtureError) -> Event {
    let message = match err {
        FixtureError::Io { source, .. } if source.kind() == std::io::ErrorKind::NotFound => {
            format!("fixture {fixture:?} does not exist")
        }
        FixtureError::Io { source, .. } => format!("cannot read fixture {fixture:?}: {source}"),
        // Displays as `line N: reason`.
        FixtureError::Line { .. } | FixtureError::Encode(_) => {
            format!("fixture {fixture:?} cannot be parsed: {err}")
        }
    };
    error_event(ErrorCode::InvalidFixture, message)
}

/// The event for a fixture that loaded but cannot be scheduled.
pub fn schedule_error_event(fixture: &str, err: &ScheduleError) -> Event {
    let code = match err {
        ScheduleError::SpeedOutOfRange(_) => ErrorCode::OutOfRange,
        ScheduleError::Empty | ScheduleError::SpanTooLarge => ErrorCode::InvalidFixture,
    };
    error_event(code, format!("fixture {fixture:?} {err}"))
}

/// An `error` event with the message cut to [`MAX_MESSAGE_CHARS`] characters.
pub fn error_event(code: ErrorCode, message: String) -> Event {
    let message = match message.char_indices().nth(MAX_MESSAGE_CHARS - 1) {
        Some((cut, _)) => {
            let mut short = message.get(..cut).unwrap_or(&message).to_owned();
            short.push('…');
            short
        }
        None => message,
    };
    Event::Error { code, message }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::feed::MarketMsg;
    use crate::feed::fixture::{LineError, encode_fixture_line, parse_fixture};
    use protocol::{Level, Price, Qty, Side};

    /// The offset `align_to_now` applies, or 0 when it would overflow (what the runtime uses).
    fn align_offset(first_live_recv: TimeMs, now_ms: TimeMs) -> TimeMs {
        checked_align_offset(first_live_recv, now_ms).unwrap_or(0)
    }

    fn trade(recv: TimeMs, ts: TimeMs, price: i64) -> FixtureLine {
        FixtureLine {
            recv,
            msg: MarketMsg::Trade {
                symbol: "BTC-USD".into(),
                price: Price(price),
                qty: Qty(1),
                side: Side::Buy,
                ts,
            },
        }
    }

    fn trades_at(recvs: &[TimeMs]) -> Vec<FixtureLine> {
        recvs
            .iter()
            .zip(1..)
            .map(|(&recv, price)| trade(recv, recv, price))
            .collect()
    }

    /// A schedule of trades at `recvs`.
    fn schedule(recvs: &[TimeMs], speed: u32) -> ReplaySchedule {
        ReplaySchedule::new(trades_at(recvs), speed).unwrap()
    }

    fn delays_ms(schedule: ReplaySchedule, n: usize) -> Vec<u128> {
        schedule.take(n).map(|s| s.delay.as_millis()).collect()
    }

    #[test]
    fn delays_at_speed_1_are_the_recorded_gaps() {
        let delays = delays_ms(schedule(&[100, 100, 350, 1_350], 1), 4);
        assert_eq!(delays, [0, 0, 250, 1_000]);
    }

    #[test]
    fn delays_at_speed_50_are_divided_by_50() {
        let delays = delays_ms(schedule(&[0, 100, 150, 1_150], 50), 4);
        // Wall offsets 0, 2, 3, 23 ms.
        assert_eq!(delays, [0, 2, 1, 20]);
    }

    #[test]
    fn rounding_is_on_the_running_total() {
        // Every gap is 30 ms, 0.6 ms at 50×. Rounding each gap down would give all zeros.
        let delays = delays_ms(schedule(&[0, 30, 60, 90, 120], 50), 5);
        assert_eq!(delays, [0, 0, 1, 0, 1]);
        // The total is floor(120 / 50) = 2 ms: no drift.
        assert_eq!(delays.iter().sum::<u128>(), 2);
    }

    #[test]
    fn loops_shift_recv_and_ts_by_duration_plus_gap() {
        let lines = vec![trade(10, 5, 1), trade(20, 15, 2), trade(40, 35, 3)];
        let schedule = ReplaySchedule::new(lines.clone(), 1).unwrap();
        let period = 30 + LOOP_GAP_MS;
        assert_eq!(schedule.period(), period);
        assert_eq!(schedule.lines_per_loop(), 3);

        let out: Vec<Scheduled> = schedule.take(9).collect();
        for (i, s) in out.iter().enumerate() {
            let k = TimeMs::try_from(i / 3).unwrap();
            let original = &lines[i % 3];
            assert_eq!(s.line.recv, original.recv + k * period, "line {i}");
            assert_eq!(s.line.msg.ts(), original.msg.ts() + k * period, "line {i}");
            assert_eq!(
                s.line.msg,
                original.msg.clone().shifted(k * period).unwrap()
            );
        }
        let recvs: Vec<TimeMs> = out.iter().map(|s| s.line.recv).collect();
        assert!(recvs.windows(2).all(|w| w[0] < w[1]), "{recvs:?}");
        // Between loops the wait is the gap (at speed 1).
        assert_eq!(out[3].delay, Duration::from_millis(1_000));
        assert_eq!(out[6].delay, Duration::from_millis(1_000));
    }

    #[test]
    fn a_single_line_fixture_loops_with_a_non_zero_wait() {
        let out: Vec<Scheduled> = schedule(&[5], 50).take(4).collect();
        let recvs: Vec<TimeMs> = out.iter().map(|s| s.line.recv).collect();
        assert_eq!(recvs, [5, 1_005, 2_005, 3_005]);
        let delays: Vec<u128> = out.iter().map(|s| s.delay.as_millis()).collect();
        assert_eq!(delays, [0, 20, 20, 20]);
    }

    #[test]
    fn same_recv_lines_loop_with_a_non_zero_wait() {
        let same = schedule(&[7, 7, 7], 50);
        assert_eq!(same.period(), LOOP_GAP_MS);
        assert_eq!(delays_ms(same, 7), [0, 0, 0, 20, 0, 0, 20]);
    }

    #[test]
    fn snapshots_and_deltas_are_shifted_too() {
        let snapshot = FixtureLine {
            recv: 0,
            msg: MarketMsg::BookSnapshot {
                symbol: "ETH-USD".into(),
                bids: vec![Level {
                    price: Price(99),
                    qty: Qty(1),
                }],
                asks: Vec::new(),
                ts: 0,
            },
        };
        let delta = FixtureLine {
            recv: 10,
            msg: MarketMsg::BookDelta {
                symbol: "ETH-USD".into(),
                side: Side::Sell,
                price: Price(101),
                qty: Qty(2),
                ts: 9,
            },
        };
        let schedule = ReplaySchedule::new(vec![snapshot, delta], 1).unwrap();
        let ts: Vec<TimeMs> = schedule.take(4).map(|s| s.line.msg.ts()).collect();
        assert_eq!(ts, [0, 9, 1_010, 1_019]);
    }

    #[test]
    fn rejects_empty_fixtures_and_bad_speeds() {
        assert_eq!(
            ReplaySchedule::new(Vec::new(), 1).unwrap_err(),
            ScheduleError::Empty
        );
        for speed in [0, 51, u32::MAX] {
            let err = ReplaySchedule::new(trades_at(&[1]), speed).unwrap_err();
            assert_eq!(err, ScheduleError::SpeedOutOfRange(speed));
        }
        for speed in [1, 50] {
            assert!(ReplaySchedule::new(trades_at(&[1]), speed).is_ok());
        }
        let wide = vec![trade(TimeMs::MIN, 0, 1), trade(TimeMs::MAX, 0, 2)];
        assert_eq!(
            ReplaySchedule::new(wide, 1).unwrap_err(),
            ScheduleError::SpanTooLarge
        );
    }

    #[test]
    fn overflowing_shift_ends_the_schedule_instead_of_wrapping() {
        let near_max = TimeMs::MAX - 10;
        let mut late = schedule(&[near_max], 1);
        assert_eq!(late.next().map(|s| s.line.recv), Some(near_max));
        assert_eq!(late.next(), None);
        assert_eq!(late.next(), None);
    }

    fn message(event: &Event) -> (&ErrorCode, &str) {
        match event {
            Event::Error { code, message } => (code, message),
            other => panic!("not an error event: {other:?}"),
        }
    }

    #[test]
    fn missing_fixture_event_names_the_fixture_only() {
        let err = FixtureError::Io {
            action: "read",
            path: "/secret/dir/gone.jsonl".into(),
            source: std::io::ErrorKind::NotFound.into(),
        };
        let event = load_error_event("gone.jsonl", &err);
        let (code, text) = message(&event);
        assert_eq!(*code, ErrorCode::InvalidFixture);
        assert_eq!(text, r#"fixture "gone.jsonl" does not exist"#);
    }

    #[test]
    fn parse_error_event_includes_the_line_number() {
        let good = encode_fixture_line(&trade(1, 1, 1)).unwrap();
        let bytes = format!("{good}not json\n");
        let err = parse_fixture(bytes.as_bytes()).unwrap_err();
        let event = load_error_event("bad.jsonl", &err);
        let (code, text) = message(&event);
        assert_eq!(*code, ErrorCode::InvalidFixture);
        let expected = r#"fixture "bad.jsonl" cannot be parsed: line 2: invalid JSON"#;
        assert!(text.starts_with(expected), "{text}");
        let line = FixtureError::from(LineError::InvalidUtf8).with_line(9);
        let event = load_error_event("x.jsonl", &line);
        let (_, text) = message(&event);
        assert_eq!(
            text,
            r#"fixture "x.jsonl" cannot be parsed: line 9: line is not valid UTF-8"#
        );
    }

    #[test]
    fn schedule_error_events_use_matching_codes() {
        let empty = schedule_error_event("e.jsonl", &ScheduleError::Empty);
        let (code, text) = message(&empty);
        assert_eq!(*code, ErrorCode::InvalidFixture);
        assert_eq!(text, r#"fixture "e.jsonl" has no lines"#);
        let speed = schedule_error_event("e.jsonl", &ScheduleError::SpeedOutOfRange(0));
        assert_eq!(*message(&speed).0, ErrorCode::OutOfRange);
    }

    proptest::proptest! {
        // chart-and-tape-fix Property 9: Preservation (replay timing)
        // **Validates: Requirements 3.4, 3.5**
        #[test]
        fn p9_short_fixture_delays_match_the_recv_model_over_three_loops(
            start in 0i64..1_000_000_000_000,
            gaps in proptest::collection::vec(0i64..60_000, 1..30),
            speed in 1u32..=50,
        ) {
            let mut recvs = vec![start];
            for gap in &gaps {
                recvs.push(recvs.last().copied().unwrap() + gap);
            }
            let span = recvs.last().copied().unwrap() - start;
            proptest::prop_assume!(span <= 30 * 60 * 1000);
            let n = recvs.len();
            let lines = trades_at(&recvs);
            let schedule = ReplaySchedule::new(lines.clone(), speed).unwrap();
            let period = schedule.period();
            proptest::prop_assert_eq!(period, span + LOOP_GAP_MS);
            let out: Vec<Scheduled> = schedule.take(3 * n).collect();
            proptest::prop_assert_eq!(out.len(), 3 * n);

            let speed_ms = TimeMs::from(speed);
            let mut prev_wall: Option<TimeMs> = None;
            let mut prev_recv: Option<TimeMs> = None;
            for (i, s) in out.iter().enumerate() {
                let k = TimeMs::try_from(i / n).unwrap();
                let original = &lines[i % n];
                let recv = original.recv + k * period;
                proptest::prop_assert_eq!(s.line.recv, recv);
                proptest::prop_assert_eq!(s.line.msg.ts(), original.msg.ts() + k * period);
                let wall = (recv - start) / speed_ms;
                let expected = prev_wall.map_or(0, |p| wall - p);
                proptest::prop_assert_eq!(s.delay.as_millis(), u128::try_from(expected).unwrap());
                if let Some(p) = prev_recv {
                    proptest::prop_assert!(recv >= p);
                    if i % n == 0 {
                        // Market time strictly increases across loop boundaries.
                        proptest::prop_assert!(recv > p);
                    }
                }
                prev_wall = Some(wall);
                prev_recv = Some(recv);
            }
        }
    }

    // chart-and-tape-fix Property 2 (unit cases). Req 2.3, 2.4.
    #[test]
    fn warmup_len_boundary_is_exclusive_at_30_minutes() {
        // Exactly 30 minutes older than the last line: not warm-up.
        let exact = trades_at(&[0, WARMUP_WINDOW_MS]);
        assert_eq!(warmup_len(&exact), 0);
        // One ms more: the first line is warm-up.
        let over = trades_at(&[0, WARMUP_WINDOW_MS + 1]);
        assert_eq!(warmup_len(&over), 1);
        assert_eq!(warmup_len(&[]), 0);
    }

    #[test]
    fn take_warmup_moves_the_origin_and_gives_the_first_line_zero_delay() {
        let recvs = [1_000, 1_500, 3_000_000, 3_000_500];
        let lines = trades_at(&recvs);
        assert_eq!(warmup_len(&lines), 2);
        for speed in [1, 50] {
            let mut sched = ReplaySchedule::new(lines.clone(), speed).unwrap();
            let msgs = sched.take_warmup();
            assert_eq!(msgs, [lines[0].msg.clone(), lines[1].msg.clone()]);
            assert_eq!(sched.origin, 3_000_000);
            assert_eq!(sched.index, 2);
            // A second call changes nothing.
            assert!(sched.take_warmup().is_empty());
            let first = sched.next().unwrap();
            assert_eq!(first.line.recv, 3_000_000);
            assert_eq!(first.delay, Duration::ZERO);
            let second = sched.next().unwrap();
            assert_eq!(second.delay.as_millis(), u128::from(500 / speed));
        }
    }

    #[test]
    fn take_warmup_is_empty_without_warmup_or_after_the_first_line() {
        let mut short = schedule(&[0, 1_000], 1);
        assert!(short.take_warmup().is_empty());
        assert_eq!(short.origin, 0);
        assert_eq!(short.index, 0);

        let mut long = ReplaySchedule::new(trades_at(&[0, 5_000_000]), 1).unwrap();
        let _ = long.next();
        assert!(long.take_warmup().is_empty());
        assert_eq!(long.index, 1);
    }

    // chart-and-tape-fix Property 12 (unit cases). Req 2.12, 3.15.
    #[test]
    fn align_offset_is_a_minute_multiple_and_lands_in_nows_minute() {
        let first: TimeMs = 1_700_000_012_345;
        let now: TimeMs = 1_800_000_099_999;
        let offset = align_offset(first, now);
        assert_eq!(offset % MINUTE_MS, 0);
        assert_eq!(
            (first + offset).div_euclid(MINUTE_MS),
            now.div_euclid(MINUTE_MS)
        );
        // Already in the right minute: no shift.
        assert_eq!(align_offset(now, now), 0);
        // Negative offset: a fixture from the future moves back.
        assert!(align_offset(now, first) < 0);
        assert_eq!(align_offset(now, first) % MINUTE_MS, 0);
    }

    #[test]
    fn align_offset_gives_zero_on_overflow() {
        assert_eq!(checked_align_offset(TimeMs::MIN, TimeMs::MAX), None);
        assert_eq!(align_offset(TimeMs::MIN, TimeMs::MAX), 0);
        // The offset fits, but shifting the later line by it does not.
        let wide = vec![trade(0, 0, 1), trade(1_000_000, 1_000_000, 2)];
        let aligned = align_to_now(wide.clone(), TimeMs::MAX);
        assert_eq!(aligned.lines, wide);
        assert_eq!(aligned.offset, 0);
        assert!(aligned.overflowed);
    }

    #[test]
    fn align_to_now_shifts_recv_and_ts_and_keeps_deltas_and_warmup() {
        // Two warm-up lines, then the live part starting at 3_000_000 (not on a minute).
        let lines = vec![
            trade(1_000, 990, 1),
            trade(1_500, 1_490, 2),
            trade(3_000_017, 3_000_000, 3),
            trade(3_000_500, 3_000_480, 4),
        ];
        let k = warmup_len(&lines);
        assert_eq!(k, 2);
        let now = 1_800_000_030_000;
        let aligned = align_to_now(lines.clone(), now);
        assert!(!aligned.overflowed);
        assert_eq!(aligned.offset % MINUTE_MS, 0);
        assert_eq!(warmup_len(&aligned.lines), k);
        assert_eq!(
            aligned.lines[k].recv.div_euclid(MINUTE_MS),
            now.div_euclid(MINUTE_MS)
        );
        for (old, new) in lines.iter().zip(&aligned.lines) {
            assert_eq!(new.recv - old.recv, aligned.offset);
            assert_eq!(new.msg.ts() - old.msg.ts(), aligned.offset);
        }
        // The schedule still starts at line k with zero delay and keeps its gaps.
        let mut sched = ReplaySchedule::new(aligned.lines, 1).unwrap();
        assert_eq!(sched.take_warmup().len(), k);
        let first = sched.next().unwrap();
        assert_eq!(first.delay, Duration::ZERO);
        assert_eq!(sched.next().unwrap().delay, Duration::from_millis(483));
    }

    #[test]
    fn align_to_now_without_warmup_uses_line_zero_and_empty_is_a_no_op() {
        let lines = trades_at(&[10_000, 70_000]);
        let now = 5 * MINUTE_MS + 1;
        let aligned = align_to_now(lines.clone(), now);
        // offset = floor_minute(now) - floor_minute(line 0) = 300_000: the line keeps its
        // 10 s position inside the minute, so it lands in now's minute, not on its start.
        assert_eq!(aligned.offset, 5 * MINUTE_MS);
        assert_eq!(aligned.lines[0].recv, 5 * MINUTE_MS + 10_000);
        assert_eq!(aligned.lines[1].recv, 5 * MINUTE_MS + 70_000);
        assert_eq!(
            aligned.lines[0].recv.div_euclid(MINUTE_MS),
            now.div_euclid(MINUTE_MS)
        );
        for (old, new) in lines.iter().zip(&aligned.lines) {
            assert_eq!(new.msg.ts() - old.msg.ts(), aligned.offset);
        }
        let empty = align_to_now(Vec::new(), 123);
        assert!(empty.lines.is_empty() && empty.offset == 0 && !empty.overflowed);
    }

    proptest::proptest! {
        #![proptest_config(proptest::prelude::ProptestConfig::with_cases(64))]

        // chart-and-tape-fix Property 12: replay time alignment
        // **Validates: Requirements 2.12, 3.15**
        #[test]
        fn p12_alignment_puts_the_first_live_line_in_nows_minute(
            start in 0i64..2_000_000_000_000,
            gaps in proptest::collection::vec(0i64..600_000, 1..40),
            now in 0i64..4_000_000_000_000,
        ) {
            let mut recvs = vec![start];
            for gap in &gaps {
                recvs.push(recvs.last().copied().unwrap() + gap);
            }
            let lines: Vec<FixtureLine> = recvs
                .iter()
                .zip(1..)
                .map(|(&recv, price)| trade(recv, recv - 5, price))
                .collect();
            let k = warmup_len(&lines);
            let aligned = align_to_now(lines.clone(), now);

            proptest::prop_assert!(!aligned.overflowed);
            proptest::prop_assert_eq!(aligned.offset % MINUTE_MS, 0);
            proptest::prop_assert_eq!(warmup_len(&aligned.lines), k);
            proptest::prop_assert_eq!(aligned.lines.len(), lines.len());
            proptest::prop_assert_eq!(
                aligned.lines[k].recv.div_euclid(MINUTE_MS),
                now.div_euclid(MINUTE_MS)
            );
            for (old, new) in lines.iter().zip(&aligned.lines) {
                proptest::prop_assert_eq!(new.recv - old.recv, aligned.offset);
                proptest::prop_assert_eq!(new.msg.ts() - old.msg.ts(), aligned.offset);
            }
        }
    }

    #[test]
    fn long_messages_are_capped() {
        let event = error_event(ErrorCode::InvalidFixture, "x".repeat(10_000));
        let (_, text) = message(&event);
        assert_eq!(text.chars().count(), MAX_MESSAGE_CHARS);
        assert!(text.ends_with('…'));
    }
}
