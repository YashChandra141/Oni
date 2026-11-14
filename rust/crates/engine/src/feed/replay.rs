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

use std::fmt;
use std::time::Duration;

use protocol::{ErrorCode, Event, MAX_REPLAY_SPEED, MIN_REPLAY_SPEED, TimeMs};

use super::fixture::{FixtureError, FixtureLine};

/// Market time added between the last line of one loop and the first line of the next, in ms.
pub const LOOP_GAP_MS: TimeMs = 1_000;

/// Longest `error` event message this module builds, in characters.
const MAX_MESSAGE_CHARS: usize = 400;

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

    #[test]
    fn long_messages_are_capped() {
        let event = error_event(ErrorCode::InvalidFixture, "x".repeat(10_000));
        let (_, text) = message(&event);
        assert_eq!(text.chars().count(), MAX_MESSAGE_CHARS);
        assert!(text.ends_with('…'));
    }
}
