//! The Hit_Map: rectangles recorded at draw time and used to resolve mouse positions to a
//! panel or item (Req 35.1-35.3).
//!
//! Pure: no I/O and no App state. The map is rebuilt on every frame. Entries registered later
//! sit on top of earlier ones, so a child registered after its parent panel wins.

// Several targets are only produced by panels added in later tasks.
#![allow(dead_code)]

use protocol::Timeframe;
use ratatui::layout::Rect;

use crate::indicator_model::Indicator;

/// The main screen areas.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PanelId {
    Status,
    Chart,
    Watchlist,
    Book,
    Tape,
    Positions,
    Orders,
    CommandBar,
}

/// Which side of the order book a level is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BookSide {
    Bid,
    Ask,
}

/// What a rectangle stands for: a panel, or an item inside a panel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HitTarget {
    Panel(PanelId),
    /// The plot area of the candle chart (zoom, pan, crosshair).
    Chart,
    /// A timeframe button above the chart (Req 25.3).
    TimeframeButton(Timeframe),
    /// An indicator toggle button next to the timeframe buttons (Req 26.3, Task 9.3).
    IndicatorToggle(Indicator),
    /// A watchlist row (wide layout) or strip segment (narrow layout), by symbol (Req 27.4).
    WatchlistSymbol(String),
    // NOTE: `OpenOrder` is registered by the orders panel in a later task (12.x).
    BookLevel { side: BookSide, index: usize },
    OpenOrder(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HitMap {
    entries: Vec<(Rect, HitTarget)>,
}

fn is_empty_rect(rect: Rect) -> bool {
    rect.width == 0 || rect.height == 0
}

/// Half-open containment: the right and bottom edges are outside. Computed in `u32`, so
/// rectangles at the edge of the `u16` space do not overflow.
fn contains(rect: Rect, x: u16, y: u16) -> bool {
    let (x, y) = (u32::from(x), u32::from(y));
    let (rx, ry) = (u32::from(rect.x), u32::from(rect.y));
    x >= rx
        && x < rx + u32::from(rect.width)
        && y >= ry
        && y < ry + u32::from(rect.height)
}

impl HitMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drops every entry. Called at the start of each frame.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Records a rectangle. Empty rectangles are skipped.
    pub fn register(&mut self, rect: Rect, target: HitTarget) {
        if !is_empty_rect(rect) {
            self.entries.push((rect, target));
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The last-registered entry whose rectangle contains `(x, y)`.
    pub fn resolve_rect(&self, x: u16, y: u16) -> Option<(Rect, &HitTarget)> {
        self.entries
            .iter()
            .rev()
            .find(|(rect, _)| contains(*rect, x, y))
            .map(|(rect, target)| (*rect, target))
    }

    /// The target at `(x, y)`; children registered after their parents win.
    pub fn resolve(&self, x: u16, y: u16) -> Option<&HitTarget> {
        self.resolve_rect(x, y).map(|(_, target)| target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn panel(id: PanelId) -> HitTarget {
        HitTarget::Panel(id)
    }

    #[test]
    fn child_registered_later_wins_over_parent() {
        let mut map = HitMap::new();
        map.register(Rect::new(0, 0, 40, 20), panel(PanelId::Chart));
        map.register(Rect::new(5, 5, 10, 1), HitTarget::TimeframeButton(Timeframe::M5));
        assert_eq!(
            map.resolve(6, 5),
            Some(&HitTarget::TimeframeButton(Timeframe::M5))
        );
        assert_eq!(map.resolve(6, 6), Some(&panel(PanelId::Chart)));
        assert_eq!(map.resolve(50, 6), None);
    }

    #[test]
    fn non_overlapping_rects_resolve_separately() {
        let mut map = HitMap::new();
        map.register(Rect::new(0, 0, 10, 10), panel(PanelId::Chart));
        map.register(Rect::new(10, 0, 10, 10), panel(PanelId::Book));
        assert_eq!(map.resolve(9, 0), Some(&panel(PanelId::Chart)));
        assert_eq!(map.resolve(10, 0), Some(&panel(PanelId::Book)));
    }

    #[test]
    fn right_and_bottom_edges_are_exclusive() {
        let mut map = HitMap::new();
        map.register(Rect::new(2, 3, 4, 5), panel(PanelId::Tape));
        assert!(map.resolve(2, 3).is_some());
        assert!(map.resolve(5, 7).is_some());
        assert!(map.resolve(6, 3).is_none());
        assert!(map.resolve(2, 8).is_none());
        assert!(map.resolve(1, 3).is_none());
        assert!(map.resolve(2, 2).is_none());
    }

    #[test]
    fn empty_rects_are_skipped() {
        let mut map = HitMap::new();
        map.register(Rect::new(0, 0, 0, 5), panel(PanelId::Status));
        map.register(Rect::new(0, 0, 5, 0), panel(PanelId::Status));
        assert!(map.is_empty());
        assert_eq!(map.resolve(0, 0), None);
    }

    #[test]
    fn clear_removes_everything() {
        let mut map = HitMap::new();
        map.register(Rect::new(0, 0, 5, 5), HitTarget::Chart);
        assert_eq!(map.len(), 1);
        map.clear();
        assert!(map.is_empty());
        assert_eq!(map.resolve(1, 1), None);
    }

    #[test]
    fn resolve_rect_returns_the_matching_rect() {
        let mut map = HitMap::new();
        let rect = Rect::new(1, 1, 3, 3);
        map.register(rect, HitTarget::Chart);
        assert_eq!(map.resolve_rect(2, 2), Some((rect, &HitTarget::Chart)));
    }

    fn arb_rect() -> impl Strategy<Value = Rect> {
        (0u16..200, 0u16..60, 0u16..=200, 0u16..=60).prop_map(|(x, y, w, h)| {
            Rect::new(x, y, w.min(200 - x), h.min(60 - y))
        })
    }

    proptest! {
        // Property P23 — validates Req 35.3
        #[test]
        fn resolve_matches_the_last_containing_rect(
            rects in proptest::collection::vec(arb_rect(), 0..24),
            points in proptest::collection::vec((0u16..200, 0u16..60), 1..16),
        ) {
            let mut map = HitMap::new();
            // Each entry gets a unique target so the result identifies the entry.
            for (i, rect) in rects.iter().enumerate() {
                map.register(
                    *rect,
                    HitTarget::BookLevel { side: BookSide::Bid, index: i },
                );
            }
            for (x, y) in points {
                let model = rects
                    .iter()
                    .enumerate()
                    .filter(|(_, r)| {
                        r.width > 0
                            && r.height > 0
                            && x >= r.x
                            && x < r.x + r.width
                            && y >= r.y
                            && y < r.y + r.height
                    })
                    .next_back()
                    .map(|(i, _)| i);
                match map.resolve_rect(x, y) {
                    Some((rect, target)) => {
                        prop_assert!(x >= rect.x && x < rect.x + rect.width);
                        prop_assert!(y >= rect.y && y < rect.y + rect.height);
                        let expected = model.map(|index| HitTarget::BookLevel {
                            side: BookSide::Bid,
                            index,
                        });
                        prop_assert_eq!(Some(target.clone()), expected);
                        prop_assert_eq!(map.resolve(x, y), Some(target));
                    }
                    None => {
                        prop_assert!(model.is_none());
                        prop_assert!(map.resolve(x, y).is_none());
                    }
                }
            }
        }
    }
}
