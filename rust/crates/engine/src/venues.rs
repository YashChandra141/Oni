//! Venue status table and Reference_Venue selection (oni-terminal-v2 task 6.2, Req 9.6, 9.9,
//! 9.11, 15.7). Pure: statuses and times arrive as messages, nothing here reads a clock.

use std::collections::{BTreeMap, BTreeSet};

use protocol::{INSTRUMENTS, Venue, VenueStatusKind, instrument};

/// Reference_Venue priority (design D7): the first connected venue in this order that lists
/// the symbol.
pub const REFERENCE_ORDER: [Venue; 5] = [
    Venue::Backpack,
    Venue::Coinbase,
    Venue::Raydium,
    Venue::Jupiter,
    Venue::Replay,
];

/// A CEX pair is stale after this much silence, in ms (Req 9.7).
pub const CEX_STALE_MS: i64 = 15_000;
/// A DEX pair is stale after this much silence, in ms (Req 9.7).
pub const DEX_STALE_MS: i64 = 20_000;

/// Default `--dex-max-deviation-pct`: the largest DEX divergence from the CEX Mark (Req 14.6).
pub const DEX_MAX_DEVIATION_PCT: i64 = 5;

/// True when `|dex - cex| * 100 > cex * max_pct` (i128 math). A non-positive `cex` never
/// diverges.
pub fn diverges(dex: i64, cex: i64, max_pct: i64) -> bool {
    if cex <= 0 {
        return false;
    }
    let diff = (i128::from(dex) - i128::from(cex)).abs();
    diff * 100 > i128::from(cex) * i128::from(max_pct)
}

/// Whether `venue` lists `symbol`. Replay serves every known symbol (Req 9.5).
pub fn lists(venue: Venue, symbol: &str) -> bool {
    match instrument(symbol) {
        Some(inst) => venue == Venue::Replay || inst.venues.contains(&venue),
        None => false,
    }
}

/// The Reference_Venue of `symbol` for the given statuses: the first venue in
/// [`REFERENCE_ORDER`] that is `connected` and lists the symbol, or `None`.
pub fn reference_venue(symbol: &str, statuses: &BTreeMap<Venue, VenueStatusKind>) -> Option<Venue> {
    REFERENCE_ORDER.into_iter().find(|venue| {
        statuses.get(venue) == Some(&VenueStatusKind::Connected) && lists(*venue, symbol)
    })
}

/// Venue statuses, the cached Reference_Venue of each symbol, and the stale pairs.
#[derive(Debug, Clone)]
pub struct VenueTable {
    statuses: BTreeMap<Venue, VenueStatusKind>,
    reference: BTreeMap<&'static str, Option<Venue>>,
    stale_pairs: BTreeSet<(Venue, String)>,
    suspect_pairs: BTreeSet<(Venue, String)>,
}

impl Default for VenueTable {
    /// Replay mode: only the `replay` venue exists, and it is connected.
    fn default() -> Self {
        let mut table = Self {
            statuses: BTreeMap::from([(Venue::Replay, VenueStatusKind::Connected)]),
            reference: BTreeMap::new(),
            stale_pairs: BTreeSet::new(),
            suspect_pairs: BTreeSet::new(),
        };
        table.refresh_references();
        table
    }
}

impl VenueTable {
    /// The table of an engine whose market venue is `venue`. A live venue starts `connecting`
    /// and `replay` is `disabled`.
    pub fn with_market_venue(venue: Venue) -> Self {
        let mut table = Self::default();
        if venue != Venue::Replay {
            table
                .statuses
                .insert(Venue::Replay, VenueStatusKind::Disabled);
            table.statuses.insert(venue, VenueStatusKind::Connecting);
            table.refresh_references();
        }
        table
    }

    pub fn status(&self, venue: Venue) -> Option<VenueStatusKind> {
        self.statuses.get(&venue).copied()
    }

    /// Sets a status. Returns true when it changed.
    pub fn set_status(&mut self, venue: Venue, status: VenueStatusKind) -> bool {
        self.statuses.insert(venue, status) != Some(status)
    }

    /// The cached Reference_Venue of `symbol`.
    pub fn reference(&self, symbol: &str) -> Option<Venue> {
        self.reference.get(symbol).copied().flatten()
    }

    /// Recomputes every symbol's Reference_Venue and returns the symbols that changed.
    pub fn refresh_references(&mut self) -> Vec<(&'static str, Option<Venue>)> {
        let mut changed = Vec::new();
        for inst in INSTRUMENTS.iter() {
            let new = reference_venue(inst.symbol, &self.statuses);
            if self.reference.insert(inst.symbol, new) != Some(new) {
                changed.push((inst.symbol, new));
            }
        }
        changed
    }

    /// Marks the pair stale. Returns true when it was not stale before.
    pub fn mark_stale(&mut self, venue: Venue, symbol: &str) -> bool {
        self.stale_pairs.insert((venue, symbol.to_owned()))
    }

    /// Clears the pair's stale mark. Returns true when it was stale.
    pub fn clear_stale(&mut self, venue: Venue, symbol: &str) -> bool {
        self.stale_pairs.remove(&(venue, symbol.to_owned()))
    }

    pub fn is_stale(&self, venue: Venue, symbol: &str) -> bool {
        self.stale_pairs.contains(&(venue, symbol.to_owned()))
    }

    /// Sets the pair's suspect mark. Returns true when it changed.
    pub fn set_suspect(&mut self, venue: Venue, symbol: &str, suspect: bool) -> bool {
        let key = (venue, symbol.to_owned());
        if suspect {
            self.suspect_pairs.insert(key)
        } else {
            self.suspect_pairs.remove(&key)
        }
    }

    pub fn is_suspect(&self, venue: Venue, symbol: &str) -> bool {
        self.suspect_pairs.contains(&(venue, symbol.to_owned()))
    }

    /// "N of M connected": venues that are `connected` over venues that are not `disabled`,
    /// `replay` excluded.
    #[allow(dead_code)]
    pub fn connected_of_total(&self) -> (usize, usize) {
        let live = self
            .statuses
            .iter()
            .filter(|(v, s)| **v != Venue::Replay && **s != VenueStatusKind::Disabled);
        let total = live.clone().count();
        let up = live
            .filter(|(_, s)| **s == VenueStatusKind::Connected)
            .count();
        (up, total)
    }
}
