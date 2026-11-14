//! Property test P7 from the design's property table (Task 4.5): the engine core is
//! deterministic (Req 6.6).
//!
//! A case is a fixture and a list of `subscribe` / `unsubscribe` Commands for random
//! (symbol, timeframe) keys, each inserted at a random position among the fixture's messages.
//! The fixture is one of:
//! - lines from [`valid_market_msg`] with random `recv` gaps of 0 to 5 s, either keeping the
//!   generated `ts` (any i64, so most trades are late, dropped, or out of range) or with `ts`
//!   set to `recv` (time-ordered, so candles build and live updates flow);
//! - [`synth`] output for a random seed, a duration of 0 to 3 minutes, and 1 to 3 symbols.
//!
//! The property drives [`Engine::on_command`] and [`Engine::on_market`] directly, without the
//! async runtime, and checks:
//! 1. two fresh engines fed the same merged input produce the same Events, excluding
//!    Heartbeat (the core emits none; the runtime adds them from the wall clock);
//! 2. [`ReplaySchedule`] at speed 1 and at speed 50 releases the same lines, over two full
//!    loops and the first line of a third, and the first loop is the fixture itself;
//! 3. the engine fed the speed-1 lines and the engine fed the speed-50 lines, with the same
//!    Commands at the same positions, produce the same Events.
//!
//! The property runs proptest's default 256 cases.

use proptest::collection::vec;
use proptest::prelude::*;
use proptest::sample::{Index, select, subsequence};
use protocol::{Command, Event, TimeMs, Timeframe};

use super::Engine;
use crate::feed::MarketMsg;
use crate::feed::fixture::FixtureLine;
use crate::feed::replay::ReplaySchedule;
use crate::feed::strategies::{known_symbol, valid_market_msg};
use crate::feed::synth::{DEFAULT_START_MS, SynthConfig, SynthSymbol, synth};

const MIN: TimeMs = 60_000;

/// One engine input, in arrival order.
#[derive(Debug, Clone)]
enum Input {
    Command(Command),
    Market(MarketMsg),
}

fn with_ts(mut msg: MarketMsg, new_ts: TimeMs) -> MarketMsg {
    match &mut msg {
        MarketMsg::Trade { ts, .. }
        | MarketMsg::BookSnapshot { ts, .. }
        | MarketMsg::BookDelta { ts, .. } => *ts = new_ts,
    }
    msg
}

fn generated_fixture() -> impl Strategy<Value = Vec<FixtureLine>> {
    (
        any::<bool>(),
        vec((0..=5_000_i64, valid_market_msg()), 1..80),
    )
        .prop_map(|(ts_is_recv, steps)| {
            let mut recv = DEFAULT_START_MS;
            steps
                .into_iter()
                .map(|(gap, msg)| {
                    recv += gap;
                    let msg = if ts_is_recv { with_ts(msg, recv) } else { msg };
                    FixtureLine { recv, msg }
                })
                .collect()
        })
}

fn synth_fixture() -> impl Strategy<Value = Vec<FixtureLine>> {
    (
        any::<u64>(),
        0..=3 * MIN,
        subsequence(SynthSymbol::ALL.to_vec(), 1..=SynthSymbol::ALL.len()),
    )
        .prop_map(|(seed, duration_ms, symbols)| {
            synth(&SynthConfig {
                seed,
                duration_ms,
                start_ms: DEFAULT_START_MS,
                symbols,
            })
        })
}

fn fixture() -> impl Strategy<Value = Vec<FixtureLine>> {
    prop_oneof![generated_fixture(), synth_fixture()]
}

fn timeframe() -> impl Strategy<Value = Timeframe> + Clone {
    select(Timeframe::ALL.to_vec())
}

fn command() -> impl Strategy<Value = Command> {
    prop_oneof![
        2 => (known_symbol(), timeframe())
            .prop_map(|(symbol, timeframe)| Command::Subscribe { symbol, timeframe }),
        1 => (known_symbol(), timeframe())
            .prop_map(|(symbol, timeframe)| Command::Unsubscribe { symbol, timeframe }),
    ]
}

/// The fixture's messages with each Command inserted at its position, in list order.
fn merge(lines: &[FixtureLine], commands: &[(Index, Command)]) -> Vec<Input> {
    let mut inputs: Vec<Input> = lines
        .iter()
        .map(|line| Input::Market(line.msg.clone()))
        .collect();
    for (at, cmd) in commands {
        let index = at.index(inputs.len() + 1);
        inputs.insert(index, Input::Command(cmd.clone()));
    }
    inputs
}

/// Runs a fresh engine over `inputs` and returns every Event except Heartbeat.
fn run(inputs: &[Input]) -> Vec<Event> {
    let mut engine = Engine::new();
    let mut events = Vec::new();
    for input in inputs {
        events.extend(match input.clone() {
            Input::Command(cmd) => engine.on_command(cmd),
            Input::Market(msg) => engine.on_market(msg),
        });
    }
    events.retain(|event| !matches!(event, Event::Heartbeat { .. }));
    events
}

/// The first `n` lines the schedule releases at `speed`.
fn replayed(lines: &[FixtureLine], speed: u32, n: usize) -> Vec<FixtureLine> {
    ReplaySchedule::new(lines.to_vec(), speed)
        .unwrap()
        .take(n)
        .map(|scheduled| scheduled.line)
        .collect()
}

proptest! {
    // Property P7 — validates Req 6.6
    #[test]
    fn p7_same_fixture_and_commands_give_the_same_events(
        lines in fixture(),
        commands in vec((any::<Index>(), command()), 0..16),
    ) {
        let inputs = merge(&lines, &commands);
        let first = run(&inputs);
        let second = run(&inputs);
        prop_assert_eq!(&first, &second);

        let n = 2 * lines.len() + 1;
        let slow = replayed(&lines, 1, n);
        let fast = replayed(&lines, 50, n);
        prop_assert_eq!(&slow, &fast);
        prop_assert_eq!(slow.get(..lines.len()), Some(lines.as_slice()));
        prop_assert_eq!(run(&merge(&slow, &commands)), run(&merge(&fast, &commands)));
    }
}
