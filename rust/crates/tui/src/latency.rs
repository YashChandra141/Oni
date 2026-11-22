//! The header latency readout (Task 16.10, Req 29.1, 29.2, 29.4, 29.6): a `ping` every 2 s,
//! and the median of the last 10 completed round trips, halved, in whole milliseconds.
//! Pure: the caller passes the clock.

use std::collections::VecDeque;

/// Time between pings.
pub const PING_EVERY_MS: i64 = 2_000;
/// Completed round trips the median covers.
const WINDOW: usize = 10;
/// Pings in flight that are remembered; older ones are forgotten.
const MAX_PENDING: usize = 8;
/// Ping ids start here so they never collide with the network task's keep-alive ids.
const ID_BASE: u64 = 1 << 40;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Latency {
    next_id: u64,
    last_sent_ms: Option<i64>,
    pending: VecDeque<(u64, i64)>,
    samples: VecDeque<u32>,
}

impl Latency {
    /// The id of a ping to send now, when 2 s have passed since the last one.
    pub fn due(&mut self, now_ms: i64) -> Option<u64> {
        if let Some(last) = self.last_sent_ms
            && now_ms.saturating_sub(last) < PING_EVERY_MS
        {
            return None;
        }
        let id = ID_BASE.saturating_add(self.next_id);
        self.next_id = self.next_id.wrapping_add(1);
        self.last_sent_ms = Some(now_ms);
        self.pending.push_back((id, now_ms));
        while self.pending.len() > MAX_PENDING {
            self.pending.pop_front();
        }
        Some(id)
    }

    /// Records the round trip of pong `id`. Returns the new median one-way latency in ms, or
    /// `None` for a pong that answers no pending ping.
    pub fn on_pong(&mut self, id: u64, now_ms: i64) -> Option<u32> {
        let index = self.pending.iter().position(|(pid, _)| *pid == id)?;
        let (_, sent) = self.pending.remove(index)?;
        let rtt = u64::try_from(now_ms.saturating_sub(sent).max(0)).unwrap_or(0);
        let half = u32::try_from(rtt.div_ceil(2)).unwrap_or(u32::MAX);
        self.samples.push_back(half);
        while self.samples.len() > WINDOW {
            self.samples.pop_front();
        }
        self.median()
    }

    /// The median of the stored samples (mean of the middle two when even).
    pub fn median(&self) -> Option<u32> {
        if self.samples.is_empty() {
            return None;
        }
        let mut sorted: Vec<u32> = self.samples.iter().copied().collect();
        sorted.sort_unstable();
        let mid = sorted.len() / 2;
        if sorted.len() % 2 == 1 {
            sorted.get(mid).copied()
        } else {
            let (a, b) = (*sorted.get(mid - 1)?, *sorted.get(mid)?);
            u32::try_from((u64::from(a) + u64::from(b)) / 2).ok()
        }
    }

    /// Forgets everything (the connection changed).
    pub fn reset(&mut self) {
        self.last_sent_ms = None;
        self.pending.clear();
        self.samples.clear();
    }
}
