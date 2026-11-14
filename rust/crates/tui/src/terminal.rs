//! Terminal guard and panic hook (Req 36.3, 36.4).
//!
//! Entering turns on raw mode, the alternate screen, and mouse capture.
//! Restoring undoes them in reverse order and also shows the cursor, which
//! ratatui hides while drawing. Restoring runs at most once per entry: a shared
//! "active" flag is swapped to `false` by whichever of `Drop` or the panic hook
//! gets there first, and every step is attempted even if an earlier one fails.
//! No step panics; errors are ignored because there is nowhere useful to report
//! them while the terminal is in an unknown state.

use std::io;
use std::panic;
use std::sync::Once;
use std::sync::atomic::{AtomicBool, Ordering};

use crossterm::cursor::Show;
use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};

/// The terminal operations the guard performs, injectable for tests.
pub trait TerminalOps {
    fn enable_raw_mode(&mut self) -> io::Result<()>;
    fn enter_alternate_screen(&mut self) -> io::Result<()>;
    fn enable_mouse_capture(&mut self) -> io::Result<()>;
    fn disable_mouse_capture(&mut self) -> io::Result<()>;
    fn leave_alternate_screen(&mut self) -> io::Result<()>;
    fn show_cursor(&mut self) -> io::Result<()>;
    fn disable_raw_mode(&mut self) -> io::Result<()>;
}

/// The real operations, through crossterm on stdout.
pub struct CrosstermOps;

impl TerminalOps for CrosstermOps {
    fn enable_raw_mode(&mut self) -> io::Result<()> {
        enable_raw_mode()
    }
    fn enter_alternate_screen(&mut self) -> io::Result<()> {
        execute!(io::stdout(), EnterAlternateScreen)
    }
    fn enable_mouse_capture(&mut self) -> io::Result<()> {
        execute!(io::stdout(), EnableMouseCapture)
    }
    fn disable_mouse_capture(&mut self) -> io::Result<()> {
        execute!(io::stdout(), DisableMouseCapture)
    }
    fn leave_alternate_screen(&mut self) -> io::Result<()> {
        execute!(io::stdout(), LeaveAlternateScreen)
    }
    fn show_cursor(&mut self) -> io::Result<()> {
        execute!(io::stdout(), Show)
    }
    fn disable_raw_mode(&mut self) -> io::Result<()> {
        disable_raw_mode()
    }
}

/// Whether the real terminal is currently in TUI mode. Shared by the guard and
/// the panic hook so the terminal is restored exactly once.
static TERMINAL_ACTIVE: AtomicBool = AtomicBool::new(false);
static PANIC_HOOK: Once = Once::new();

/// Restores the terminal if `active` is set, clearing it first. Returns whether
/// the restore steps ran. Every step runs even if an earlier one fails.
pub fn restore_once<O: TerminalOps + ?Sized>(active: &AtomicBool, ops: &mut O) -> bool {
    if !active.swap(false, Ordering::SeqCst) {
        return false;
    }
    let _ = ops.disable_mouse_capture();
    let _ = ops.leave_alternate_screen();
    let _ = ops.show_cursor();
    let _ = ops.disable_raw_mode();
    true
}

/// Installs a panic hook that restores the terminal (through `make_ops`) and
/// then calls the hook that was installed before it, so the panic message is
/// printed on the normal screen (Req 36.4).
pub fn install_panic_hook_with<O, F>(active: &'static AtomicBool, make_ops: F)
where
    O: TerminalOps,
    F: Fn() -> O + Send + Sync + 'static,
{
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let mut ops = make_ops();
        restore_once(active, &mut ops);
        previous(info);
    }));
}

/// Installs the real panic hook once per process.
fn install_panic_hook() {
    PANIC_HOOK.call_once(|| install_panic_hook_with(&TERMINAL_ACTIVE, || CrosstermOps));
}

/// Holds the terminal in TUI mode; restores it on drop (Req 36.3).
pub struct TerminalGuard<O: TerminalOps = CrosstermOps> {
    ops: O,
    active: &'static AtomicBool,
}

impl TerminalGuard<CrosstermOps> {
    /// Installs the panic hook and puts the real terminal into TUI mode.
    pub fn enter() -> io::Result<Self> {
        install_panic_hook();
        Self::enter_with(CrosstermOps, &TERMINAL_ACTIVE)
    }
}

impl<O: TerminalOps> TerminalGuard<O> {
    /// Enters TUI mode with `ops`. If a step fails, the guard is dropped and
    /// whatever was already turned on is restored before the error returns.
    pub fn enter_with(ops: O, active: &'static AtomicBool) -> io::Result<Self> {
        // Set before the first step so a panic part-way through still restores.
        active.store(true, Ordering::SeqCst);
        let mut guard = Self { ops, active };
        guard.ops.enable_raw_mode()?;
        guard.ops.enter_alternate_screen()?;
        guard.ops.enable_mouse_capture()?;
        Ok(guard)
    }
}

