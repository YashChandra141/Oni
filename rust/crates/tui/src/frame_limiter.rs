//! Redraw throttle (Req 34.3, 34.4): draw only when state changed, and at most once per
//! `min_interval` (33 ms, so at most 30 frames per second).
//!
//! Pure: the caller passes "now", so tests need no sleeping.

use std::time::{Duration, Instant};

/// Decides when the event loop may draw.
#[derive(Debug, Clone)]
pub struct FrameLimiter {
    min_interval: Duration,
    last_draw: Option<Instant>,
    dirty: bool,
}

impl FrameLimiter {
    /// A limiter that starts dirty, so the first frame is drawn at the first check.
    pub fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            last_draw: None,
            dirty: true,
        }
    }

    /// Records that the screen content changed (net event, key, mouse, resize, crosshair).
    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    /// True when a frame should be drawn now: the state is dirty and either nothing was drawn
    /// yet or at least `min_interval` has passed since the last draw.
    pub fn should_draw(&self, now: Instant) -> bool {
        if !self.dirty {
            return false;
        }
        match self.last_draw {
            None => true,
            Some(last) => now.saturating_duration_since(last) >= self.min_interval,
        }
    }

    /// Records that a frame was drawn at `now`: clears the dirty flag and starts a new interval.
    pub fn drew(&mut self, now: Instant) {
        self.dirty = false;
        self.last_draw = Some(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INTERVAL: Duration = Duration::from_millis(33);

    fn at(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn first_draw_is_immediate() {
        let base = Instant::now();
        let limiter = FrameLimiter::new(INTERVAL);
        assert!(limiter.should_draw(base));
    }

    #[test]
    fn no_draw_when_not_dirty() {
        let base = Instant::now();
        let mut limiter = FrameLimiter::new(INTERVAL);
        limiter.drew(base);
        for ms in 0..500 {
            assert!(!limiter.should_draw(at(base, ms)));
        }
    }

    #[test]
    fn dirty_inside_the_interval_draws_once_at_the_next_tick() {
        let base = Instant::now();
        let mut limiter = FrameLimiter::new(INTERVAL);
        limiter.drew(base);
        limiter.mark_dirty();
        assert!(!limiter.should_draw(at(base, 10)));
        assert!(!limiter.should_draw(at(base, 32)));
        assert!(limiter.should_draw(at(base, 33)));
        limiter.drew(at(base, 33));
        assert!(!limiter.should_draw(at(base, 66)));
    }

    #[test]
    fn resize_style_event_marks_dirty() {
        let base = Instant::now();
        let mut limiter = FrameLimiter::new(INTERVAL);
        limiter.drew(base);
        assert!(!limiter.should_draw(at(base, 100)));
        limiter.mark_dirty(); // what the loop does for Event::Resize
        assert!(limiter.should_draw(at(base, 100)));
    }

    #[test]
    fn constant_dirty_input_never_exceeds_30_draws_in_any_second() {
        let base = Instant::now();
        let mut limiter = FrameLimiter::new(INTERVAL);
        let mut draws: Vec<u64> = Vec::new();
        for ms in 0..5_000u64 {
            limiter.mark_dirty();
            let now = at(base, ms);
            if limiter.should_draw(now) {
                limiter.drew(now);
                draws.push(ms);
            }
        }
        assert!(draws.len() > 100, "should still draw regularly");
        for &start in &draws {
            let in_window = draws
                .iter()
                .filter(|&&d| d >= start && d < start + 1_000)
                .count();
            assert!(in_window <= 30, "{in_window} draws in one second");
        }
    }

    #[test]
    fn long_idle_does_not_build_a_burst() {
        let base = Instant::now();
        let mut limiter = FrameLimiter::new(INTERVAL);
        limiter.drew(base);
        // Ten idle seconds, checked every 33 ms: nothing to draw.
        for i in 1..300u64 {
            assert!(!limiter.should_draw(at(base, i * 33)));
        }
        // One change after the idle period gives exactly one draw.
        limiter.mark_dirty();
        let now = at(base, 10_000);
        assert!(limiter.should_draw(now));
        limiter.drew(now);
        assert!(!limiter.should_draw(at(base, 10_001)));
        assert!(!limiter.should_draw(at(base, 10_033)));
    }
}
