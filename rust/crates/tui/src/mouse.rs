//! Mouse decisions (Req 25.3, 35.2). Pure: a mouse event and the last frame's Hit_Map give an
//! optional action; `main.rs` applies it to the App.

use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
use protocol::Timeframe;

use crate::chart_model::Crosshair;
use crate::hitmap::{BookSide, HitMap, HitTarget, PanelId};
use crate::indicator_model::Indicator;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MouseAction {
    /// Left click on a watchlist row or strip segment: switch every panel to it (Req 27.4).
    SelectSymbol(String),
    /// Left click on a book price: select the level and prefill a limit ticket (Req 30.1).
    PrefillBookLevel {
        side: BookSide,
        index: usize,
    },
    /// Wheel up over the book: move the cursor one row up.
    BookCursorUp,
    /// Wheel down over the book: move the cursor one row down.
    BookCursorDown,
    ZoomIn,
    ZoomOut,
    /// Drag to the right: show older bars, by this many columns.
    PanBack(usize),
    /// Drag to the left: show newer bars, by this many columns.
    PanForward(usize),
    SelectTimeframe(Timeframe),
    /// Left click on an indicator toggle button (Req 26.3).
    ToggleIndicator(Indicator),
    /// Left click on the ✕ of an open order: cancel it (Req 30.3).
    CancelOrder(String),
    /// Left click on an open order row: select it and focus the orders panel.
    SelectOrder(String),
    /// Left click on the ticket's BUY or SELL button (Req 30.2).
    TicketBuy,
    TicketSell,
    /// Left click on the ticket quantity: type the quantity.
    FocusTicket,
    /// Left click on the command bar (Req 31.1).
    FocusCommand,
    /// Left click on the open orders panel.
    FocusOrders,
    /// Left click on a dialog button (Req 22.2, 22.3).
    DialogConfirm,
    DialogCancel,
    /// Crosshair position relative to the chart area.
    SetCrosshair(Crosshair),
    ClearCrosshair,
}

/// Tracks a left-button drag that started inside the chart.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DragState {
    /// The column of the last drag event, while a drag that began in the chart is active.
    last_col: Option<u16>,
}