impl<O: TerminalOps> Drop for TerminalGuard<O> {
    fn drop(&mut self) {
        restore_once(self.active, &mut self.ops);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    type Log = Arc<Mutex<Vec<&'static str>>>;

    struct FakeOps {
        log: Log,
        fail_on: Option<&'static str>,
    }

    impl FakeOps {
        fn new(log: &Log) -> Self {
            Self {
                log: Arc::clone(log),
                fail_on: None,
            }
        }
        fn failing(log: &Log, step: &'static str) -> Self {
            Self {
                log: Arc::clone(log),
                fail_on: Some(step),
            }
        }
        fn step(&mut self, name: &'static str) -> io::Result<()> {
            self.log.lock().unwrap().push(name);
            if self.fail_on == Some(name) {
                Err(io::Error::other(name))
            } else {
                Ok(())
            }
        }
    }

    impl TerminalOps for FakeOps {
        fn enable_raw_mode(&mut self) -> io::Result<()> {
            self.step("raw_on")
        }
        fn enter_alternate_screen(&mut self) -> io::Result<()> {
            self.step("alt_on")
        }
        fn enable_mouse_capture(&mut self) -> io::Result<()> {
            self.step("mouse_on")
        }
        fn disable_mouse_capture(&mut self) -> io::Result<()> {
            self.step("mouse_off")
        }
        fn leave_alternate_screen(&mut self) -> io::Result<()> {
            self.step("alt_off")
        }
        fn show_cursor(&mut self) -> io::Result<()> {
            self.step("cursor_on")
        }
        fn disable_raw_mode(&mut self) -> io::Result<()> {
            self.step("raw_off")
        }
    }

    const ENTER: [&str; 3] = ["raw_on", "alt_on", "mouse_on"];
    const RESTORE: [&str; 4] = ["mouse_off", "alt_off", "cursor_on", "raw_off"];

    fn new_log() -> Log {
        Arc::new(Mutex::new(Vec::new()))
    }

    fn flag(value: bool) -> &'static AtomicBool {
        Box::leak(Box::new(AtomicBool::new(value)))
    }

    fn entries(log: &Log) -> Vec<&'static str> {
        log.lock().unwrap().clone()
    }

    #[test]
    fn restore_runs_in_reverse_order_and_only_once() {
        let log = new_log();
        let active = flag(true);
        let mut ops = FakeOps::new(&log);
        assert!(restore_once(active, &mut ops));
        assert!(!restore_once(active, &mut ops));
        assert_eq!(entries(&log), RESTORE);
        assert!(!active.load(Ordering::SeqCst));
    }

    #[test]
    fn restore_is_a_no_op_when_inactive() {
        let log = new_log();
        assert!(!restore_once(flag(false), &mut FakeOps::new(&log)));
        assert!(entries(&log).is_empty());
    }

    #[test]
    fn restore_attempts_every_step_even_after_a_failure() {
        let log = new_log();
        let mut ops = FakeOps::failing(&log, "mouse_off");
        assert!(restore_once(flag(true), &mut ops));
        assert_eq!(entries(&log), RESTORE);
    }

    // Req 36.3
    #[test]
    fn guard_enters_then_restores_on_drop() {
        let log = new_log();
        let active = flag(false);
        let guard = TerminalGuard::enter_with(FakeOps::new(&log), active).unwrap();
        assert!(active.load(Ordering::SeqCst));
        assert_eq!(entries(&log), ENTER);
        drop(guard);
        let mut expected = ENTER.to_vec();
        expected.extend(RESTORE);
        assert_eq!(entries(&log), expected);
        assert!(!active.load(Ordering::SeqCst));
    }

    #[test]
    fn guard_drop_after_earlier_restore_does_nothing() {
        let log = new_log();
        let active = flag(false);
        let guard = TerminalGuard::enter_with(FakeOps::new(&log), active).unwrap();
        // As if the panic hook had already restored the terminal.
        assert!(restore_once(active, &mut FakeOps::new(&log)));
        drop(guard);
        let mut expected = ENTER.to_vec();
        expected.extend(RESTORE);
        assert_eq!(entries(&log), expected);
    }

    #[test]
    fn failed_enter_restores_what_was_turned_on() {
        let log = new_log();
        let active = flag(false);
        let result = TerminalGuard::enter_with(FakeOps::failing(&log, "alt_on"), active);
        assert!(result.is_err());
        let mut expected = vec!["raw_on", "alt_on"];
        expected.extend(RESTORE);
        assert_eq!(entries(&log), expected);
        assert!(!active.load(Ordering::SeqCst));
    }

    // Req 36.4: the terminal is restored before the previous hook prints.
    #[test]
    fn panic_hook_restores_before_previous_hook() {
        let log = new_log();
        let active = flag(true);
        let original = panic::take_hook();
        let prev_log = Arc::clone(&log);
        panic::set_hook(Box::new(move |_| {
            if let Ok(mut entries) = prev_log.lock() {
                entries.push("previous_hook");
            }
        }));
        let hook_log = Arc::clone(&log);
        install_panic_hook_with(active, move || FakeOps::new(&hook_log));

        let result = panic::catch_unwind(|| panic!("boom"));

        let _ = panic::take_hook();
        panic::set_hook(original);

        assert!(result.is_err());
        let mut expected = RESTORE.to_vec();
        expected.push("previous_hook");
        assert_eq!(entries(&log), expected);
        assert!(!active.load(Ordering::SeqCst));
    }
}
