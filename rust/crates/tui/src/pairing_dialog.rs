//! The pairing dialog: a centered box over the screen (Task 21.2, Req 48.1, 48.3).
//!
//! It shows the code as `XXXX-XXXX`, the link to open in the Web_UI, the time left, and what to
//! do next. The text comes from [`dialog_lines`], so tests can check it without a terminal.

use ratatui::Frame;
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, Clear, Paragraph, Wrap};

use crate::pairing::{EXPIRED_TEXT, PairingState, format_code, format_countdown};

/// The hint under the code (Req 48.1).
pub const HINT: &str = "Open the link, sign in with your wallet, and confirm this code";
/// Dialog box size, before it is cut to fit the terminal.
const WIDTH: u16 = 70;
const HEIGHT: u16 = 13;
/// Longest failure text shown, in characters.
const MAX_FAILURE_CHARS: usize = 120;

/// The dialog text for `state`, or `None` when no dialog is shown.
pub fn dialog_lines(state: &PairingState) -> Option<Vec<Line<'static>>> {
    let code_style = Style::new()
        .fg(Color::Yellow)
        .add_modifier(Modifier::BOLD);
    let link_style = Style::new().fg(Color::Cyan);
    match state {
        PairingState::Idle | PairingState::Done { .. } => None,
        PairingState::Requesting => Some(vec![
            Line::from(""),
            Line::from("Requesting a pairing code…"),
            Line::from(""),
            Line::from("Esc to cancel"),
        ]),
        PairingState::Showing {
            code,
            url,
            remaining_secs,
            ..
        } => Some(vec![
            Line::from("Your pairing code"),
            Line::styled(format_code(code), code_style),
            Line::from(""),
            Line::from("Open this link:"),
            Line::styled(url.clone(), link_style),
            Line::from(""),
            Line::from(format!("Expires in {}", format_countdown(*remaining_secs))),
            Line::from(""),
            Line::from(HINT),
            Line::from(""),
            Line::from("Esc to cancel"),
        ]),
        PairingState::Expired => Some(vec![
            Line::from(""),
            Line::styled(EXPIRED_TEXT, Style::new().fg(Color::Yellow)),
            Line::from(""),
            Line::from("Esc to close"),
        ]),
        PairingState::Failed(message) => {
            let shown: String = message.chars().take(MAX_FAILURE_CHARS).collect();
            Some(vec![
                Line::from(""),
                Line::styled(
                    format!("Pairing failed: {shown}"),
                    Style::new().fg(Color::Red),
                ),
                Line::from(""),
                Line::from("Press P to retry, Esc to close"),
            ])
        }
    }
}

/// The centered rectangle of the dialog inside `area`.
pub fn dialog_area(area: Rect) -> Rect {
    let width = WIDTH.min(area.width);
    let height = HEIGHT.min(area.height);
    Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    )
}

/// Draws the dialog over whatever is on screen, when there is one.
pub fn draw(frame: &mut Frame, state: &PairingState) {
    let Some(lines) = dialog_lines(state) else {
        return;
    };
    let area = dialog_area(frame.area());
    frame.render_widget(Clear, area);
    let block = Block::bordered().title(" Sign in with your wallet ");
    let paragraph = Paragraph::new(lines)
        .block(block)
        .alignment(Alignment::Center)
        .wrap(Wrap { trim: false });
    frame.render_widget(paragraph, area);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    fn showing(remaining_secs: u64) -> PairingState {
        PairingState::Showing {
            code: "ABCD2345".into(),
            url: "https://app.example.com/pair/?code=ABCD2345".into(),
            expires_at: 300_000,
            interval_ms: 2_000,
            next_poll: 2_000,
            remaining_secs,
        }
    }

    fn render(width: u16, height: u16, state: &PairingState) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|f| draw(f, state)).unwrap();
        let buffer = terminal.backend().buffer();
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buffer[(x, y)].symbol().to_owned())
                    .collect::<String>()
            })
            .collect()
    }

    // Req 48.1
    #[test]
    fn the_dialog_shows_code_link_countdown_and_hint() {
        let text = render(80, 24, &showing(272)).join("\n");
        assert!(text.contains("ABCD-2345"), "{text}");
        assert!(text.contains("https://app.example.com/pair/?code=ABCD2345"), "{text}");
        assert!(text.contains("Expires in 4:32"), "{text}");
        assert!(text.contains(HINT), "{text}");
        assert!(text.contains("Esc to cancel"), "{text}");
        assert!(text.contains("Sign in with your wallet"), "{text}");
    }

    #[test]
    fn the_countdown_updates_with_the_state() {
        assert!(render(80, 24, &showing(59)).join("\n").contains("Expires in 0:59"));
        assert!(render(80, 24, &showing(300)).join("\n").contains("Expires in 5:00"));
    }

    // Req 48.3
    #[test]
    fn expired_and_failed_dialogs_say_how_to_retry() {
        let expired = render(80, 24, &PairingState::Expired).join("\n");
        assert!(expired.contains("Pairing expired, press P to retry"), "{expired}");
        let failed = render(80, 24, &PairingState::Failed("server unreachable".into())).join("\n");
        assert!(failed.contains("Pairing failed: server unreachable"), "{failed}");
        assert!(failed.contains("Press P to retry"), "{failed}");
        let requesting = render(80, 24, &PairingState::Requesting).join("\n");
        assert!(requesting.contains("Requesting a pairing code"), "{requesting}");
    }

    #[test]
    fn nothing_is_drawn_without_a_dialog() {
        for state in [PairingState::Idle, PairingState::Done { address: "A".into() }] {
            assert!(dialog_lines(&state).is_none());
            let rows = render(80, 24, &state);
            assert!(rows.iter().all(|row| row.trim().is_empty()), "{rows:?}");
        }
    }

    #[test]
    fn the_dialog_is_centered_and_fits_small_terminals() {
        let area = dialog_area(Rect::new(0, 0, 100, 40));
        assert_eq!((area.x, area.y, area.width, area.height), (15, 13, 70, 13));
        let small = dialog_area(Rect::new(0, 0, 30, 6));
        assert_eq!((small.x, small.y, small.width, small.height), (0, 0, 30, 6));
        // Drawing into a tiny terminal does not panic.
        render(10, 3, &showing(10));
    }

    #[test]
    fn the_dialog_covers_what_is_under_it() {
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal
            .draw(|f| {
                let filler = Paragraph::new(vec![Line::from("x".repeat(80)); 24]);
                f.render_widget(filler, f.area());
                draw(f, &showing(100));
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        let area = dialog_area(Rect::new(0, 0, 80, 24));
        let inside: String = (area.x + 1..area.x + area.width - 1)
            .map(|x| buffer[(x, area.y + 1)].symbol().to_owned())
            .collect();
        assert!(!inside.contains('x'), "{inside}");
    }
}