/// Decides what a mouse event does. The chart rectangle is the one registered as
/// [`HitTarget::Chart`].
pub fn mouse_action(map: &HitMap, drag: &mut DragState, ev: MouseEvent) -> Option<MouseAction> {
    let hit = map.resolve_rect(ev.column, ev.row);
    let in_chart = matches!(hit, Some((_, HitTarget::Chart)));
    let in_book = matches!(
        hit,
        Some((
            _,
            HitTarget::BookLevel { .. } | HitTarget::Panel(PanelId::Book)
        ))
    );
    match ev.kind {
        MouseEventKind::ScrollUp if in_chart => Some(MouseAction::ZoomIn),
        MouseEventKind::ScrollDown if in_chart => Some(MouseAction::ZoomOut),
        MouseEventKind::ScrollUp if in_book => Some(MouseAction::BookCursorUp),
        MouseEventKind::ScrollDown if in_book => Some(MouseAction::BookCursorDown),
        MouseEventKind::Down(MouseButton::Left) => {
            drag.last_col = in_chart.then_some(ev.column);
            match hit {
                Some((_, HitTarget::BookLevel { side, index })) => {
                    Some(MouseAction::PrefillBookLevel {
                        side: *side,
                        index: *index,
                    })
                }
                Some((_, HitTarget::TimeframeButton(tf))) => {
                    Some(MouseAction::SelectTimeframe(*tf))
                }
                Some((_, HitTarget::IndicatorToggle(ind))) => {
                    Some(MouseAction::ToggleIndicator(*ind))
                }
                Some((_, HitTarget::WatchlistSymbol(symbol))) => {
                    Some(MouseAction::SelectSymbol(symbol.clone()))
                }
                Some((_, HitTarget::OpenOrder(id))) => Some(MouseAction::CancelOrder(id.clone())),
                Some((_, HitTarget::OrderRow(id))) => Some(MouseAction::SelectOrder(id.clone())),
                Some((_, HitTarget::TicketBuy)) => Some(MouseAction::TicketBuy),
                Some((_, HitTarget::TicketSell)) => Some(MouseAction::TicketSell),
                Some((_, HitTarget::TicketQty)) => Some(MouseAction::FocusTicket),
                Some((_, HitTarget::DialogConfirm)) => Some(MouseAction::DialogConfirm),
                Some((_, HitTarget::DialogCancel)) => Some(MouseAction::DialogCancel),
                Some((_, HitTarget::Panel(PanelId::Orders))) => Some(MouseAction::FocusOrders),
                Some((_, HitTarget::Panel(PanelId::CommandBar))) => Some(MouseAction::FocusCommand),
                _ => None,
            }
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            let last = drag.last_col?;
            drag.last_col = Some(ev.column);
            let delta = i32::from(ev.column) - i32::from(last);
            let cols = usize::try_from(delta.unsigned_abs()).unwrap_or(0);
            match delta {
                0 => None,
                d if d > 0 => Some(MouseAction::PanBack(cols)),
                _ => Some(MouseAction::PanForward(cols)),
            }
        }
        MouseEventKind::Up(MouseButton::Left) => {
            drag.last_col = None;
            None
        }
        MouseEventKind::Moved => match hit {
            Some((rect, HitTarget::Chart)) => Some(MouseAction::SetCrosshair(Crosshair {
                col: usize::from(ev.column - rect.x),
                row: usize::from(ev.row - rect.y),
            })),
            _ => Some(MouseAction::ClearCrosshair),
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyModifiers;
    use ratatui::layout::Rect;

    const TFS: [Timeframe; 5] = [
        Timeframe::M1,
        Timeframe::M5,
        Timeframe::M15,
        Timeframe::H1,
        Timeframe::D1,
    ];

    /// Buttons on row 0, 6 columns each; chart at (0, 1) 60x20.
    fn map() -> HitMap {
        let mut map = HitMap::new();
        for (i, tf) in TFS.iter().enumerate() {
            let x = u16::try_from(i).unwrap() * 6;
            map.register(Rect::new(x, 0, 5, 1), HitTarget::TimeframeButton(*tf));
        }
        map.register(Rect::new(0, 1, 60, 20), HitTarget::Chart);
        map
    }

    fn ev(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
        MouseEvent {
            kind,
            column,
            row,
            modifiers: KeyModifiers::NONE,
        }
    }

    fn run(drag: &mut DragState, kind: MouseEventKind, x: u16, y: u16) -> Option<MouseAction> {
        mouse_action(&map(), drag, ev(kind, x, y))
    }

    #[test]
    fn wheel_over_the_chart_zooms() {
        let mut d = DragState::default();
        assert_eq!(
            run(&mut d, MouseEventKind::ScrollUp, 10, 5),
            Some(MouseAction::ZoomIn)
        );
        assert_eq!(
            run(&mut d, MouseEventKind::ScrollDown, 10, 5),
            Some(MouseAction::ZoomOut)
        );
        // Outside the chart the wheel does nothing.
        assert_eq!(run(&mut d, MouseEventKind::ScrollUp, 10, 40), None);
    }

    #[test]
    fn drag_pans_by_the_column_delta() {
        let mut d = DragState::default();
        let left = MouseButton::Left;
        assert_eq!(run(&mut d, MouseEventKind::Down(left), 20, 5), None);
        assert_eq!(
            run(&mut d, MouseEventKind::Drag(left), 25, 5),
            Some(MouseAction::PanBack(5))
        );
        assert_eq!(
            run(&mut d, MouseEventKind::Drag(left), 22, 6),
            Some(MouseAction::PanForward(3))
        );
        assert_eq!(run(&mut d, MouseEventKind::Drag(left), 22, 6), None);
        assert_eq!(run(&mut d, MouseEventKind::Up(left), 22, 6), None);
        // After release a stray drag event does nothing.
        assert_eq!(run(&mut d, MouseEventKind::Drag(left), 30, 6), None);
    }

    #[test]
    fn drag_started_outside_the_chart_is_ignored() {
        let mut d = DragState::default();
        let left = MouseButton::Left;
        assert_eq!(run(&mut d, MouseEventKind::Down(left), 20, 40), None);
        assert_eq!(run(&mut d, MouseEventKind::Drag(left), 30, 5), None);
        // A press on a timeframe button starts no pan either.
        run(&mut d, MouseEventKind::Down(left), 1, 0);
        assert_eq!(run(&mut d, MouseEventKind::Drag(left), 30, 5), None);
    }

    #[test]
    fn clicking_each_timeframe_button_selects_it() {
        let mut d = DragState::default();
        for (i, tf) in TFS.iter().enumerate() {
            let x = u16::try_from(i).unwrap() * 6 + 2;
            assert_eq!(
                run(&mut d, MouseEventKind::Down(MouseButton::Left), x, 0),
                Some(MouseAction::SelectTimeframe(*tf))
            );
        }
    }

    // Req 26.3
    #[test]
    fn clicking_an_indicator_toggle_toggles_it() {
        let mut map = map();
        map.register(
            Rect::new(30, 0, 5, 1),
            HitTarget::IndicatorToggle(Indicator::Rsi),
        );
        let mut d = DragState::default();
        let left = MouseEventKind::Down(MouseButton::Left);
        assert_eq!(
            mouse_action(&map, &mut d, ev(left, 32, 0)),
            Some(MouseAction::ToggleIndicator(Indicator::Rsi))
        );
        // It starts no pan, and a right click does nothing.
        assert_eq!(
            mouse_action(
                &map,
                &mut d,
                ev(MouseEventKind::Drag(MouseButton::Left), 40, 5)
            ),
            None
        );
        assert_eq!(
            mouse_action(
                &map,
                &mut d,
                ev(MouseEventKind::Down(MouseButton::Right), 32, 0)
            ),
            None
        );
    }

    #[test]
    fn clicking_elsewhere_does_nothing() {
        let mut d = DragState::default();
        let left = MouseButton::Left;
        // The gap between buttons, the chart, and empty space.
        assert_eq!(run(&mut d, MouseEventKind::Down(left), 5, 0), None);
        assert_eq!(run(&mut d, MouseEventKind::Down(left), 10, 5), None);
        assert_eq!(run(&mut d, MouseEventKind::Down(left), 100, 30), None);
        // Right clicks do nothing.
        assert_eq!(
            run(&mut d, MouseEventKind::Down(MouseButton::Right), 1, 0),
            None
        );
    }

    /// The chart map plus a book panel at x 70..110 with two level rows.
    fn book_map() -> HitMap {
        let mut map = map();
        map.register(Rect::new(70, 0, 40, 10), HitTarget::Panel(PanelId::Book));
        map.register(
            Rect::new(71, 1, 38, 1),
            HitTarget::BookLevel {
                side: BookSide::Ask,
                index: 0,
            },
        );
        map.register(
            Rect::new(71, 3, 38, 1),
            HitTarget::BookLevel {
                side: BookSide::Bid,
                index: 1,
            },
        );
        map
    }

    // Req 30.1
    #[test]
    fn clicking_a_book_level_prefills_it() {
        let map = book_map();
        let mut d = DragState::default();
        let click = |d: &mut DragState, x, y| {
            mouse_action(&map, d, ev(MouseEventKind::Down(MouseButton::Left), x, y))
        };
        assert_eq!(
            click(&mut d, 80, 1),
            Some(MouseAction::PrefillBookLevel {
                side: BookSide::Ask,
                index: 0
            })
        );
        assert_eq!(
            click(&mut d, 108, 3),
            Some(MouseAction::PrefillBookLevel {
                side: BookSide::Bid,
                index: 1
            })
        );
        // The spread row (no level) and the border do nothing.
        assert_eq!(click(&mut d, 80, 2), None);
        assert_eq!(click(&mut d, 70, 1), None);
        // A click on a level starts no chart pan.
        assert_eq!(
            mouse_action(
                &map,
                &mut d,
                ev(MouseEventKind::Drag(MouseButton::Left), 90, 1)
            ),
            None
        );
    }

    #[test]
    fn the_wheel_over_the_book_moves_the_cursor() {
        let map = book_map();
        let mut d = DragState::default();
        let wheel = |d: &mut DragState, kind, x, y| mouse_action(&map, d, ev(kind, x, y));
        assert_eq!(
            wheel(&mut d, MouseEventKind::ScrollUp, 80, 1),
            Some(MouseAction::BookCursorUp)
        );
        assert_eq!(
            wheel(&mut d, MouseEventKind::ScrollDown, 80, 2),
            Some(MouseAction::BookCursorDown)
        );
        assert_eq!(wheel(&mut d, MouseEventKind::ScrollDown, 80, 40), None);
        // The chart still zooms.
        assert_eq!(
            wheel(&mut d, MouseEventKind::ScrollUp, 10, 5),
            Some(MouseAction::ZoomIn)
        );
    }

    // Req 27.4
    #[test]
    fn clicking_a_watchlist_symbol_selects_it() {
        let mut map = map();
        map.register(
            Rect::new(70, 0, 30, 5),
            HitTarget::Panel(PanelId::Watchlist),
        );
        for (y, symbol) in [(1, "BTC-USD"), (2, "ETH-USD"), (3, "SOL-USD")] {
            map.register(
                Rect::new(71, y, 28, 1),
                HitTarget::WatchlistSymbol(symbol.to_owned()),
            );
        }
        let mut d = DragState::default();
        let left = MouseEventKind::Down(MouseButton::Left);
        assert_eq!(
            mouse_action(&map, &mut d, ev(left, 80, 2)),
            Some(MouseAction::SelectSymbol("ETH-USD".to_owned()))
        );
        assert_eq!(
            mouse_action(&map, &mut d, ev(left, 98, 3)),
            Some(MouseAction::SelectSymbol("SOL-USD".to_owned()))
        );
        // The border, a right click, and the wheel do nothing; the click starts no pan.
        assert_eq!(mouse_action(&map, &mut d, ev(left, 80, 0)), None);
        assert_eq!(
            mouse_action(
                &map,
                &mut d,
                ev(MouseEventKind::Down(MouseButton::Right), 80, 1)
            ),
            None
        );
        assert_eq!(
            mouse_action(&map, &mut d, ev(MouseEventKind::ScrollUp, 80, 1)),
            None
        );
        mouse_action(&map, &mut d, ev(left, 80, 1));
        assert_eq!(
            mouse_action(
                &map,
                &mut d,
                ev(MouseEventKind::Drag(MouseButton::Left), 90, 5)
            ),
            None
        );
    }

    #[test]
    fn moving_sets_and_clears_the_crosshair() {
        let mut d = DragState::default();
        assert_eq!(
            run(&mut d, MouseEventKind::Moved, 12, 4),
            Some(MouseAction::SetCrosshair(Crosshair { col: 12, row: 3 }))
        );
        assert_eq!(
            run(&mut d, MouseEventKind::Moved, 12, 0),
            Some(MouseAction::ClearCrosshair)
        );
        assert_eq!(
            run(&mut d, MouseEventKind::Moved, 90, 40),
            Some(MouseAction::ClearCrosshair)
        );
    }
}

#[cfg(test)]
mod order_click_tests {
    use super::*;
    use crossterm::event::KeyModifiers;
    use ratatui::layout::Rect;

    fn click(map: &HitMap, x: u16, y: u16) -> Option<MouseAction> {
        let event = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: x,
            row: y,
            modifiers: KeyModifiers::NONE,
        };
        mouse_action(map, &mut DragState::default(), event)
    }

    /// The orders panel at x 0..40 with one row at y 2 whose first three cells are the ✕.
    fn orders_map() -> HitMap {
        let mut map = HitMap::new();
        map.register(Rect::new(0, 0, 40, 6), HitTarget::Panel(PanelId::Orders));
        map.register(Rect::new(1, 2, 38, 1), HitTarget::OrderRow("o-1".into()));
        map.register(Rect::new(1, 2, 3, 1), HitTarget::OpenOrder("o-1".into()));
        map.register(
            Rect::new(0, 20, 60, 1),
            HitTarget::Panel(PanelId::CommandBar),
        );
        map.register(Rect::new(50, 8, 5, 1), HitTarget::TicketBuy);
        map.register(Rect::new(56, 8, 6, 1), HitTarget::TicketSell);
        map.register(Rect::new(40, 8, 8, 1), HitTarget::TicketQty);
        map.register(Rect::new(10, 12, 10, 1), HitTarget::DialogConfirm);
        map.register(Rect::new(22, 12, 10, 1), HitTarget::DialogCancel);
        map
    }

    // Req 30.3
    #[test]
    fn the_cross_cancels_and_the_rest_of_the_row_selects() {
        let map = orders_map();
        assert_eq!(
            click(&map, 2, 2),
            Some(MouseAction::CancelOrder("o-1".into()))
        );
        assert_eq!(
            click(&map, 20, 2),
            Some(MouseAction::SelectOrder("o-1".into()))
        );
        // The panel border and the empty rows focus the panel.
        assert_eq!(click(&map, 20, 4), Some(MouseAction::FocusOrders));
        assert_eq!(click(&map, 0, 2), Some(MouseAction::FocusOrders));
    }

    // Req 30.2, 31.1, 22.2, 22.3
    #[test]
    fn ticket_buttons_the_command_bar_and_dialog_buttons_are_clickable() {
        let map = orders_map();
        assert_eq!(click(&map, 51, 8), Some(MouseAction::TicketBuy));
        assert_eq!(click(&map, 57, 8), Some(MouseAction::TicketSell));
        assert_eq!(click(&map, 41, 8), Some(MouseAction::FocusTicket));
        assert_eq!(click(&map, 30, 20), Some(MouseAction::FocusCommand));
        assert_eq!(click(&map, 12, 12), Some(MouseAction::DialogConfirm));
        assert_eq!(click(&map, 25, 12), Some(MouseAction::DialogCancel));
        // A right click does nothing.
        let event = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Right),
            column: 2,
            row: 2,
            modifiers: KeyModifiers::NONE,
        };
        assert_eq!(mouse_action(&map, &mut DragState::default(), event), None);
    }
}
